// Квоты: подсчёт завершённых анкет по условиям и проверка, не набран ли лимит.
// Счётчики держатся в памяти и пересчитываются из базы, когда меняются условия квот или удаляются ответы.
import { responses } from './db.ts';
import { evalCondition } from '../shared/logic.ts';
import type { Quota, RespondentContext, Survey } from '../shared/types.ts';

const cache = new Map<string, Map<string, number>>();

const keyOf = (projectId: string, survey: Survey, isTest: boolean) =>
  `${projectId}:${isTest ? 'test' : 'live'}:${JSON.stringify(survey.quotas ?? [])}`;

/** Сколько завершённых анкет попало в каждую квоту */
export async function quotaCounts(projectId: string, survey: Survey, isTest: boolean): Promise<Map<string, number>> {
  const key = keyOf(projectId, survey, isTest);
  let counts = cache.get(key);
  if (!counts) {
    counts = new Map((survey.quotas ?? []).map((q) => [q.id, 0]));
    const done = (await responses.list(projectId, { includeTest: isTest, statuses: ['completed'] })).filter((r) => r.isTest === isTest);
    for (const r of done) {
      const ctx: RespondentContext = { survey, answers: r.answers, params: r.params, seed: r.id };
      for (const q of survey.quotas ?? []) if (evalCondition(q.if, ctx)) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
    }
    // Старые ключи этого проекта (прежние условия) больше не нужны
    for (const k of cache.keys()) if (k.startsWith(`${projectId}:${isTest ? 'test' : 'live'}:`)) cache.delete(k);
    cache.set(key, counts);
  }
  return counts;
}

/** Первая квота, под которую подходит респондент и лимит которой уже набран */
export async function fullQuota(projectId: string, survey: Survey, isTest: boolean, ctx: RespondentContext): Promise<Quota | null> {
  if (!survey.quotas?.length) return null;
  const matching = survey.quotas.filter((q) => evalCondition(q.if, ctx));
  if (!matching.length) return null;
  const counts = await quotaCounts(projectId, survey, isTest);
  return matching.find((q) => (counts.get(q.id) ?? 0) >= q.limit) ?? null;
}

/** Учесть только что сохранённую завершённую анкету (если счётчиков ещё нет, их посчитают из базы вместе с ней) */
export function noteCompleted(projectId: string, survey: Survey, isTest: boolean, ctx: RespondentContext): void {
  const counts = cache.get(keyOf(projectId, survey, isTest));
  if (!counts || !survey.quotas?.length) return;
  for (const q of survey.quotas) if (evalCondition(q.if, ctx)) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
}

/** Ответы удалены — пересчитать при следующем обращении */
export function resetQuotas(projectId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${projectId}:`)) cache.delete(k);
}
