// Таблицы (кросс-таблицы): строки — вопросы, столбцы — «шапка» из вопросов и параметров ссылки.
// Проценты по столбцу и строке, база, средние; значимость различий между столбцами одной шапки — буквами.
import { allOptions, allQuestions, allRows, findQuestion } from './logic.ts';
import type { Condition, Question, Survey } from './types.ts';
import type { ResponseRecord, ResponseStatus } from './variables.ts';

/** Переменная таблицы: вопрос, строка матрицы или параметр ссылки */
export interface VarRef { q?: string; row?: number; param?: string }

export interface CrosstabSpec {
  rows: VarRef[];
  cols: VarRef[];
  statuses?: ResponseStatus[];
  filter?: Condition;
  test?: boolean;
  /** Уровень значимости: 0.9, 0.95 (по умолчанию), 0.99; 0 — не проверять */
  sig?: number;
}

export interface CrossColumn {
  /** Название шапки (вопроса); у «Всего» — пусто */
  banner: string;
  label: string;
  /** Буква столбца для значимости (у «Всего» — пусто) */
  letter: string;
  /** Номер шапки (0 — «Всего»): значимость проверяется только внутри одной шапки */
  group: number;
  base: number;
}

export interface CrossCell { count: number; colPct: number; rowPct: number; sig: string }
export interface CrossStat { label: string; cells: { value: number | null; sig: string }[] }

export interface CrossTable {
  key: string;
  title: string;
  /** Несколько ответов — сумма процентов по столбцу больше 100 */
  multi: boolean;
  columns: CrossColumn[];
  rows: { label: string; cells: CrossCell[] }[];
  /** Для чисел и шкал: среднее и т. п. */
  stats?: CrossStat[];
}

export interface CrosstabResult {
  total: number;
  tables: CrossTable[];
  /** Параметры ссылки, встречающиеся в ответах — для выбора в шапку */
  params: string[];
  /** Минимальная база для проверки значимости */
  minBase: number;
}

interface Category { key: string; label: string }

interface VarModel {
  key: string;
  title: string;
  multi: boolean;
  categories: Category[];
  /** Категории респондента; null — не отвечал (не входит в базу) */
  cats: (r: ResponseRecord) => string[] | null;
  /** Числовое значение для средних (числа, шкалы) */
  num?: (r: ResponseRecord) => number | null;
}

const MIN_BASE = 10;
const MAX_DISTINCT = 40;

const plain = (text: string) => text
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/\s+/g, ' ').trim();
const title = (q: Question) => `${q.id}. ${plain(q.text)}`.slice(0, 200);
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** Категории по встречающимся значениям (текст, дата, параметры): по частоте, остальное — «Другие значения» */
function distinct(key: string, titleText: string, get: (r: ResponseRecord) => string | null, responses: ResponseRecord[]): VarModel {
  const freq = new Map<string, number>();
  for (const r of responses) {
    const v = get(r);
    if (v !== null && v !== '') freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).slice(0, MAX_DISTINCT).map(([v]) => v);
  const known = new Set(top);
  const categories = top.map((v) => ({ key: v, label: v }));
  if (freq.size > top.length) categories.push({ key: '\u0000other', label: 'Другие значения' });
  return {
    key, title: titleText, multi: false, categories,
    cats: (r) => {
      const v = get(r);
      if (v === null || v === '') return null;
      return [known.has(v) ? v : '\u0000other'];
    },
  };
}

