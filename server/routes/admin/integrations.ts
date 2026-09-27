// Интеграции проекта: уведомления (вебхук, Telegram) и Google Sheets
import type { FastifyInstance } from 'fastify';
import { projects, type NotifyConfig, type SheetsConfig } from '../../db.ts';
import { projectOf } from '../../projectCtx.ts';
import { send } from '../../notify.ts';
import { queueFullSync } from '../../sheets.ts';
import { fail, pickStatuses } from '../../http.ts';

export async function integrationsRoutes(app: FastifyInstance) {
  app.put<{ Params: { id: string }; Body: Partial<NotifyConfig> | null }>('/api/admin/projects/:id/notify', async (req) => {
    const p = await projectOf(req.params.id);
    const b = req.body ?? {};
    const webhookUrl = String(b.webhookUrl ?? '').trim() || undefined;
    if (webhookUrl && !/^https?:\/\/\S+$/i.test(webhookUrl)) fail(400, 'Адрес вебхука должен начинаться с http:// или https://');
    const telegramChatId = String(b.telegramChatId ?? '').trim() || undefined;
    if (telegramChatId && !/^(-?\d+|@\w{4,})$/.test(telegramChatId)) fail(400, 'ID чата Telegram: число (например, -1001234567890) или @имя_канала');
    const everyN = Math.max(0, Math.round(Number(b.everyN) || 0)) || undefined;
    const cfg: NotifyConfig | null = webhookUrl || telegramChatId
      ? { webhookUrl, telegramChatId, everyN, quotaFull: !!b.quotaFull, limitReached: !!b.limitReached, lastError: p.notify?.lastError ?? null, lastSentAt: p.notify?.lastSentAt }
      : null;
    await projects.setNotify(p.id, cfg);
    return { ok: true, notify: cfg };
  });

  app.post<{ Params: { id: string } }>('/api/admin/projects/:id/notify/test', async (req) => {
    const p = await projects.get(req.params.id);
    if (!p?.notify) fail(400, 'Сначала сохраните вебхук или чат Telegram');
    const error = await send(p.id, p.title, p.notify, { kind: 'test' });
    if (error) fail(502, error);
    return { ok: true };
  });

  app.put<{ Params: { id: string }; Body: Partial<SheetsConfig> | null }>('/api/admin/projects/:id/sheets', async (req) => {
    const p = await projectOf(req.params.id);
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
      statuses: pickStatuses(req.body.statuses) ?? ['completed'],
      values: req.body.values === 'codes' ? 'codes' : 'labels',
      lastSyncAt: p.sheets?.lastSyncAt,
      lastError: p.sheets?.lastError ?? null,
    };
    await projects.setSheets(p.id, cfg);
    return { ok: true, sheets: cfg };
  });

  app.post<{ Params: { id: string } }>('/api/admin/projects/:id/sheets/sync', async (req) => {
    const p = await projects.get(req.params.id);
    if (!p?.sheets) fail(400, 'Google Sheets не настроен для этого проекта');
    try {
      const n = await queueFullSync(p.id, p.sheets);
      await projects.setSheets(p.id, { ...p.sheets, lastSyncAt: new Date().toISOString(), lastError: null });
      return { rows: n };
    } catch (e) {
      await projects.setSheets(p.id, { ...p.sheets, lastError: (e as Error).message });
      fail(502, (e as Error).message);
    }
  });
}
