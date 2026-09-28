// Свой аккаунт: пароль и подключённые ИИ-приложения
import type { FastifyInstance } from 'fastify';
import { checkUserPassword, hashPassword } from '../../auth.ts';
import { oauth, users } from '../../db.ts';
import { fail } from '../../http.ts';

export const MIN_PASSWORD = 8;

export async function accountRoutes(app: FastifyInstance) {
  app.post<{ Body: { current: string; next: string } }>('/api/admin/me/password', async (req) => {
    const u = req.user!;
    if (u.builtIn) fail(400, 'Пароль главного администратора меняется в .env (ADMIN_PASSWORD)');
    if (!(await checkUserPassword(u.login, String(req.body?.current ?? '')))) fail(400, 'Текущий пароль неверен');
    const next = String(req.body?.next ?? '');
    if (next.length < MIN_PASSWORD) fail(400, 'Новый пароль – не короче 8 символов');
    await users.update(u.login, { passwordHash: hashPassword(next) });
    return { ok: true };
  });

  // ИИ-коннектор: приложения, которым пользователь дал доступ
  app.get('/api/admin/me/connections', async (req) => oauth.connections(req.user!.login));
  app.delete<{ Params: { clientId: string } }>('/api/admin/me/connections/:clientId', async (req) => ({
    revoked: await oauth.revoke(req.user!.login, req.params.clientId),
  }));
}