/** Модели переменных по ссылке; матрица без строки — по одной модели на каждую строку */
export function varModels(survey: Survey, ref: VarRef, responses: ResponseRecord[]): VarModel[] {
  if (ref.param) {
    const p = ref.param;
    return [distinct(`param.${p}`, `Параметр ссылки: ${p}`, (r) => r.params?.[p] ?? null, responses)];
  }
  const q = ref.q ? findQuestion(survey, ref.q) : undefined;
  if (!q || q.type === 'info') return [];
  const ans = (r: ResponseRecord) => r.answers[q.id]?.v;

  switch (q.type) {
    case 'single':
    case 'dropdown':
    case 'multi':
    case 'ranking': {
      const opts = allOptions(survey, q).filter((o) => !o.group);
      const known = new Set(opts.map((o) => String(o.code)));
      return [{
        key: q.id, title: q.type === 'ranking' ? `${title(q)} — на первом месте` : title(q), multi: q.type === 'multi',
        categories: opts.map((o) => ({ key: String(o.code), label: plain(o.text) })),
        cats: (r) => {
          const v = ans(r);
          if (empty(v)) return null;
          const codes = q.type === 'ranking' ? [(v as number[])[0]] : Array.isArray(v) ? v : [v as number];
          const keys = codes.map(String).filter((c) => known.has(c));
          return keys.length ? keys : null;
        },
      }];
    }
    case 'scale': {
      const cats: Category[] = [];
      for (let i = q.from; i <= q.to; i++) cats.push({ key: String(i), label: q.labels?.[String(i)] ? `${i} — ${plain(q.labels[String(i)])}` : String(i) });
      for (const o of q.extraOptions ?? []) cats.push({ key: String(o.code), label: plain(o.text) });
      const inScale = (v: unknown) => typeof v === 'number' && v >= q.from && v <= q.to;
      return [{
        key: q.id, title: title(q), multi: false, categories: cats,
        cats: (r) => (empty(ans(r)) ? null : [String(ans(r))]),
        num: (r) => (inScale(ans(r)) ? (ans(r) as number) : null),
      }];
    }
    case 'number':
      return [{
        key: q.id, title: title(q), multi: false, categories: [],
        cats: (r) => (typeof ans(r) === 'number' ? [] : null),
        num: (r) => (typeof ans(r) === 'number' ? (ans(r) as number) : null),
      }];
    case 'matrix': {
      const rows = allRows(survey, q).filter((x) => !x.group && !x.other);
      const picked = ref.row !== undefined ? rows.filter((x) => x.code === ref.row) : rows;
      const cols = q.columns.map((c) => ({ key: String(c.code), label: plain(c.text) }));
      return picked.map((row) => ({
        key: `${q.id}.${row.code}`, title: `${title(q)} — ${plain(row.text)}`, multi: q.mode === 'multi', categories: cols,
        cats: (r) => {
          const v = ans(r);
          if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
          const x = (v as Record<string, number | number[]>)[String(row.code)];
          if (empty(x)) return null;
          return (Array.isArray(x) ? x : [x]).map(String);
        },
      }));
    }
    default: {
      // Текст, телефон, дата, скрытая переменная — по встречающимся значениям
      return [distinct(q.id, title(q), (r) => {
        const v = ans(r);
        return empty(v) || typeof v === 'object' ? null : String(v);
      }, responses)];
    }
  }
}

