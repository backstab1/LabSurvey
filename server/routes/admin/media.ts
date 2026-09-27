// Картинки анкет: загружает команда, видят респонденты (/media/…)
import type { FastifyInstance } from 'fastify';
import { MEDIA_MAX_MB, saveMedia } from '../../media.ts';
import { fail } from '../../http.ts';

export async function mediaUploadRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MEDIA_MAX_MB * 1024 * 1024 + 1024 }, (_req, body, done) => done(null, body));

  app.post<{ Body: Buffer }>('/api/admin/media', async (req) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) fail(400, 'Пустой файл');
    if (buf.length > MEDIA_MAX_MB * 1024 * 1024) fail(413, `Картинка больше ${MEDIA_MAX_MB} МБ`);
    const id = saveMedia(buf);
    if (!id) fail(415, 'Нужна картинка JPG, PNG, WEBP или GIF');
    return { url: `/media/${id}` };
  });
}
