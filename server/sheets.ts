// Синхронизация с Google Sheets через сервисный аккаунт.
// Таблицу нужно открыть на редактирование для email сервисного аккаунта.
import { existsSync, readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.ts';
import { projects, responses, type SheetsConfig } from './db.ts';
import { loadProject } from './projectCtx.ts';
import { buildTable, cellToText, withLabels } from './export/table.ts';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let auth: GoogleAuth | null = null;

export function sheetsStatus(): { configured: boolean; email: string | null } {
  if (!config.googleCredentials || !existsSync(config.googleCredentials)) return { configured: false, email: null };
  try {
    const key = JSON.parse(readFileSync(config.googleCredentials, 'utf8'));
    return { configured: true, email: key.client_email ?? null };
  } catch {
    return { configured: false, email: null };
  }
}

async function request(method: string, url: string, body?: unknown): Promise<any> {
  if (!sheetsStatus().configured) throw new Error('Google Sheets не настроен: укажите GOOGLE_APPLICATION_CREDENTIALS в .env');
  auth ??= new GoogleAuth({ keyFile: config.googleCredentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const res = await client.request({ url, method: method as 'GET', data: body, validateStatus: () => true });
  if (res.status >= 400) {
    const msg = (res.data as any)?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) {
      throw new Error(`Нет доступа к таблице (${msg}). Откройте таблицу на редактирование для ${sheetsStatus().email}`);
    }
    throw new Error(msg);
  }
  return res.data;
}

const range = (sheet: string, a1: string) => encodeURIComponent(`'${sheet.replace(/'/g, "''")}'!${a1}`);

async function ensureSheet(cfg: SheetsConfig): Promise<void> {
  const meta = await request('GET', `${API}/${cfg.spreadsheetId}?fields=sheets.properties.title`);
  const exists = meta.sheets?.some((s: any) => s.properties.title === cfg.sheetName);
  if (!exists) {
    await request('POST', `${API}/${cfg.spreadsheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: cfg.sheetName } } }],
    });
  }
}

async function buildValues(projectId: string, cfg: SheetsConfig) {
  const l = await loadProject(projectId);
  if (!l?.live) throw new Error('Анкета проекта не опубликована');
  const list = await responses.list(projectId, { statuses: cfg.statuses });
  const table = buildTable(l.live, list);
  const rows = cfg.values === 'labels' ? withLabels(table) : table.rows;
  return {
    header: table.vars.map((v) => v.name),
    rows: rows.map((r) => r.map((c, i) => cellToText(table.vars[i], c))),
    ids: list.map((r) => r.id),
  };
}

/** Полная перезапись листа */
export async function fullSync(projectId: string, cfg: SheetsConfig): Promise<number> {
  await ensureSheet(cfg);
  const { header, rows } = await buildValues(projectId, cfg);
  await request('POST', `${API}/${cfg.spreadsheetId}/values/${range(cfg.sheetName, 'A:ZZZ')}:clear`, {});
  await request('PUT', `${API}/${cfg.spreadsheetId}/values/${range(cfg.sheetName, 'A1')}?valueInputOption=RAW`, {
    values: [header, ...rows],
  });
  return rows.length;
}

/** Дописывает одного респондента; если структура столбцов изменилась — перезаписывает лист целиком */
async function appendOne(projectId: string, responseId: string, cfg: SheetsConfig): Promise<void> {
  await ensureSheet(cfg);
  const { header, rows, ids } = await buildValues(projectId, cfg);
  const idx = ids.indexOf(responseId);
  if (idx < 0) return;
  const current = await request('GET', `${API}/${cfg.spreadsheetId}/values/${range(cfg.sheetName, '1:1')}`);
  const currentHeader: string[] = current.values?.[0] ?? [];
  if (currentHeader.join('\u0001') !== header.join('\u0001')) {
    await fullSync(projectId, cfg);
    return;
  }
  await request(
    'POST',
    `${API}/${cfg.spreadsheetId}/values/${range(cfg.sheetName, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: [rows[idx]] },
  );
}

// Очередь по анкетам — записи в одну таблицу идут последовательно
const queues = new Map<string, Promise<void>>();

export function queueResponseSync(projectId: string, responseId: string): void {
  const prev = queues.get(projectId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const cfg = (await projects.get(projectId))?.sheets;
    if (!cfg?.auto || !cfg.spreadsheetId) return;
    const r = await responses.get(responseId);
    if (!r || r.isTest || !cfg.statuses.includes(r.status)) return;
    try {
      await appendOne(projectId, responseId, cfg);
      await projects.setSheets(projectId, { ...cfg, lastSyncAt: new Date().toISOString(), lastError: null });
    } catch (e) {
      console.error(`[sheets] ${projectId}:`, e);
      await projects.setSheets(projectId, { ...cfg, lastError: (e as Error).message });
    }
  });
  queues.set(projectId, next);
}

export function queueFullSync(projectId: string, cfg: SheetsConfig): Promise<number> {
  const prev = queues.get(projectId) ?? Promise.resolve();
  const result = prev.then(() => fullSync(projectId, cfg));
  queues.set(projectId, result.then(() => undefined, () => undefined));
  return result;
}
