import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { adminRoutes } from './routes/admin.ts';
import { respondentRoutes } from './routes/respondent.ts';
import { oauthRoutes } from './oauth.ts';
import { mcpRoutes } from './mcp.ts';

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.isProduction ? 'info' : 'warn' },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(adminRoutes);
  await app.register(respondentRoutes);
  // ИИ-коннекторы: OAuth и MCP в одном контексте (свой разбор форм)
  await app.register(async (ai) => {
    await ai.register(oauthRoutes);
    await ai.register(mcpRoutes);
  });

  app.get('/api/health', async () => ({ ok: true }));

  // В продакшене сервер сам отдаёт собранный фронтенд (npm run build → web/dist)
  const dist = resolve('web/dist');
  if (existsSync(dist)) {
    // Файлы ищутся при каждом запросе — пересборка фронтенда не требует перезапуска сервера
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/') || req.url.startsWith('/oauth/') || req.url.startsWith('/.well-known/')) return reply.code(404).send({ error: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
