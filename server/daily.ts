// Динамика сбора по дням (в часовом поясе выгрузок): сколько начали и чем закончили
import { config } from './config.ts';
import type { ResponseStatus } from '../shared/variables.ts';

export interface DayStat {
  /** YYYY-MM-DD */
  day: string;
  started: number;
  completed: number;
  screenedOut: number;
  overquota: number;
}

/** Не больше стольких последних дней */
const MAX_DAYS = 60;

const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(iso));

/**
 * Дни от первой анкеты до сегодня (последние 60), включая пустые.
 * started — по дню начала; завершения, отсевы и сверх квоты — по дню окончания.
 */
export function dailyStats(list: { startedAt: string; completedAt: string | null; status: ResponseStatus }[], now = new Date()): DayStat[] {
  if (!list.length) return [];
  const map = new Map<string, DayStat>();
  const of = (day: string) => {
    if (!map.has(day)) map.set(day, { day, started: 0, completed: 0, screenedOut: 0, overquota: 0 });
    return map.get(day)!;
  };
  for (const r of list) {
    of(dayOf(r.startedAt)).started++;
    if (!r.completedAt) continue;
    const d = of(dayOf(r.completedAt));
    if (r.status === 'completed') d.completed++;
    else if (r.status === 'screened_out') d.screenedOut++;
    else if (r.status === 'overquota') d.overquota++;
  }
  const first = [...map.keys()].sort()[0];
  const today = dayOf(now.toISOString());
  const out: DayStat[] = [];
  // Идём по календарю от сегодня назад (полдень UTC — чтобы не споткнуться о смену дня)
  for (let t = Date.parse(`${today}T12:00:00Z`); out.length < MAX_DAYS; t -= 86400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day < first) break;
    out.push(map.get(day) ?? { day, started: 0, completed: 0, screenedOut: 0, overquota: 0 });
  }
  return out.reverse();
}
