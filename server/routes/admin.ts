import type { FastifyInstance } from 'fastify';
import {
  authenticate, checkUserPassword, clearSession, currentUser, hashPassword, isBuiltInLogin, loginBlocked, loginFailed,
  requireAdminRole, requireUser, setSession, testToken,
} from '../auth.ts';
import { audit, invitees, oauth, projects, responses, surveys, users, type NotifyConfig, type TableSet, type Role, type SheetsConfig } from '../db.ts';
import { defFor, loadProject } from '../projectCtx.ts';
import { buildTable, cellToText } from '../export/table.ts';
import { writeXlsx } from '../export/xlsx.ts';
import { writeSav } from '../export/sav.ts';
import { queueFullSync, sheetsStatus } from '../sheets.ts';
import { simulate } from '../simulate.ts';
import { dailyStats } from '../daily.ts';
import { buildCrosstabs, type CrosstabSpec } from '../../shared/crosstab.ts';
import { writeCrosstabXlsx, type Measure } from '../export/crosstabXlsx.ts';
import { auditHooks, auditLogin } from '../audit.ts';
import { quotaCounts, resetQuotas } from '../quotas.ts';
import { buildReport } from '../../shared/report.ts';
import { send, telegramConfigured } from '../notify.ts';
import { backupPath, listBackups, makeBackup } from '../backup.ts';
import { createReadStream } from 'node:fs';
import { config } from '../config.ts';
import { validatePanels, validateSurvey } from '../../shared/validate.ts';
import { migrateSurvey } from '../../shared/migrate.ts';
import { PANEL_PARAM, PROJECT_SETTING_KEYS, RESERVED_PARAMS, effectiveSurvey, type Condition, type Panel, type ProjectSettings, type ProjectStatus, type Quota, type Survey } from '../../shared/types.ts';
import { evalCondition } from '../../shared/logic.ts';
import { expandAllLoops } from '../../shared/loops.ts';
import type { ResponseStatus } from '../../shared/variables.ts';

/** Черновик можно сохранить с ошибками логики, но не с поломанной структурой */
export function draftShapeOk(def: unknown): boolean {
  const d = def as Survey;
  return !!d && typeof d === 'object' && typeof d.title === 'string' && Array.isArray(d.blocks) && d.blocks.length > 0
    && d.blocks.every((b) => b && typeof b === 'object' && Array.isArray(b.questions));
}

const ALL_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'terminated', 'overquota', 'in_progress'];

export function blankSurvey(title = 'Новая анкета'): Survey {
  return {
    formatVersion: 2,
    title,
    settings: { showProgress: true, allowBack: true, allowEarlyFinish: false },
    blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Первый вопрос', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
  };
}

