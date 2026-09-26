// Файлы респондентов (вопрос «Загрузка файла»): data/uploads/<проект>/<ответ>/<id>.<расширение>.
// Тип определяется по содержимому, а не по имени; в интернет файлы не раздаются — только команде и самому респонденту.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.ts';
import { newId } from './db.ts';
import { FILE_ID_RE } from '../shared/answers.ts';

const ROOT = resolve(config.dataDir, 'uploads');

export const IMAGE_EXT = ['jpg', 'png', 'gif', 'webp', 'heic'] as const;
export const MIME: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Тип файла по первым байтам; для документов Office (zip) — по расширению исходного имени */
export function detectType(buf: Buffer, name: string): string | null {
  const b = buf;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const brand = b.subarray(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|hevc|mif1|msf1)/.test(brand)) return 'heic';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const ext = name.toLowerCase().match(/\.(docx|xlsx|pptx)$/)?.[1];
    return ext ?? null;
  }
  return null;
}

const dirOf = (owner: string, rid: string) => resolve(ROOT, owner.replace(/[^\w-]/g, '_'), rid.replace(/[^\w-]/g, '_'));

export function saveUpload(owner: string, rid: string, buf: Buffer, ext: string): string {
  const dir = dirOf(owner, rid);
  mkdirSync(dir, { recursive: true });
  const id = `${newId(12)}.${ext}`;
  writeFileSync(resolve(dir, id), buf);
  return id;
}

/** Путь к файлу ответа или null (ID проверяется по шаблону — без выхода из папки) */
export function uploadPath(owner: string, rid: string, id: string): string | null {
  if (!FILE_ID_RE.test(id)) return null;
  const p = resolve(dirOf(owner, rid), id);
  return existsSync(p) ? p : null;
}

export function countUploads(owner: string, rid: string): number {
  const dir = dirOf(owner, rid);
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

export function uploadSize(p: string): number {
  return statSync(p).size;
}

export function removeUploads(owner: string, rid?: string): void {
  const dir = rid ? dirOf(owner, rid) : resolve(ROOT, owner.replace(/[^\w-]/g, '_'));
  rmSync(dir, { recursive: true, force: true });
}
