import {
  END, SCREENOUT,
  type Answer, type Condition, type MatrixQuestion, type Option, type Page, type Question,
  type RespondentContext, type SimpleCondition, type Survey,
} from './types.ts';

// ---------- Справочники ----------

export function findQuestion(survey: Survey, id: string): Question | undefined {
  for (const p of survey.pages) for (const q of p.questions) if (q.id === id) return q;
  return undefined;
}

export function findPage(survey: Survey, id: string): Page | undefined {
  return survey.pages.find((p) => p.id === id);
}

export function hasOptions(q: Question): q is Extract<Question, { options: Option[] }> {
  return q.type === 'single' || q.type === 'multi' || q.type === 'dropdown';
}

// ---------- Рандомизация ----------

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle<T>(items: T[], seed: string): T[] {
  let s = hash(seed) || 1;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Перемешивает варианты; «Другое» и эксклюзивные варианты остаются в конце */
function shuffleOptions(options: Option[], seed: string): Option[] {
  const fixed = options.filter((o) => o.other || o.exclusive);
  const free = options.filter((o) => !o.other && !o.exclusive);
  return [...seededShuffle(free, seed), ...fixed];
}

// ---------- Варианты с учётом переноса ----------

/** Все возможные варианты вопроса (без фильтра переноса и рандомизации) — для выгрузки */
export function allOptions(survey: Survey, q: Question, depth = 0): Option[] {
  if (!hasOptions(q)) return [];
  if (q.optionsFrom && depth < 10) {
    const src = findQuestion(survey, q.optionsFrom.question);
    const base = src ? sourceOptions(survey, src, depth + 1) : [];
    return mergeOptions(base, q.options);
  }
  return q.options;
}

export function allRows(survey: Survey, q: MatrixQuestion, depth = 0): Option[] {
  if (q.rowsFrom && depth < 10) {
    const src = findQuestion(survey, q.rowsFrom.question);
    const base = src ? sourceOptions(survey, src, depth + 1) : [];
    return mergeOptions(base, q.rows);
  }
  return q.rows;
}

function sourceOptions(survey: Survey, src: Question, depth: number): Option[] {
  if (src.type === 'matrix') return allRows(survey, src, depth);
  // При переносе «Другое» становится обычным вариантом с текстом респондента
  return allOptions(survey, src, depth).filter((o) => !o.exclusive).map((o) => ({ code: o.code, text: o.text }));
}

/** Перенесённые варианты + собственные варианты вопроса (собственные — в конце, коды не дублируются) */
function mergeOptions(base: Option[], own: Option[]): Option[] {
  const codes = new Set(base.map((o) => o.code));
  return [...base, ...own.filter((o) => !codes.has(o.code))];
}

function selectedCodes(a: Answer | undefined): Set<number> {
  if (!a) return new Set();
  if (Array.isArray(a.v)) return new Set(a.v);
  if (typeof a.v === 'number') return new Set([a.v]);
  if (typeof a.v === 'object' && a.v !== null) {
    // матрица как источник: строки, в которых есть ответ
    return new Set(Object.keys(a.v).map(Number));
  }
  return new Set();
}

function applyFrom(ctx: RespondentContext, from: { question: string; filter: string }, own: Option[], depth: number): Option[] {
  const src = findQuestion(ctx.survey, from.question);
  if (!src) return own;
  const srcOpts = src.type === 'matrix' ? resolveRows(ctx, src, depth + 1) : resolveOptions(ctx, src, depth + 1, false);
  const ans = ctx.answers[src.id];
  const sel = selectedCodes(ans);
  const filtered = srcOpts
    .filter((o) => !o.exclusive)
    .filter((o) => from.filter === 'all' || (from.filter === 'selected' ? sel.has(o.code) : !sel.has(o.code)))
    .map((o) => {
      const otherText = o.other ? ans?.o?.[String(o.code)] : undefined;
      return { code: o.code, text: otherText ? otherText : o.text };
    });
  return mergeOptions(filtered, own);
}

/** Варианты, которые видит конкретный респондент */
export function resolveOptions(ctx: RespondentContext, q: Question, depth = 0, shuffle = true): Option[] {
  if (!hasOptions(q)) return [];
  let opts = q.optionsFrom && depth < 10 ? applyFrom(ctx, q.optionsFrom, q.options, depth) : q.options;
  if (shuffle && q.randomize) opts = shuffleOptions(opts, ctx.seed + ':' + q.id);
  return opts;
}

export function resolveRows(ctx: RespondentContext, q: MatrixQuestion, depth = 0): Option[] {
  let rows = q.rowsFrom && depth < 10 ? applyFrom(ctx, q.rowsFrom, q.rows, depth) : q.rows;
  if (q.randomizeRows) rows = shuffleOptions(rows, ctx.seed + ':' + q.id);
  return rows;
}

// ---------- Условия ----------

function cmp(a: unknown, b: unknown): number {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function same(a: unknown, b: unknown): boolean {
  return cmp(a, b) === 0;
}

function evalSimple(c: SimpleCondition, ctx: RespondentContext): boolean {
  let value: unknown;
  if (c.param !== undefined) {
    value = ctx.params[c.param];
    if (value === '') value = undefined;
  } else if (c.q) {
    const a = ctx.answers[c.q];
    value = a?.v;
    if (c.row !== undefined) {
      value = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[String(c.row)]
        : undefined;
    }
  }
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (c.op === 'answered') return !empty;
  if (c.op === 'notAnswered') return empty;
  if (empty) return false;

  const arr = Array.isArray(value) ? value : [value];
  const target = c.value;
  const targets = Array.isArray(target) ? target : [target];
  switch (c.op) {
    case 'eq': return arr.some((v) => same(v, target));
    case 'neq': return !arr.some((v) => same(v, target));
    case 'in':
    case 'containsAny': return arr.some((v) => targets.some((t) => same(v, t)));
    case 'notIn': return !arr.some((v) => targets.some((t) => same(v, t)));
    case 'contains': return arr.some((v) => same(v, target));
    case 'notContains': return !arr.some((v) => same(v, target));
    case 'containsAll': return targets.every((t) => arr.some((v) => same(v, t)));
    case 'gt': return cmp(value, target) > 0;
    case 'gte': return cmp(value, target) >= 0;
    case 'lt': return cmp(value, target) < 0;
    case 'lte': return cmp(value, target) <= 0;
    default: return false;
  }
}

export function evalCondition(c: Condition | undefined, ctx: RespondentContext): boolean {
  if (!c) return true;
  if ('all' in c) return c.all.every((x) => evalCondition(x, ctx));
  if ('any' in c) return c.any.some((x) => evalCondition(x, ctx));
  if ('not' in c) return !evalCondition(c.not, ctx);
  return evalSimple(c, ctx);
}

// ---------- Видимость и навигация ----------

export function isQuestionVisible(ctx: RespondentContext, q: Question): boolean {
  if (!evalCondition(q.showIf, ctx)) return false;
  // Перенос вариантов дал пустой список — вопрос не показываем
  if (hasOptions(q) && q.optionsFrom && resolveOptions(ctx, q, 0, false).length === 0) return false;
  if (q.type === 'matrix' && q.rowsFrom && resolveRows(ctx, q).length === 0) return false;
  return true;
}

export function visibleQuestions(ctx: RespondentContext, page: Page): Question[] {
  return page.questions.filter((q) => isQuestionVisible(ctx, q));
}

/** Страница показывается, если на ней есть хотя бы один видимый не скрытый вопрос */
export function isPageVisible(ctx: RespondentContext, page: Page): boolean {
  return evalCondition(page.showIf, ctx) && visibleQuestions(ctx, page).some((q) => q.type !== 'hidden');
}

/** Первая видимая страница начиная с индекса */
function firstVisibleFrom(ctx: RespondentContext, index: number): string {
  const pages = ctx.survey.pages;
  for (let i = index; i < pages.length; i++) if (isPageVisible(ctx, pages[i])) return pages[i].id;
  return END;
}

export function firstPage(ctx: RespondentContext): string {
  return firstVisibleFrom(ctx, 0);
}

/** Куда идти после страницы: ID страницы, END или SCREENOUT */
export function nextPage(ctx: RespondentContext, pageId: string): string {
  const pages = ctx.survey.pages;
  const idx = pages.findIndex((p) => p.id === pageId);
  if (idx < 0) return END;
  for (const j of pages[idx].jumps ?? []) {
    if (evalCondition(j.if, ctx)) {
      if (j.goTo === END || j.goTo === SCREENOUT) return j.goTo;
      const t = pages.findIndex((p) => p.id === j.goTo);
      if (t >= 0) return firstVisibleFrom(ctx, t);
    }
  }
  return firstVisibleFrom(ctx, idx + 1);
}

/** Маршрут респондента с текущими ответами (для прогресса и очистки данных) */
export function computePath(ctx: RespondentContext): { pages: string[]; end: string } {
  const seen = new Set<string>();
  const path: string[] = [];
  let cur = firstPage(ctx);
  while (cur !== END && cur !== SCREENOUT && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = nextPage(ctx, cur);
  }
  return { pages: path, end: cur === END || cur === SCREENOUT ? cur : END };
}

export function progressPercent(ctx: RespondentContext, currentPageId: string, history: string[]): number {
  const idx = ctx.survey.pages.findIndex((p) => p.id === currentPageId);
  // Оценка: пройденные страницы + оставшиеся по маршруту по умолчанию
  let remaining = 0;
  const seen = new Set<string>();
  let cur = currentPageId;
  while (cur !== END && cur !== SCREENOUT && !seen.has(cur)) {
    seen.add(cur);
    remaining++;
    cur = nextPage(ctx, cur);
  }
  const done = history.length;
  const total = done + remaining;
  if (idx < 0 || total === 0) return 0;
  return Math.round((done / total) * 100);
}

/**
 * Удаляет ответы на вопросы, которые не входят в итоговый маршрут или скрыты.
 * Маршрут проходится заново, и логика видит только уже «принятые» ответы,
 * поэтому устаревший ответ из брошенной ветки не влияет на дальнейшие переходы.
 */
export function cleanAnswers(ctx: RespondentContext, pagesVisited: string[]): typeof ctx.answers {
  const kept: typeof ctx.answers = {};
  const c: RespondentContext = { ...ctx, answers: kept };
  const visited = new Set(pagesVisited);
  const seen = new Set<string>();
  let cur = firstPage(c);
  while (cur !== END && cur !== SCREENOUT && visited.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const page = findPage(ctx.survey, cur)!;
    for (const q of page.questions) {
      if (ctx.answers[q.id] !== undefined && isQuestionVisible(c, q)) kept[q.id] = ctx.answers[q.id];
    }
    cur = nextPage(c, cur);
  }
  // Скрытые переменные не привязаны к маршруту: их задают скрипты и параметры ссылки
  for (const page of ctx.survey.pages) {
    for (const q of page.questions) {
      if (q.type === 'hidden' && ctx.answers[q.id] !== undefined) kept[q.id] = ctx.answers[q.id];
    }
  }
  return kept;
}

// ---------- Подстановка ответов (пайпинг) ----------

export function answerText(ctx: RespondentContext, q: Question, rowCode?: string): string {
  const a = ctx.answers[q.id];
  if (!a) return '';
  const label = (opts: Option[], code: number) => {
    const o = opts.find((x) => x.code === code);
    if (!o) return String(code);
    return o.other && a.o?.[String(code)] ? a.o[String(code)] : o.text;
  };
  switch (q.type) {
    case 'single':
    case 'dropdown':
      return typeof a.v === 'number' ? label(resolveOptions(ctx, q, 0, false), a.v) : '';
    case 'multi':
      return Array.isArray(a.v) ? a.v.map((c) => label(resolveOptions(ctx, q, 0, false), c)).join(', ') : '';
    case 'scale': {
      if (typeof a.v !== 'number') return '';
      const extra = q.extraOptions?.find((o) => o.code === a.v);
      return extra ? extra.text : String(a.v);
    }
    case 'matrix': {
      if (typeof a.v !== 'object' || Array.isArray(a.v) || a.v === null) return '';
      const colLabel = (c: number) => q.columns.find((x) => x.code === c)?.text ?? String(c);
      const rowVal = (rv: number | number[]) => (Array.isArray(rv) ? rv.map(colLabel).join(', ') : colLabel(rv));
      const v = a.v as Record<string, number | number[]>;
      if (rowCode !== undefined) return v[rowCode] !== undefined ? rowVal(v[rowCode]) : '';
      const rows = resolveRows(ctx, q);
      return Object.entries(v)
        .map(([r, rv]) => `${rows.find((x) => String(x.code) === r)?.text ?? r}: ${rowVal(rv)}`)
        .join('; ');
    }
    default:
      return String(a.v ?? '');
  }
}

/** Заменяет {{Q1}}, {{Q5.2}} (строка матрицы), {{param.src}} на значения */
export function pipe(text: string, ctx: RespondentContext): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([A-Za-z][\w]*)(?:\.([\w]+))?\s*\}\}/g, (_m, id: string, sub?: string) => {
    if (id === 'param' && sub) return ctx.params[sub] ?? '';
    const q = findQuestion(ctx.survey, id);
    if (!q) return '';
    return answerText(ctx, q, sub);
  });
}
