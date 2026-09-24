// Модель переменных для выгрузки (Excel, SPSS, Google Sheets): одна строка — один респондент
import { allOptions, allRows } from './logic.ts';
import type { Answers, Survey } from './types.ts';

export type ResponseStatus = 'in_progress' | 'completed' | 'screened_out' | 'terminated';

export const STATUS_CODES: Record<ResponseStatus, number> = {
  in_progress: 0,
  completed: 1,
  screened_out: 2,
  terminated: 3,
};

export const STATUS_LABELS: Record<ResponseStatus, string> = {
  in_progress: 'Не завершён',
  completed: 'Завершён',
  screened_out: 'Отсеян',
  terminated: 'Завершён досрочно',
};

export interface ResponseRecord {
  id: string;
  status: ResponseStatus;
  answers: Answers;
  params: Record<string, string>;
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  ip: string | null;
  userAgent: string | null;
  isTest: boolean;
  version: number;
}

export type Cell = number | string | Date | null;

export interface VarDef {
  name: string;
  label: string;
  kind: 'numeric' | 'string' | 'date' | 'datetime';
  measure: 'nominal' | 'ordinal' | 'scale';
  decimals?: number;
  valueLabels?: { value: number; label: string }[];
  get: (r: ResponseRecord) => Cell;
}

const SELECTED_LABELS = [
  { value: 0, label: 'Не выбрано' },
  { value: 1, label: 'Выбрано' },
];

/** Убирает переносы строк и подстановки из подписи */
function clean(text: string): string {
  return text
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, '[$1]')
    // Разметка текста: картинки убираем, ссылки и выделение — только текст
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
}

