import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { adminRoutes } from './routes/admin.ts';
import { respondentRoutes } from './routes/respondent.ts';

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.isProduction ? 'info' : 'warn' },
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(adminRoutes);
  await app.register(respondentRoutes);

  app.get('/api/health', async () => ({ ok: true }));

  // В продакшене сервер сам отдаёт собранный фронтенд (npm run build → web/dist)
  const dist = resolve('web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Не найдено' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
