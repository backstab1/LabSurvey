// Отчёт: распределения ответов по вопросам (топлайн) и где респонденты бросают анкету.
import { allOptions, allQuestions, allRows } from './logic.ts';
import type { Question, Survey } from './types.ts';
import type { ResponseRecord } from './variables.ts';

export interface ReportRow {
  code?: number;
  label: string;
  count: number;
  /** Доля от ответивших на вопрос, 0–100 */
  pct: number;
}

export interface QuestionReport {
  id: string;
  type: Question['type'];
  text: string;
  /** Сколько респондентов ответили */
  n: number;
  /** Варианты / точки шкалы; для multi pct — доля ответивших, выбравших вариант */
  rows?: ReportRow[];
  /** Матрица: распределение по столбцам для каждой строки */
  matrix?: { label: string; n: number; cells: ReportRow[] }[];
  /** Числа и шкалы */
  stats?: { mean: number; median?: number; min?: number; max?: number };
  nps?: { score: number; promoters: number; passives: number; detractors: number };
  /** Ранжирование: средний ранг варианта (меньше — важнее) */
  ranks?: { label: string; mean: number; first: number; n: number }[];
  /** Открытые ответы и «Другое» — последние по времени */
  texts?: string[];
}

export interface DropOff {
  id: string;
  text: string;
  count: number;
}

export interface Report {
  total: number;
  questions: QuestionReport[];
  /** Незавершённые и досрочно завершённые: на каком вопросе остановились */
  dropOff: DropOff[];
}

const pct = (x: number, n: number) => (n ? Math.round((x / n) * 1000) / 10 : 0);
const round = (x: number) => Math.round(x * 100) / 100;
const TEXTS = 30;

function median(sorted: number[]): number {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Строит отчёт по выбранным ответам (обычно — завершённым) */
export function buildReport(survey: Survey, responses: ResponseRecord[], unfinished: (ResponseRecord & { lastPage: string | null })[] = []): Report {
  // Новые ответы первыми — для списков открытых ответов
  const list = [...responses].sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));
  const questions: QuestionReport[] = [];

  for (const q of allQuestions(survey)) {
    if (q.type === 'info') continue;
    const answered = list.filter((r) => {
      const v = r.answers[q.id]?.v;
      return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    });
    const n = answered.length;
    const rep: QuestionReport = { id: q.id, type: q.type, text: q.text, n };
    const others = (codes: number[]) => answered
      .flatMap((r) => codes.map((c) => r.answers[q.id]?.o?.[String(c)]).filter((t): t is string => !!t))
      .slice(0, TEXTS);

    switch (q.type) {
      case 'single':
      case 'dropdown':
      case 'multi': {
        const opts = allOptions(survey, q).filter((o) => !o.group);
        rep.rows = opts.map((o) => {
          const count = answered.filter((r) => {
            const v = r.answers[q.id].v;
            return Array.isArray(v) ? v.includes(o.code) : v === o.code;
          }).length;
          return { code: o.code, label: o.text, count, pct: pct(count, n) };
        });
        const otherCodes = opts.filter((o) => o.other).map((o) => o.code);
        if (otherCodes.length) rep.texts = others(otherCodes);
        break;
      }
      case 'ranking': {
        const opts = allOptions(survey, q).filter((o) => !o.group);
        rep.ranks = opts.map((o) => {
          const places = answered.map((r) => (r.answers[q.id].v as number[]).indexOf(o.code)).filter((i) => i >= 0);
          return {
            label: o.text, n: places.length, first: places.filter((i) => i === 0).length,
            mean: places.length ? round(places.reduce((a, b) => a + b + 1, 0) / places.length) : 0,
          };
        }).sort((a, b) => (a.n && b.n ? a.mean - b.mean : b.n - a.n));
        break;
      }
      case 'scale': {
        const values = answered.map((r) => r.answers[q.id].v as number);
        const points = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
        rep.rows = [
          ...points.map((p) => {
            const count = values.filter((v) => v === p).length;
            return { code: p, label: q.labels?.[String(p)] ? `${p} — ${q.labels[String(p)]}` : String(p), count, pct: pct(count, n) };
          }),
          ...(q.extraOptions ?? []).map((o) => {
            const count = values.filter((v) => v === o.code).length;
            return { code: o.code, label: o.text, count, pct: pct(count, n) };
          }),
        ];
        const inScale = values.filter((v) => v >= q.from && v <= q.to).sort((a, b) => a - b);
        if (inScale.length) {
          rep.stats = { mean: round(inScale.reduce((a, b) => a + b, 0) / inScale.length), median: median(inScale) };
        }
        if (q.from === 0 && q.to === 10 && inScale.length) {
          const promoters = pct(inScale.filter((v) => v >= 9).length, inScale.length);
          const detractors = pct(inScale.filter((v) => v <= 6).length, inScale.length);
          rep.nps = { score: Math.round(promoters - detractors), promoters, detractors, passives: round(100 - promoters - detractors) };
        }
        break;
      }
      case 'number': {
        const values = answered.map((r) => r.answers[q.id].v as number).filter((v) => typeof v === 'number').sort((a, b) => a - b);
        if (values.length) {
          rep.stats = {
            mean: round(values.reduce((a, b) => a + b, 0) / values.length), median: median(values),
            min: values[0], max: values[values.length - 1],
          };
        }
        break;
      }
      case 'matrix': {
        const rows = allRows(survey, q).filter((r) => !r.group);
        rep.matrix = rows.map((row) => {
          const inRow = answered.filter((r) => {
            const x = (r.answers[q.id].v as Record<string, number | number[]>)[String(row.code)];
            return x !== undefined && !(Array.isArray(x) && !x.length);
          });
          return {
            label: row.text, n: inRow.length,
            cells: q.columns.map((c) => {
              const count = inRow.filter((r) => {
                const x = (r.answers[q.id].v as Record<string, number | number[]>)[String(row.code)];
                return Array.isArray(x) ? x.includes(c.code) : x === c.code;
              }).length;
              return { code: c.code, label: c.text, count, pct: pct(count, inRow.length) };
            }),
          };
        });
        const otherRows = rows.filter((r) => r.other).map((r) => r.code);
        if (otherRows.length) rep.texts = others(otherRows);
        break;
      }
      case 'hidden': {
        // Скрытые переменные: самые частые значения
        const freq = new Map<string, number>();
        for (const r of answered) freq.set(String(r.answers[q.id].v), (freq.get(String(r.answers[q.id].v)) ?? 0) + 1);
        rep.rows = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([label, count]) => ({ label, count, pct: pct(count, n) }));
        break;
      }
      default:
        rep.texts = answered.map((r) => String(r.answers[q.id].v)).slice(0, TEXTS);
    }
    questions.push(rep);
  }

  const order = new Map(allQuestions(survey).map((q, i) => [q.id, i]));
  const drops = new Map<string, number>();
  for (const r of unfinished) if (r.lastPage) drops.set(r.lastPage, (drops.get(r.lastPage) ?? 0) + 1);
  const dropOff = [...drops.entries()]
    .filter(([id]) => order.has(id))
    .sort((a, b) => order.get(a[0])! - order.get(b[0])!)
    .map(([id, count]) => ({ id, text: allQuestions(survey)[order.get(id)!].text, count }));

  return { total: list.length, questions, dropOff };
}