/** Имя файла для Content-Disposition (кириллица через RFC 5987) */
function attachment(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function adminRoutes(app: FastifyInstance) {
  app.post<{ Body: { login: string; password: string } }>('/api/admin/login', async (req, reply) => {
    const { login, password } = req.body ?? ({} as { login: string; password: string });
    if (loginBlocked(req.ip)) return reply.code(429).send({ error: 'Слишком много неудачных попыток. Подождите 15 минут.' });
    const user = await authenticate(String(login ?? '').trim(), String(password ?? ''));
    if (!user) {
      loginFailed(req.ip);
      await auditLogin(req, String(login ?? '').trim().slice(0, 50), false);
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    setSession(reply, user.login);
    await auditLogin(req, user.login, true);
    return user;
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/admin/me', async (req) => {
    const u = await currentUser(req);
    return u ?? { login: null };
  });

  // Всё ниже — только для команды
  app.register(async (priv) => {
    priv.addHook('preHandler', requireUser);
    auditHooks(priv);

    priv.post<{ Body: { current: string; next: string } }>('/api/admin/me/password', async (req, reply) => {
      const u = req.user!;
      if (u.builtIn) return reply.code(400).send({ error: 'Пароль главного администратора меняется в .env (ADMIN_PASSWORD)' });
      if (!(await checkUserPassword(u.login, String(req.body?.current ?? '')))) return reply.code(400).send({ error: 'Текущий пароль неверен' });
      const next = String(req.body?.next ?? '');
      if (next.length < 8) return reply.code(400).send({ error: 'Новый пароль — не короче 8 символов' });
      await users.update(u.login, { passwordHash: hashPassword(next) });
      return { ok: true };
    });

    // ---- ИИ-коннектор: приложения, которым пользователь дал доступ ----
    priv.get('/api/admin/me/connections', async (req) => oauth.connections(req.user!.login));
    priv.delete<{ Params: { clientId: string } }>('/api/admin/me/connections/:clientId', async (req) => ({
      revoked: await oauth.revoke(req.user!.login, req.params.clientId),
    }));

    // ---- Пользователи (только администратор) ----
    const ROLES: Role[] = ['admin', 'editor', 'viewer', 'client'];
    const ROLE_ERROR = 'Роль: admin, editor, viewer или client';
    /** Проекты заказчика: только существующие */
    const cleanProjects = async (raw: unknown): Promise<string[] | null> => {
      if (raw === undefined) return [];
      if (!Array.isArray(raw)) return null;
      const out: string[] = [];
      for (const id of raw) if (typeof id === 'string' && !out.includes(id) && (await projects.get(id))) out.push(id);
      return out;
    };
    priv.register(async (adm) => {
      adm.addHook('preHandler', requireAdminRole);

      adm.get('/api/admin/users', async () => users.list());

      adm.post<{ Body: { login: string; password: string; role: Role; projects?: string[] } }>('/api/admin/users', async (req, reply) => {
        const login = String(req.body?.login ?? '').trim();
        const password = String(req.body?.password ?? '');
        const role = req.body?.role;
        if (!/^[\w.@-]{2,50}$/.test(login)) return reply.code(400).send({ error: 'Логин: 2–50 символов, латиница, цифры, _ . @ -' });
        if (isBuiltInLogin(login) || (await users.get(login))) return reply.code(400).send({ error: 'Такой логин уже есть' });
        if (password.length < 8) return reply.code(400).send({ error: 'Пароль — не короче 8 символов' });
        if (!ROLES.includes(role)) return reply.code(400).send({ error: ROLE_ERROR });
        const list = await cleanProjects(req.body?.projects);
        if (!list) return reply.code(400).send({ error: 'projects: ожидается список ID проектов' });
        await users.create(login, hashPassword(password), role);
        if (list.length) await users.update(login, { projects: list });
        return { ok: true };
      });

      adm.put<{ Params: { login: string }; Body: { role?: Role; password?: string; disabled?: boolean; projects?: string[] } }>('/api/admin/users/:login', async (req, reply) => {
        const u = await users.get(req.params.login);
        if (!u) return reply.code(404).send({ error: 'Пользователь не найден' });
        const b = req.body ?? {};
        if (b.role !== undefined && !ROLES.includes(b.role)) return reply.code(400).send({ error: ROLE_ERROR });
        const list = b.projects === undefined ? undefined : await cleanProjects(b.projects);
        if (list === null) return reply.code(400).send({ error: 'projects: ожидается список ID проектов' });
        if (b.password !== undefined && String(b.password).length < 8) return reply.code(400).send({ error: 'Пароль — не короче 8 символов' });
        if (u.login === req.user!.login && (b.disabled || (b.role && b.role !== 'admin'))) {
          return reply.code(400).send({ error: 'Нельзя отключить себя или снять с себя права администратора' });
        }
        await users.update(u.login, {
          role: b.role, disabled: b.disabled, passwordHash: b.password !== undefined ? hashPassword(String(b.password)) : undefined,
          projects: list,
        });
        return { ok: true };
      });

      adm.delete<{ Params: { login: string } }>('/api/admin/users/:login', async (req, reply) => {
        if (req.params.login.toLowerCase() === req.user!.login.toLowerCase()) return reply.code(400).send({ error: 'Нельзя удалить себя' });
        await users.remove(req.params.login);
        return { ok: true };
      });

      // Журнал действий команды
      adm.get<{ Querystring: Record<string, string> }>('/api/admin/audit', async (req) => {
        const q = req.query ?? {};
        const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
        return {
          entries: await audit.list({
            login: q.login || undefined, targetType: q.targetType || undefined, targetId: q.targetId || undefined, via: q.via || undefined,
            q: q.q?.trim() || undefined, from: day(q.from) ? `${q.from}T00:00:00` : undefined,
            to: day(q.to) ? new Date(Date.parse(`${q.to}T00:00:00Z`) + 86400_000).toISOString() : undefined,
            before: Number(q.before) || undefined, limit: 100,
          }),
          logins: await audit.logins(),
        };
      });

      // Резервные копии базы: там все данные — только администратору
      adm.get('/api/admin/backups', async () => ({ list: listBackups(), everyHours: config.backupHours, keep: config.backupKeep }));
      adm.post('/api/admin/backups', async () => makeBackup());
      adm.get<{ Params: { name: string } }>('/api/admin/backups/:name', async (req, reply) => {
        const file = backupPath(req.params.name);
        if (!file) return reply.code(404).send({ error: 'Копия не найдена' });
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', attachment(req.params.name));
        return reply.send(createReadStream(file));
      });
    });

    // ================= Анкеты (конструктор) =================

    priv.get('/api/admin/surveys', async () => surveys.list());

    priv.post<{ Body: { definition?: unknown; title?: string } }>('/api/admin/surveys', async (req, reply) => {
      const def = req.body?.definition !== undefined ? migrateSurvey(req.body.definition) : blankSurvey(req.body?.title);
      const v = validateSurvey(def);
      if (!draftShapeOk(def)) return reply.code(422).send(v);
      const s = await surveys.create(def as Survey);
      return { id: s.id, errors: v.errors, warnings: v.warnings };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const used = (await projects.bySurvey(s.id)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
      return { ...s, testToken: testToken(s.id), projects: used };
    });

    priv.put<{ Params: { id: string }; Body: { definition: unknown } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const def = migrateSurvey(req.body?.definition);
      const v = validateSurvey(def);
      if (!draftShapeOk(def)) return reply.code(422).send(v);
      await surveys.saveDraft(s.id, def as Survey);
      return { ok: true, errors: v.errors, warnings: v.warnings };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/publish', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const v = validateSurvey(s.draft);
      if (!v.ok) return reply.code(422).send(v);
      const version = await surveys.publish(s.id, req.user!.login);
      return { version };
    });

    priv.post<{ Params: { id: string }; Body: { archived: boolean } }>('/api/admin/surveys/:id/archive', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      await surveys.setArchived(s.id, !!req.body?.archived);
      return { ok: true };
    });

    // История опубликованных версий: просмотр и возврат версии в черновик
    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id/versions', async (req) => surveys.versions(req.params.id));

    priv.get<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v', async (req, reply) => {
      const def = await surveys.version(req.params.id, Number(req.params.v));
      if (!def) return reply.code(404).send({ error: 'Версия не найдена' });
      return def;
    });

    priv.post<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v/restore', async (req, reply) => {
      const def = await surveys.version(req.params.id, Number(req.params.v));
      if (!def) return reply.code(404).send({ error: 'Версия не найдена' });
      await surveys.saveDraft(req.params.id, def);
      return { ok: true };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/duplicate', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const copy = await surveys.create({ ...s.draft, title: `${s.draft.title} (копия)` });
      return { id: copy.id };
    });

    priv.delete<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req, reply) => {
      const used = await projects.bySurvey(req.params.id);
      if (used.length) {
        return reply.code(400).send({ error: `Анкета используется в проектах: ${used.map((p) => `«${p.title}»`).join(', ')}. Сначала удалите проекты или выберите в них другую анкету.` });
      }
      await surveys.remove(req.params.id);
      return { ok: true };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id/export.json', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      reply.header('Content-Disposition', attachment(`${s.draft.title.slice(0, 60)}.json`));
      return reply.send(JSON.stringify(s.draft, null, 2));
    });

    // ================= Проекты (сбор, квоты, данные, отчёты) =================

    const PROJECT_STATUSES: ProjectStatus[] = ['development', 'collecting', 'processing', 'archive'];

    priv.get('/api/admin/projects', async (req) => {
      const u = req.user!;
      const list = (await projects.list()).filter((p) => u.role !== 'client' || (u.projects ?? []).includes(p.id));
      return Promise.all(list.map(async (p) => {
        // Прогресс квот — по опубликованной версии анкеты
        let quotasFull = 0;
        if (p.quotas.length) {
          const l = await loadProject(p.id);
          if (l?.live) {
            const counts = await quotaCounts(p.id, l.live, false);
            quotasFull = p.quotas.filter((q) => (counts.get(q.id) ?? 0) >= q.limit).length;
          }
        }
        return {
          id: p.id, title: p.title, status: p.status, surveyId: p.surveyId, surveyTitle: p.surveyTitle, counts: p.counts,
          panels: p.panels.length,
          maxResponses: p.settings.maxResponses ?? null, openFrom: p.settings.openFrom ?? null, closeAt: p.settings.closeAt ?? null,
          quotas: p.quotas.length, quotasFull, createdAt: p.createdAt, updatedAt: p.updatedAt,
        };
      }));
    });

    priv.post<{ Body: { surveyId?: string; title?: string } }>('/api/admin/projects', async (req, reply) => {
      const s = req.body?.surveyId ? await surveys.get(req.body.surveyId) : null;
      if (!s) return reply.code(400).send({ error: 'Выберите анкету для проекта' });
      const title = String(req.body?.title ?? '').trim() || s.draft.title;
      const p = await projects.create({ title: title.slice(0, 200), surveyId: s.id });
      // Настройки сбора и квоты, если они пришли в JSON анкеты (импорт, анкета от ИИ), становятся стартовыми настройками проекта
      const src = s.published ?? s.draft;
      const seeded: Record<string, unknown> = {};
      for (const k of PROJECT_SETTING_KEYS) if (src.settings?.[k] !== undefined) seeded[k] = src.settings[k];
      if (Object.keys(seeded).length || src.quotas?.length) {
        await projects.update(p.id, { settings: seeded as ProjectSettings, quotas: src.quotas ?? [] });
      }
      return { id: p.id };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/projects/:id', async (req, reply) => {
      const l = await loadProject(req.params.id);
      if (!l) return reply.code(404).send({ error: 'Проект не найден' });
      const { project: p, survey: s } = l;
      const counts = l.live && p.quotas.length ? await quotaCounts(p.id, l.live, false) : null;
      const info = {
        id: p.id, title: p.title, status: p.status, settings: p.settings, quotaDefs: p.quotas, panels: p.panels, tableSets: p.tables,
        panelCounts: await responses.countsByPanel(p.id),
        quotas: p.quotas.map((q) => ({ id: q.id, title: q.title, limit: q.limit, count: counts?.get(q.id) ?? 0 })),
        survey: { id: s.id, title: s.draft.title, version: s.version, published: !!s.published, unpublished: !s.published || JSON.stringify(s.published) !== JSON.stringify(s.draft) },
        // Анкета с настройками проекта: для отчёта, данных и условий квот
        draft: l.draft, published: l.live,
        sheets: p.sheets, notify: p.notify, counts: await responses.counts(p.id),
        sheetsAccount: sheetsStatus(), testToken: testToken(p.id), telegramConfigured: telegramConfigured(),
        daily: dailyStats(await responses.timeline(p.id)),
        invitees: await invitees.count(p.id),
        createdAt: p.createdAt, updatedAt: p.updatedAt,
      };
      if (req.user!.role !== 'client') return info;
      // Заказчику — без служебного: тестовой ссылки, интеграций, пароля и адресов возврата панелей
      const { password: _pw, ...settings } = p.settings;
      return {
        ...info, settings, testToken: '', sheets: null, notify: null, sheetsAccount: { configured: false, email: null }, telegramConfigured: false,
        panels: p.panels.map((x) => ({ id: x.id, title: x.title, limit: x.limit, closed: x.closed })),
      };
    });

    priv.post<{ Params: { id: string }; Body: { title?: string } }>('/api/admin/projects/:id/copy', async (req, reply) => {
      const p = await projects.get(req.params.id);
      if (!p) return reply.code(404).send({ error: 'Проект не найден' });
      const title = String(req.body?.title ?? '').trim() || `${p.title} (копия)`;
      const copy = await projects.copy(p.id, title.slice(0, 200));
      return { id: copy.id };
    });

    priv.put<{ Params: { id: string }; Body: { title?: string; surveyId?: string; settings?: ProjectSettings; quotas?: Quota[]; panels?: Panel[]; tables?: TableSet[] } }>(
      '/api/admin/projects/:id',
      async (req, reply) => {
        const l = await loadProject(req.params.id);
        if (!l) return reply.code(404).send({ error: 'Проект не найден' });
        const b = req.body ?? {};
        const patch: Parameters<typeof projects.update>[1] = {};
        if (b.title !== undefined) {
          const title = String(b.title).trim();
          if (!title) return reply.code(400).send({ error: 'Укажите название проекта' });
          patch.title = title.slice(0, 200);
        }
        let survey = l.survey;
        if (b.surveyId !== undefined && b.surveyId !== l.survey.id) {
          const s = await surveys.get(b.surveyId);
          if (!s) return reply.code(400).send({ error: 'Анкета не найдена' });
          if (l.project.status === 'collecting') return reply.code(400).send({ error: 'Во время сбора анкету проекта менять нельзя — сначала остановите сбор' });
          patch.surveyId = s.id;
          survey = s;
        }
        if (b.settings !== undefined) {
          const clean: Record<string, unknown> = {};
          for (const k of PROJECT_SETTING_KEYS) if ((b.settings as Record<string, unknown>)[k] !== undefined) clean[k] = (b.settings as Record<string, unknown>)[k];
          patch.settings = clean as ProjectSettings;
        }
        if (b.quotas !== undefined) {
          if (!Array.isArray(b.quotas)) return reply.code(400).send({ error: 'quotas: ожидается массив' });
          patch.quotas = b.quotas;
        }
        if (b.panels !== undefined) {
          const errs = validatePanels(b.panels);
          if (errs.length) return reply.code(422).send({ error: errs.join('; ') });
          patch.panels = b.panels;
        }
        if (b.tables !== undefined) {
          if (!Array.isArray(b.tables) || b.tables.length > 50
            || !b.tables.every((t) => t && typeof t.name === 'string' && t.name.trim() && t.spec && Array.isArray(t.spec.rows) && Array.isArray(t.spec.cols))) {
            return reply.code(400).send({ error: 'Наборы таблиц: список {name, spec} (не больше 50)' });
          }
          patch.tables = b.tables.map((t) => ({ name: t.name.trim().slice(0, 100), spec: t.spec }));
        }
        // Настройки и квоты проверяются вместе с анкетой — условия квот ссылаются на её вопросы
        const next = { settings: patch.settings ?? l.project.settings, quotas: patch.quotas ?? l.project.quotas };
        const v = validateSurvey(effectiveSurvey(survey.published ?? survey.draft, next));
        const own = v.errors.filter((e) => e.where.startsWith('settings.') || e.where.startsWith('квота'));
        if (own.length) return reply.code(422).send({ error: own.map((e) => `${e.where}: ${e.message}`).join('; '), errors: own });
        await projects.update(l.project.id, patch);
        if (patch.quotas || patch.surveyId) resetQuotas(l.project.id);
        return { ok: true };
      },
    );

    priv.post<{ Params: { id: string }; Body: { status: ProjectStatus } }>('/api/admin/projects/:id/status', async (req, reply) => {
      const l = await loadProject(req.params.id);
      if (!l) return reply.code(404).send({ error: 'Проект не найден' });
      const status = req.body?.status;
      if (!PROJECT_STATUSES.includes(status)) return reply.code(400).send({ error: 'Статус: development, collecting, processing или archive' });
      if (status === 'collecting' && !l.live) return reply.code(400).send({ error: 'Сначала опубликуйте анкету проекта' });
      await projects.update(l.project.id, { status });
      return { ok: true };
    });

    priv.delete<{ Params: { id: string } }>('/api/admin/projects/:id', async (req) => {
      await projects.remove(req.params.id);
      resetQuotas(req.params.id);
      return { ok: true };
    });

    priv.delete<{ Params: { id: string } }>('/api/admin/projects/:id/test-responses', async (req) => {
      resetQuotas(req.params.id);
      return { deleted: await responses.deleteTest(req.params.id) };
    });

    // Тестовое заполнение черновика анкеты случайными ответами по логике — в проект, как тестовые ответы
    priv.post<{ Params: { id: string }; Body: { count?: number } }>('/api/admin/projects/:id/simulate', async (req, reply) => {
      const l = await loadProject(req.params.id);
      if (!l) return reply.code(404).send({ error: 'Проект не найден' });
      const v = validateSurvey(l.draft);
      if (!v.ok) return reply.code(422).send({ error: 'Сначала исправьте ошибки в анкете', ...v });
      const count = Math.min(Math.max(Number(req.body?.count) || 20, 1), 500);
      return { count, stats: await simulate(l.project.id, l.survey.id, l.draft, l.survey.version, count) };
    });

    priv.get<{ Params: { id: string; rid: string } }>('/api/admin/projects/:id/responses/:rid', async (req, reply) => {
      const l = await loadProject(req.params.id);
      const r = await responses.get(req.params.rid);
      if (!l || !r || r.projectId !== l.project.id) return reply.code(404).send({ error: 'Ответ не найден' });
      return { response: r, survey: defFor(l, r.isTest) };
    });

    priv.post<{ Params: { id: string; rid: string }; Body: { rejected: boolean } }>('/api/admin/projects/:id/responses/:rid/reject', async (req, reply) => {
      const r = await responses.get(req.params.rid);
      if (!r || r.projectId !== req.params.id) return reply.code(404).send({ error: 'Ответ не найден' });
      await responses.update(r.id, { rejected: !!req.body?.rejected });
      resetQuotas(req.params.id);
      return { ok: true };
    });

    // ---- Персональные ссылки ----
    const MAX_INVITEES = 20_000;
    const FIELD_KEY = /^[A-Za-z][\w.-]{0,49}$/;

    priv.get<{ Params: { id: string } }>('/api/admin/projects/:id/invitees', async (req, reply) => {
      if (!(await projects.get(req.params.id))) return reply.code(404).send({ error: 'Проект не найден' });
      return invitees.list(req.params.id);
    });

    priv.post<{ Params: { id: string }; Body: { people?: { extId?: unknown; fields?: unknown }[] } }>('/api/admin/projects/:id/invitees', async (req, reply) => {
      if (!(await projects.get(req.params.id))) return reply.code(404).send({ error: 'Проект не найден' });
      const list = req.body?.people;
      if (!Array.isArray(list) || !list.length) return reply.code(400).send({ error: 'Список пуст' });
      if ((await invitees.count(req.params.id)) + list.length > MAX_INVITEES) return reply.code(400).send({ error: `В проекте может быть не больше ${MAX_INVITEES} человек` });
      const people: { extId: string | null; fields: Record<string, string> }[] = [];
      for (const [i, p] of list.entries()) {
        const fields: Record<string, string> = {};
        const raw = p?.fields && typeof p.fields === 'object' ? Object.entries(p.fields as Record<string, unknown>) : [];
        if (raw.length > 30) return reply.code(400).send({ error: `Строка ${i + 1}: не больше 30 столбцов` });
        for (const [k, v] of raw) {
          if (!FIELD_KEY.test(k) || RESERVED_PARAMS.includes(k) || k === 'panel' || k === 'inv_id') {
            return reply.code(400).send({ error: `Столбец «${k}»: латиница, цифры, _ . -, начинается с буквы; нельзя ${RESERVED_PARAMS.join(', ')}, panel, inv_id` });
          }
          if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = String(v).trim().slice(0, 300);
        }
        const extId = p?.extId === undefined || p.extId === null || String(p.extId).trim() === '' ? null : String(p.extId).trim().slice(0, 100);
        people.push({ extId, fields });
      }
      return invitees.add(req.params.id, people);
    });

    priv.post<{ Params: { id: string }; Body: { ids?: number[]; all?: boolean } }>('/api/admin/projects/:id/invitees/delete', async (req, reply) => {
      const ids = req.body?.all ? 'all' as const : Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => Number.isInteger(x)) : null;
      if (!ids) return reply.code(400).send({ error: 'Укажите ids или all' });
      return { deleted: await invitees.remove(req.params.id, ids) };
    });

    priv.post<{ Params: { id: string; iid: string } }>('/api/admin/projects/:id/invitees/:iid/reissue', async (req) => {
      await invitees.reissue(req.params.id, Number(req.params.iid));
      return { ok: true };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/projects/:id/reject-suspect', async (req, reply) => {
      if (!(await projects.get(req.params.id))) return reply.code(404).send({ error: 'Проект не найден' });
      const rejected = await responses.rejectSuspect(req.params.id);
      resetQuotas(req.params.id);
      return { rejected };
    });

    priv.delete<{ Params: { id: string; rid: string } }>('/api/admin/projects/:id/responses/:rid', async (req, reply) => {
      const r = await responses.get(req.params.rid);
      if (!r || r.projectId !== req.params.id) return reply.code(404).send({ error: 'Ответ не найден' });
      await responses.remove(r.id);
      resetQuotas(req.params.id);
      return { ok: true };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/projects/:id/responses', async (req) => {
      const list = await responses.list(req.params.id, { includeTest: true, includeRejected: true });
      return list.slice(-200).reverse().map((r) => ({
        id: r.id, status: r.status, isTest: r.isTest, rejected: r.rejected, startedAt: r.startedAt, completedAt: r.completedAt,
        durationSec: r.durationSec, answered: Object.keys(r.answers).length, params: r.params, flags: r.flags ?? [],
      }));
    });

    // ---- Таблицы (кросс-таблицы) ----
    function parseSpec(raw: string | undefined): CrosstabSpec | string {
      let s: CrosstabSpec;
      try { s = JSON.parse(raw ?? ''); } catch { return 'spec: некорректный JSON'; }
      const refOk = (x: unknown) => !!x && typeof x === 'object'
        && ((typeof (x as { q?: unknown }).q === 'string') || (typeof (x as { param?: unknown }).param === 'string'));
      if (!s || !Array.isArray(s.rows) || !Array.isArray(s.cols) || !s.rows.every(refOk) || !s.cols.every(refOk)) return 'spec: rows и cols — списки переменных';
      if (s.rows.length > 100 || s.cols.length > 10) return 'Не больше 100 строк и 10 переменных в шапке';
      return s;
    }
    async function crosstab(id: string, spec: CrosstabSpec) {
      const l = await loadProject(id);
      if (!l) return null;
      const def = defFor(l, !!spec.test);
      const statuses = (spec.statuses?.filter((x) => ALL_STATUSES.includes(x)) ?? ['completed']) as ResponseStatus[];
      const list = (await responses.list(l.project.id, { includeTest: !!spec.test, statuses: statuses.length ? statuses : ['completed'] }))
        .filter((r) => r.isTest === !!spec.test)
        .filter((r) => !spec.filter || evalCondition(spec.filter, { survey: def, answers: r.answers, params: r.params, seed: r.id }));
      return { l, result: buildCrosstabs(expandAllLoops(def), spec, list) };
    }

    priv.get<{ Params: { id: string }; Querystring: { spec?: string } }>('/api/admin/projects/:id/crosstab', async (req, reply) => {
      const spec = parseSpec(req.query.spec);
      if (typeof spec === 'string') return reply.code(400).send({ error: spec });
      const out = await crosstab(req.params.id, spec);
      return out ? out.result : reply.code(404).send({ error: 'Проект не найден' });
    });

    priv.get<{ Params: { id: string }; Querystring: { spec?: string; measures?: string } }>('/api/admin/projects/:id/crosstab.xlsx', async (req, reply) => {
      const spec = parseSpec(req.query.spec);
      if (typeof spec === 'string') return reply.code(400).send({ error: spec });
      const out = await crosstab(req.params.id, spec);
      if (!out) return reply.code(404).send({ error: 'Проект не найден' });
      const measures = (req.query.measures?.split(',').filter((m) => ['colPct', 'rowPct', 'count'].includes(m)) ?? ['colPct']) as Measure[];
      const sig = spec.sig === 0 ? 'значимость не проверялась' : `буквы — столбец значимо больше указанных (${Math.round((spec.sig ?? 0.95) * 100)}%, база от ${out.result.minBase})`;
      const note = `Анкет: ${out.result.total}${spec.test ? ' (тестовые)' : ''}${spec.filter ? ', подгруппа' : ''}; ${sig}`;
      const date = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', attachment(`${out.l.project.title.slice(0, 60)}_таблицы_${date}.xlsx`));
      return reply.send(await writeCrosstabXlsx(out.result, out.l.project.title, measures.length ? measures : ['colPct'], note));
    });

    // Отчёт: распределения ответов и места, где бросают анкету
    priv.get<{ Params: { id: string }; Querystring: { statuses?: string; test?: string; filter?: string } }>('/api/admin/projects/:id/report', async (req, reply) => {
      const l = await loadProject(req.params.id);
      if (!l) return reply.code(404).send({ error: 'Проект не найден' });
      const test = req.query.test === '1';
      const def = defFor(l, test);
      const statuses = (req.query.statuses?.split(',').filter((x) => ALL_STATUSES.includes(x as ResponseStatus)) ?? ['completed']) as ResponseStatus[];
      // Подгруппа: условие как у showIf (по ответам и параметрам ссылки)
      let filter: Condition | undefined;
      if (req.query.filter) {
        try { filter = JSON.parse(req.query.filter); } catch { return reply.code(400).send({ error: 'Фильтр: некорректный JSON' }); }
      }
      const all = (await responses.list(l.project.id, { includeTest: test }))
        .filter((r) => r.isTest === test)
        .filter((r) => !filter || evalCondition(filter, { survey: def, answers: r.answers, params: r.params, seed: r.id }));
      const unfinished = all
        .filter((r) => r.status === 'in_progress' || r.status === 'terminated')
        .map((r) => ({ ...r, lastPage: r.status === 'in_progress' ? r.currentPage : r.history[r.history.length - 1] ?? null }));
      return buildReport(expandAllLoops(def), all.filter((r) => statuses.includes(r.status)), unfinished);
    });

    priv.get<{ Params: { id: string; format: string }; Querystring: { statuses?: string; test?: string; from?: string; to?: string; timings?: string; rejected?: string; panel?: string } }>(
      '/api/admin/projects/:id/export.:format',
      async (req, reply) => {
        const l = await loadProject(req.params.id);
        if (!l) return reply.code(404).send({ error: 'Проект не найден' });
        const def = defFor(l, req.query.test === '1');
        const statuses = (req.query.statuses?.split(',').filter((x) => ALL_STATUSES.includes(x as ResponseStatus)) ?? ['completed']) as ResponseStatus[];
        // Даты — дни в формате YYYY-MM-DD (по UTC-границам суток сервера); to — включительно
        const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
        const from = day(req.query.from) ? `${req.query.from}T00:00:00` : undefined;
        const to = day(req.query.to) ? new Date(Date.parse(`${req.query.to}T00:00:00Z`) + 86400_000).toISOString().slice(0, 19) : undefined;
        const list = (await responses.list(l.project.id, {
          includeTest: req.query.test === '1', statuses, includeRejected: req.query.rejected === '1', from, to,
        })).filter((r) => (req.query.test === '1' ? r.isTest : !r.isTest))
          // Панель: код или «-» — пришедшие без панели
          .filter((r) => !req.query.panel || (req.query.panel === '-' ? !r.params[PANEL_PARAM] : r.params[PANEL_PARAM] === req.query.panel));
        const table = buildTable(def, list, { timings: req.query.timings === '1' });
        const date = new Date().toISOString().slice(0, 10);
        const base = `${l.project.title.slice(0, 60)}_${date}${req.query.test === '1' ? '_test' : ''}`;
        if (req.params.format === 'xlsx') {
          reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          reply.header('Content-Disposition', attachment(`${base}.xlsx`));
          return reply.send(await writeXlsx(table, def.title));
        }
        if (req.params.format === 'sav') {
          reply.header('Content-Type', 'application/octet-stream');
          reply.header('Content-Disposition', attachment(`${base}.sav`));
          return reply.send(writeSav(table.vars, table.rows, def.title));
        }
        if (req.params.format === 'csv') {
          // Для русского Excel: разделитель «;» и BOM, значения — коды
          const esc = (x: string) => (/[;"\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
          const lines = [table.vars.map((v) => v.name), ...table.rows.map((row) => row.map((c, i) => cellToText(table.vars[i], c)))]
            .map((row) => row.map((x) => esc(String(x ?? ''))).join(';'));
          reply.header('Content-Type', 'text/csv; charset=utf-8');
          reply.header('Content-Disposition', attachment(`${base}.csv`));
          return reply.send('﻿' + lines.join('\r\n'));
        }
        return reply.code(400).send({ error: 'Формат: xlsx, sav или csv' });
      },
    );

    priv.put<{ Params: { id: string }; Body: Partial<NotifyConfig> | null }>('/api/admin/projects/:id/notify', async (req, reply) => {
      const p = await projects.get(req.params.id);
      if (!p) return reply.code(404).send({ error: 'Проект не найден' });
      const b = req.body ?? {};
      const webhookUrl = String(b.webhookUrl ?? '').trim() || undefined;
      if (webhookUrl && !/^https?:\/\/\S+$/i.test(webhookUrl)) return reply.code(400).send({ error: 'Адрес вебхука должен начинаться с http:// или https://' });
      const telegramChatId = String(b.telegramChatId ?? '').trim() || undefined;
      if (telegramChatId && !/^(-?\d+|@\w{4,})$/.test(telegramChatId)) return reply.code(400).send({ error: 'ID чата Telegram: число (например, -1001234567890) или @имя_канала' });
      const everyN = Math.max(0, Math.round(Number(b.everyN) || 0)) || undefined;
      const cfg: NotifyConfig | null = webhookUrl || telegramChatId
        ? { webhookUrl, telegramChatId, everyN, quotaFull: !!b.quotaFull, limitReached: !!b.limitReached, lastError: p.notify?.lastError ?? null, lastSentAt: p.notify?.lastSentAt }
        : null;
      await projects.setNotify(p.id, cfg);
      return { ok: true, notify: cfg };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/projects/:id/notify/test', async (req, reply) => {
      const p = await projects.get(req.params.id);
      if (!p?.notify) return reply.code(400).send({ error: 'Сначала сохраните вебхук или чат Telegram' });
      const error = await send(p.id, p.title, p.notify, { kind: 'test' });
      return error ? reply.code(502).send({ error }) : { ok: true };
    });

    priv.put<{ Params: { id: string }; Body: Partial<SheetsConfig> | null }>('/api/admin/projects/:id/sheets', async (req, reply) => {
      const p = await projects.get(req.params.id);
      if (!p) return reply.code(404).send({ error: 'Проект не найден' });
      if (!req.body || !req.body.spreadsheetId) {
        await projects.setSheets(p.id, null);
        return { ok: true };
      }
      // Принимаем и полную ссылку на таблицу, и её ID
      const idMatch = String(req.body.spreadsheetId).match(/\/d\/([\w-]+)/);
      const cfg: SheetsConfig = {
        spreadsheetId: idMatch ? idMatch[1] : String(req.body.spreadsheetId).trim(),
        sheetName: String(req.body.sheetName || 'Ответы').slice(0, 90),
        auto: req.body.auto !== false,
        statuses: (req.body.statuses?.filter((x) => ALL_STATUSES.includes(x)) ?? ['completed']) as ResponseStatus[],
        values: req.body.values === 'codes' ? 'codes' : 'labels',
        lastSyncAt: p.sheets?.lastSyncAt,
        lastError: p.sheets?.lastError ?? null,
      };
      await projects.setSheets(p.id, cfg);
      return { ok: true, sheets: cfg };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/projects/:id/sheets/sync', async (req, reply) => {
      const p = await projects.get(req.params.id);
      if (!p?.sheets) return reply.code(400).send({ error: 'Google Sheets не настроен для этого проекта' });
      try {
        const n = await queueFullSync(p.id, p.sheets);
        await projects.setSheets(p.id, { ...p.sheets, lastSyncAt: new Date().toISOString(), lastError: null });
        return { rows: n };
      } catch (e) {
        await projects.setSheets(p.id, { ...p.sheets, lastError: (e as Error).message });
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
  });
}