function toDate(iso: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

export function buildVariables(survey: Survey, responses: ResponseRecord[]): VarDef[] {
  const vars: VarDef[] = [];
  const used = new Set<string>();
  const add = (v: VarDef) => {
    let name = v.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${v.name}_${i}`;
    used.add(name.toLowerCase());
    vars.push({ ...v, name });
  };

  add({ name: 'resp_id', label: 'ID ответа', kind: 'string', measure: 'nominal', get: (r) => r.id });
  add({
    name: 'status', label: 'Статус', kind: 'numeric', measure: 'nominal',
    valueLabels: (Object.keys(STATUS_CODES) as ResponseStatus[]).map((s) => ({ value: STATUS_CODES[s], label: STATUS_LABELS[s] })),
    get: (r) => STATUS_CODES[r.status],
  });
  add({ name: 'started_at', label: 'Начало', kind: 'datetime', measure: 'scale', get: (r) => toDate(r.startedAt) });
  add({ name: 'completed_at', label: 'Окончание', kind: 'datetime', measure: 'scale', get: (r) => toDate(r.completedAt) });
  add({ name: 'duration_sec', label: 'Длительность, сек', kind: 'numeric', measure: 'scale', get: (r) => r.durationSec });
  add({ name: 'ip', label: 'IP-адрес', kind: 'string', measure: 'nominal', get: (r) => r.ip });
  add({ name: 'user_agent', label: 'Браузер (User-Agent)', kind: 'string', measure: 'nominal', get: (r) => r.userAgent });
  add({ name: 'version', label: 'Версия анкеты', kind: 'numeric', measure: 'nominal', get: (r) => r.version });

  // Параметры ссылки (utm_source, src, ...) — по всем ответам
  const paramKeys = [...new Set(responses.flatMap((r) => Object.keys(r.params ?? {})))].sort();
  for (const key of paramKeys) {
    const safe = key.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50);
    add({
      name: `url_${safe}`, label: `Параметр ссылки: ${key}`, kind: 'string', measure: 'nominal',
      get: (r) => r.params?.[key] ?? null,
    });
  }

  for (const block of survey.blocks) {
    for (const q of block.questions) {
      const text = clean(q.text);
      const ans = (r: ResponseRecord) => r.answers[q.id];
      switch (q.type) {
        case 'single':
        case 'dropdown': {
          const opts = allOptions(survey, q);
          add({
            name: q.id, label: text, kind: 'numeric', measure: 'nominal',
            valueLabels: opts.map((o) => ({ value: o.code, label: clean(o.text) })),
            get: (r) => (typeof ans(r)?.v === 'number' ? (ans(r)!.v as number) : null),
          });
          for (const o of opts.filter((x) => x.other)) {
            add({
              name: `${q.id}_${o.code}_other`, label: `${text}: ${clean(o.text)} (текст)`, kind: 'string', measure: 'nominal',
              get: (r) => ans(r)?.o?.[String(o.code)] ?? null,
            });
          }
          break;
        }
        case 'multi': {
          const opts = allOptions(survey, q);
          for (const o of opts) {
            add({
              name: `${q.id}_${o.code}`, label: `${text}: ${clean(o.text)}`, kind: 'numeric', measure: 'nominal',
              valueLabels: SELECTED_LABELS,
              get: (r) => {
                const v = ans(r)?.v;
                return Array.isArray(v) ? (v.includes(o.code) ? 1 : 0) : null;
              },
            });
          }
          for (const o of opts.filter((x) => x.other)) {
            add({
              name: `${q.id}_${o.code}_other`, label: `${text}: ${clean(o.text)} (текст)`, kind: 'string', measure: 'nominal',
              get: (r) => ans(r)?.o?.[String(o.code)] ?? null,
            });
          }
          break;
        }
        case 'ranking': {
          for (const o of allOptions(survey, q)) {
            add({
              name: `${q.id}_${o.code}`, label: `${text}: ${clean(o.text)} (место)`, kind: 'numeric', measure: 'ordinal',
              get: (r) => {
                const v = ans(r)?.v;
                if (!Array.isArray(v)) return null;
                const i = v.indexOf(o.code);
                return i >= 0 ? i + 1 : null;
              },
            });
          }
          break;
        }
        case 'matrix': {
          const rows = allRows(survey, q);
          const rowVal = (r: ResponseRecord, code: number) => {
            const v = ans(r)?.v;
            return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number | number[]>)[String(code)] : undefined;
          };
          for (const row of rows) {
            if (q.mode === 'single') {
              add({
                name: `${q.id}_${row.code}`, label: `${text}: ${clean(row.text)}`, kind: 'numeric', measure: 'ordinal',
                valueLabels: q.columns.map((c) => ({ value: c.code, label: clean(c.text) })),
                get: (r) => {
                  const v = rowVal(r, row.code);
                  return typeof v === 'number' ? v : null;
                },
              });
            } else {
              for (const col of q.columns) {
                add({
                  name: `${q.id}_${row.code}_${col.code}`, label: `${text}: ${clean(row.text)} — ${clean(col.text)}`,
                  kind: 'numeric', measure: 'nominal', valueLabels: SELECTED_LABELS,
                  get: (r) => {
                    if (!ans(r)) return null;
                    const v = rowVal(r, row.code);
                    return Array.isArray(v) && v.includes(col.code) ? 1 : 0;
                  },
                });
              }
            }
            if (row.other) {
              add({
                name: `${q.id}_${row.code}_other`, label: `${text}: ${clean(row.text)} (текст)`, kind: 'string', measure: 'nominal',
                get: (r) => ans(r)?.o?.[String(row.code)] ?? null,
              });
            }
          }
          break;
        }
        case 'scale': {
          const labels = Object.entries(q.labels ?? {}).map(([k, l]) => ({ value: Number(k), label: clean(l) }));
          for (const o of q.extraOptions ?? []) labels.push({ value: o.code, label: clean(o.text) });
          add({
            name: q.id, label: text, kind: 'numeric', measure: 'ordinal',
            valueLabels: labels.length ? labels : undefined,
            get: (r) => (typeof ans(r)?.v === 'number' ? (ans(r)!.v as number) : null),
          });
          break;
        }
        case 'number':
          add({
            name: q.id, label: text, kind: 'numeric', measure: 'scale', decimals: q.decimals ?? 0,
            get: (r) => (typeof ans(r)?.v === 'number' ? (ans(r)!.v as number) : null),
          });
          break;
        case 'date':
          add({
            name: q.id, label: text, kind: 'date', measure: 'scale',
            get: (r) => (typeof ans(r)?.v === 'string' ? new Date((ans(r)!.v as string) + 'T00:00:00Z') : null),
          });
          break;
        case 'text':
        case 'phone':
          add({
            name: q.id, label: text, kind: 'string', measure: 'nominal',
            get: (r) => (typeof ans(r)?.v === 'string' ? (ans(r)!.v as string) : null),
          });
          break;
        case 'hidden':
          add({
            name: q.id, label: text || q.id, kind: q.valueType === 'number' ? 'numeric' : 'string', measure: q.valueType === 'number' ? 'scale' : 'nominal',
            decimals: q.valueType === 'number' ? 2 : undefined,
            get: (r) => {
              const v = ans(r)?.v;
              if (v === undefined || v === null || v === '') return null;
              if (q.valueType === 'number') return typeof v === 'number' ? v : isFinite(Number(v)) ? Number(v) : null;
              return typeof v === 'object' ? JSON.stringify(v) : String(v);
            },
          });
          break;
        case 'info':
          break;
      }
    }
  }
  return vars;
}

/** Значение ячейки с подписью вместо кода (для листа «Метки» в Excel) */
export function labelled(v: VarDef, cell: Cell): Cell {
  if (typeof cell !== 'number' || !v.valueLabels) return cell;
  return v.valueLabels.find((l) => l.value === cell)?.label ?? cell;
}