/** Z-критерий для двусторонней проверки */
const Z: Record<string, number> = { '0.9': 1.645, '0.95': 1.96, '0.99': 2.576 };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sd(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function medianOf(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Все таблицы по спецификации для уже отобранных ответов */
export function buildCrosstabs(survey: Survey, spec: CrosstabSpec, responses: ResponseRecord[]): CrosstabResult {
  const z = spec.sig === 0 ? 0 : Z[String(spec.sig ?? 0.95)] ?? Z['0.95'];

  // Шапка: «Всего» и столбцы каждого баннера
  const banners = spec.cols.flatMap((ref) => varModels(survey, ref, responses));
  interface Col extends CrossColumn { member: (r: ResponseRecord) => boolean }
  const columns: Col[] = [{ banner: '', label: 'Всего', letter: '', group: 0, base: 0, member: () => true }];
  banners.forEach((b, gi) => {
    b.categories.forEach((c, i) => columns.push({
      banner: b.title, label: c.label, letter: LETTERS[i] ?? String(i + 1), group: gi + 1, base: 0,
      member: (r) => b.cats(r)?.includes(c.key) ?? false,
    }));
  });
  const membership = responses.map((r) => columns.map((c) => c.member(r)));

  const tables: CrossTable[] = [];
  for (const ref of spec.rows) {
    for (const v of varModels(survey, ref, responses)) {
      const answered = responses.map((r) => v.cats(r));
      const cols: CrossColumn[] = columns.map((c, ci) => ({
        banner: c.banner, label: c.label, letter: c.letter, group: c.group,
        base: answered.filter((a, ri) => a !== null && membership[ri][ci]).length,
      }));
      const rows = v.categories.map((cat) => {
        const counts = columns.map((_, ci) => answered.filter((a, ri) => a?.includes(cat.key) && membership[ri][ci]).length);
        return {
          label: cat.label,
          cells: counts.map((count, ci) => ({
            count,
            colPct: cols[ci].base ? round1((count / cols[ci].base) * 100) : 0,
            rowPct: counts[0] ? round1((count / counts[0]) * 100) : 0,
            sig: '',
          })),
        };
      });
      // Значимость долей: столбец получает буквы тех столбцов своей шапки, где доля значимо ниже
      if (z) {
        for (const row of rows) {
          row.cells.forEach((cell, i) => {
            const a = cols[i];
            if (!a.group || a.base < MIN_BASE) return;
            const letters: string[] = [];
            cols.forEach((b, j) => {
              if (j === i || b.group !== a.group || b.base < MIN_BASE) return;
              const p1 = cell.count / a.base;
              const p2 = row.cells[j].count / b.base;
              const p = (cell.count + row.cells[j].count) / (a.base + b.base);
              const se = Math.sqrt(p * (1 - p) * (1 / a.base + 1 / b.base));
              if (se > 0 && (p1 - p2) / se > z) letters.push(b.letter);
            });
            cell.sig = letters.join('');
          });
        }
      }

      let stats: CrossStat[] | undefined;
      if (v.num) {
        const values = columns.map((_, ci) => responses
          .map((r, ri) => (membership[ri][ci] ? v.num!(r) : null)).filter((x): x is number => x !== null));
        const meanCells = values.map((xs) => ({ value: xs.length ? round2(mean(xs)) : null, sig: '' }));
        if (z) {
          meanCells.forEach((cell, i) => {
            const a = cols[i];
            if (!a.group || values[i].length < MIN_BASE) return;
            const letters: string[] = [];
            cols.forEach((b, j) => {
              if (j === i || b.group !== a.group || values[j].length < MIN_BASE) return;
              const se = Math.sqrt(sd(values[i]) ** 2 / values[i].length + sd(values[j]) ** 2 / values[j].length);
              if (se > 0 && (mean(values[i]) - mean(values[j])) / se > z) letters.push(b.letter);
            });
            cell.sig = letters.join('');
          });
        }
        stats = [
          { label: 'Среднее', cells: meanCells },
          { label: 'Медиана', cells: values.map((xs) => ({ value: xs.length ? round2(medianOf(xs)) : null, sig: '' })) },
          { label: 'Стандартное отклонение', cells: values.map((xs) => ({ value: xs.length > 1 ? round2(sd(xs)) : null, sig: '' })) },
          { label: 'Ответили (для среднего)', cells: values.map((xs) => ({ value: xs.length, sig: '' })) },
        ];
      }
      tables.push({ key: v.key, title: v.title, multi: v.multi, columns: cols, rows, ...(stats ? { stats } : {}) });
    }
  }

  const params = [...new Set(responses.flatMap((r) => Object.keys(r.params ?? {})))].sort();
  return { total: responses.length, tables, params, minBase: MIN_BASE };
}

/** Вопросы, которые можно поставить в строки и в шапку */
export function crosstabCandidates(survey: Survey) {
  const qs = allQuestions(survey).filter((q) => q.type !== 'info');
  return {
    rows: qs,
    // В шапку — только вопросы с вариантами (и строки матрицы) и скрытые переменные
    cols: qs.filter((q) => ['single', 'dropdown', 'multi', 'scale', 'matrix', 'hidden', 'ranking'].includes(q.type)),
  };
}
