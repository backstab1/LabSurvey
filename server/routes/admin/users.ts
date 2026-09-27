// Только администратор: пользователи, журнал действий, резервные копии базы
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { hashPassword, isBuiltInLogin, requireAdminRole } from '../../auth.ts';
import { audit, projects, sql, users, type Role } from '../../db.ts';
import { backupPath, listBackups, makeBackup } from '../../backup.ts';
import { config } from '../../config.ts';
import { fail, found, isoDay, nextDayIso, sendDownload } from '../../http.ts';
import { MIN_PASSWORD } from './account.ts';
import type { BackupsInfo } from '../../../shared/api.ts';

const ROLES: Role[] = ['admin', 'editor', 'viewer', 'client'];
const ROLE_ERROR = 'Роль: admin, editor, viewer или client';
const PASSWORD_ERROR = 'Пароль — не короче 8 символов';
const PROJECTS_ERROR = 'projects: ожидается список ID проектов';

/** Проекты заказчика: только существующие; null — не список */
async function cleanProjects(raw: unknown): Promise<string[] | null> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const id of raw) if (typeof id === 'string' && !out.includes(id) && (await projects.get(id))) out.push(id);
  return out;
}

export async function usersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdminRole);

  app.get('/api/admin/users', async () => users.list());

  app.post<{ Body: { login: string; password: string; role: Role; projects?: string[] } }>('/api/admin/users', async (req) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const role = req.body?.role;
    if (!/^[\w.@-]{2,50}$/.test(login)) fail(400, 'Логин: 2–50 символов, латиница, цифры, _ . @ -');
    if (isBuiltInLogin(login) || (await users.get(login))) fail(400, 'Такой логин уже есть');
    if (password.length < MIN_PASSWORD) fail(400, PASSWORD_ERROR);
    if (!ROLES.includes(role)) fail(400, ROLE_ERROR);
    const list = await cleanProjects(req.body?.projects);
    if (!list) fail(400, PROJECTS_ERROR);
    await users.create(login, hashPassword(password), role);
    if (list.length) await users.update(login, { projects: list });
    return { ok: true };
  });

  app.put<{ Params: { login: string }; Body: { role?: Role; password?: string; disabled?: boolean; projects?: string[] } }>('/api/admin/users/:login', async (req) => {
    const u = found(await users.get(req.params.login), 'Пользователь не найден');
    const b = req.body ?? {};
    if (b.role !== undefined && !ROLES.includes(b.role)) fail(400, ROLE_ERROR);
    const list = b.projects === undefined ? undefined : await cleanProjects(b.projects);
    if (list === null) fail(400, PROJECTS_ERROR);
    if (b.password !== undefined && String(b.password).length < MIN_PASSWORD) fail(400, PASSWORD_ERROR);
    if (u.login === req.user!.login && (b.disabled || (b.role && b.role !== 'admin'))) {
      fail(400, 'Нельзя отключить себя или снять с себя права администратора');
    }
    await users.update(u.login, {
      role: b.role, disabled: b.disabled, passwordHash: b.password !== undefined ? hashPassword(String(b.password)) : undefined,
      projects: list,
    });
    return { ok: true };
  });

  app.delete<{ Params: { login: string } }>('/api/admin/users/:login', async (req) => {
    if (req.params.login.toLowerCase() === req.user!.login.toLowerCase()) fail(400, 'Нельзя удалить себя');
    await users.remove(req.params.login);
    return { ok: true };
  });

  // Журнал действий команды
  app.get<{ Querystring: Record<string, string> }>('/api/admin/audit', async (req) => {
    const q = req.query ?? {};
    const from = isoDay(q.from);
    const to = isoDay(q.to);
    return {
      entries: await audit.list({
        login: q.login || undefined, targetType: q.targetType || undefined, targetId: q.targetId || undefined, via: q.via || undefined,
        q: q.q?.trim() || undefined, from: from ? `${from}T00:00:00` : undefined, to: to ? nextDayIso(to) : undefined,
        before: Number(q.before) || undefined, limit: 100,
      }),
      logins: await audit.logins(),
    };
  });

  // Резервные копии базы: там все данные — только администратору
  app.get('/api/admin/backups', async (): Promise<BackupsInfo> => ({ list: listBackups(), everyHours: config.backupHours, keep: config.backupKeep, database: sql.kind }));
  app.post('/api/admin/backups', async () => makeBackup());
  app.get<{ Params: { name: string } }>('/api/admin/backups/:name', async (req, reply) => {
    const file = found(backupPath(req.params.name), 'Копия не найдена');
    return sendDownload(reply, req.params.name, 'application/octet-stream', createReadStream(file));
  });
}
