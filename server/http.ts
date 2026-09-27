// Общее для маршрутов: ошибки API, отдача файлов, CSV, разбор фильтров из адреса.
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { IMAGE_EXT, MIME } from './uploads.ts';
import type { ResponseStatus } from '../shared/variables.ts';

/**
 * Ошибка API: обработчик бросает её, клиент получает статус и тело (обычно `{ error: текст }`).
 * Так маршрут не пишет `return reply.code(…).send(…)` на каждой проверке.
 */
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`);
  }
}

/** Прервать запрос: статус, текст ошибки и необязательные поля ответа */
export function fail(status: number, error: string, extra?: Record<string, unknown>): never {
  throw new HttpError(status, { error, ...extra });
}

/** Прервать запрос с произвольным телом (например, результатом проверки анкеты) */
export function failWith(status: number, body: object): never {
  throw new HttpError(status, body as Record<string, unknown>);
}

/** Значение или 404 */
export function found<T>(value: T | null | undefined, error: string): T {
  if (value === null || value === undefined) fail(404, error);
  return value;
}

/** HttpError → ответ; остальные ошибки обрабатывает Fastify как обычно */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(err.body);
    return reply.send(err);
  });
}

/** Имя файла для Content-Disposition (кириллица через RFC 5987) */
export function attachment(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Отдать загруженный файл: картинки открываются в браузере, остальное скачивается (downloadName — имя для скачивания) */
export function sendUpload(reply: FastifyReply, path: string, cache: string, downloadName?: string) {
  const ext = path.split('.').pop()!;
  const inline = IMAGE_EXT.includes(ext as never);
  reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream').header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', cache)
    .header('Content-Disposition', inline ? 'inline' : downloadName ? attachment(downloadName) : 'attachment');
  return reply.send(createReadStream(path));
}

/** Отдать файл на скачивание */
export function sendDownload(reply: FastifyReply, name: string, contentType: string, body: unknown) {
  reply.header('Content-Type', contentType).header('Content-Disposition', attachment(name));
  return reply.send(body);
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** CSV для русского Excel: разделитель «;», BOM, строки через CRLF */
export function toCsv(rows: unknown[][]): string {
  const esc = (x: string) => (/[;"\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  return '﻿' + rows.map((row) => row.map((c) => esc(String(c ?? ''))).join(';')).join('\r\n');
}

export const ALL_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'terminated', 'overquota', 'in_progress'];

/** Статусы из списка через запятую; без параметра — только завершённые */
export function parseStatuses(raw: string | undefined): ResponseStatus[] {
  return (raw?.split(',').filter((x) => ALL_STATUSES.includes(x as ResponseStatus)) ?? ['completed']) as ResponseStatus[];
}

/** Статусы из массива (тело запроса, спецификация таблиц) */
export function pickStatuses(list: unknown): ResponseStatus[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.filter((x): x is ResponseStatus => ALL_STATUSES.includes(x as ResponseStatus));
}

/** День YYYY-MM-DD или undefined */
export const isoDay = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

/** Начало следующего дня (UTC), ISO — граница «по этот день включительно» */
export const nextDayIso = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString();
