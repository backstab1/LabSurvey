// Уведомления о ходе сбора: POST-вебхук (JSON) и/или сообщение в Telegram.
// Отправляются в фоне и не задерживают респондента; ошибка сохраняется в настройках анкеты.
import { config } from './config.ts';
import { projects, responses, type NotifyConfig, type StoredResponse } from './db.ts';
import { quotaCounts } from './quotas.ts';
import { evalCondition } from '../shared/logic.ts';
import { settingsOf, type RespondentContext, type Survey } from '../shared/types.ts';

export type NotifyEvent =
  | { kind: 'completed'; count: number; response?: Pick<StoredResponse, 'id' | 'status' | 'answers' | 'params' | 'durationSec' | 'completedAt'> }
  | { kind: 'quota_full'; quota: { id: string; title?: string; limit: number } }
  | { kind: 'limit_reached'; limit: number }
  | { kind: 'test' };

export const telegramConfigured = () => !!config.telegramBotToken;

function message(title: string, e: NotifyEvent): string {
  switch (e.kind) {
    case 'completed': return `«${title}»: завершено анкет — ${e.count}`;
    case 'quota_full': return `«${title}»: квота «${e.quota.title || e.quota.id}» набрана (${e.quota.limit})`;
    case 'limit_reached': return `«${title}»: набран лимит ${e.limit} анкет — сбор для новых респондентов закрыт`;
    case 'test': return `«${title}»: тестовое уведомление SurveyLAB`;
  }
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Отправить событие по всем настроенным каналам. Возвращает текст ошибки или null */
export async function send(projectId: string, title: string, cfg: NotifyConfig, e: NotifyEvent): Promise<string | null> {
  const errors: string[] = [];
  if (cfg.webhookUrl) {
    try {
      await post(cfg.webhookUrl, { event: e.kind, survey: { id: projectId, title }, project: { id: projectId, title }, text: message(title, e), ...e, kind: undefined });
    } catch (err) { errors.push(`вебхук: ${(err as Error).message}`); }
  }
  if (cfg.telegramChatId) {
    if (!config.telegramBotToken) errors.push('Telegram: не задан TELEGRAM_BOT_TOKEN в .env');
    else {
      try {
        await post(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, { chat_id: cfg.telegramChatId, text: message(title, e) });
      } catch (err) { errors.push(`Telegram: ${(err as Error).message}`); }
    }
  }
  const error = errors.length ? errors.join('; ') : null;
  await projects.setNotify(projectId, { ...cfg, lastError: error, lastSentAt: new Date().toISOString() });
  return error;
}

/** События после сохранения завершённой (не тестовой) анкеты */
export async function afterComplete(projectId: string, survey: Survey, r: StoredResponse, ctx: RespondentContext): Promise<void> {
  const row = await projects.get(projectId);
  const cfg = row?.notify;
  if (!cfg || (!cfg.webhookUrl && !cfg.telegramChatId)) return;
  const events: NotifyEvent[] = [];
  const count = (await responses.counts(projectId)).real.completed ?? 0;
  if (cfg.everyN && count % cfg.everyN === 0) {
    events.push({
      kind: 'completed', count,
      // Ответы — только во вебхук: в Telegram уходит лишь счётчик
      response: { id: r.id, status: r.status, answers: ctx.answers, params: r.params, durationSec: r.durationSec, completedAt: r.completedAt },
    });
  }
  if (cfg.quotaFull && survey.quotas?.length) {
    const counts = await quotaCounts(projectId, survey, false);
    for (const q of survey.quotas) {
      if (evalCondition(q.if, ctx) && counts.get(q.id) === q.limit) events.push({ kind: 'quota_full', quota: { id: q.id, title: q.title, limit: q.limit } });
    }
  }
  const limit = settingsOf(survey).maxResponses;
  if (cfg.limitReached && limit && count === limit) events.push({ kind: 'limit_reached', limit });
  for (const e of events) await send(projectId, survey.title, cfg, e);
}
