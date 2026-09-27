// API админки: вход и разделы для команды. Права по ролям — в requireUser (заказчик, наблюдатель) и requireAdminRole.
import type { FastifyInstance } from 'fastify';
import { authenticate, clearSession, currentUser, loginBlocked, loginFailed, requireUser, setSession } from '../../auth.ts';
import { auditHooks, auditLogin } from '../../audit.ts';
import { fail } from '../../http.ts';
import { accountRoutes } from './account.ts';
import { usersRoutes } from './users.ts';
import { mediaUploadRoutes } from './media.ts';
import { surveysRoutes } from './surveys.ts';
import { projectsRoutes } from './projects.ts';
import { inviteesRoutes } from './invitees.ts';
import { dataRoutes } from './data.ts';
import { integrationsRoutes } from './integrations.ts';

export async function adminRoutes(app: FastifyInstance) {
  app.post<{ Body: { login: string; password: string } }>('/api/admin/login', async (req, reply) => {
    const login = String(req.body?.login ?? '').trim();
    if (loginBlocked(req.ip)) fail(429, 'Слишком много неудачных попыток. Подождите 15 минут.');
    const user = await authenticate(login, String(req.body?.password ?? ''));
    if (!user) {
      loginFailed(req.ip);
      await auditLogin(req, login.slice(0, 50), false);
      fail(401, 'Неверный логин или пароль');
    }
    setSession(reply, user.login);
    await auditLogin(req, user.login, true);
    return user;
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/admin/me', async (req) => (await currentUser(req)) ?? { login: null });

  // Всё ниже — только для команды
  app.register(async (priv) => {
    priv.addHook('preHandler', requireUser);
    auditHooks(priv);
    await priv.register(accountRoutes);
    await priv.register(usersRoutes);
    await priv.register(mediaUploadRoutes);
    await priv.register(surveysRoutes);
    await priv.register(projectsRoutes);
    await priv.register(inviteesRoutes);
    await priv.register(dataRoutes);
    await priv.register(integrationsRoutes);
  });
}
