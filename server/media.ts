// Картинки анкет (варианты, уровни конджойнта, клик по картинке, логотип), загруженные командой.
// Хранятся в data/media, отдаются всем по адресу /media/<id>: их видят респонденты.
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { newId } from './db.ts';
import { detectType, MIME } from './uploads.ts';

const ROOT = resolve(config.dataDir, 'media');
const MEDIA_RE = /^[a-z0-9]{16}\.(jpg|png|gif|webp)$/;
/** Только то, что показывают все браузеры; SVG не принимаем — в нём может быть скрипт */
export const MEDIA_EXT = ['jpg', 'png', 'gif', 'webp'];
export const MEDIA_MAX_MB = 5;

/** Сохранить картинку; null — не картинка или неподдерживаемый формат */
export function saveMedia(buf: Buffer): string | null {
  const ext = detectType(buf, '');
  if (!ext || !MEDIA_EXT.includes(ext)) return null;
  mkdirSync(ROOT, { recursive: true });
  const id = `${newId(16)}.${ext}`;
  writeFileSync(resolve(ROOT, id), buf);
  return id;
}

/** Раздача картинок: публично, надолго в кэш (адрес меняется вместе с картинкой) */
export async function mediaRoutes(app: FastifyInstance) {
  app.get<{ Params: { file: string } }>('/media/:file', async (req, reply) => {
    const file = req.params.file;
    const p = MEDIA_RE.test(file) ? resolve(ROOT, file) : null;
    if (!p || !existsSync(p)) return reply.code(404).send({ error: 'Картинка не найдена' });
    reply.header('Content-Type', MIME[file.split('.').pop()!]).header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(createReadStream(p));
  });
}
