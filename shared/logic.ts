import {
  END, SCREENOUT,
  type Action, type Answer, type Answers, type AnswerValue, type Block, type Condition, type MatrixQuestion, type Option, type Page,
  type Question, type RespondentContext, type SimpleCondition, type Survey,
} from './types.ts';
import { calcValue } from './calc.ts';
import { expandAllLoops, expandLoops, hasLoops, loopBase } from './loops.ts';

// ---------- Справочники ----------

/** Все вопросы анкеты по порядку */
export function allQuestions(survey: Survey): Question[] {
  return survey.blocks.flatMap((b) => b.questions);
}

const screensCache = new WeakMap<Survey, Page[]>();

/** Экраны опроса: по одному вопросу на экран, ID экрана = ID вопроса */
export function pagesOf(survey: Survey): Page[] {
  let pages = screensCache.get(survey);
  if (!pages) {
    pages = allQuestions(survey).map((q) => ({ id: q.id, questions: [q] }));
    screensCache.set(survey, pages);
  }
  return pages;
}

export function findQuestion(survey: Survey, id: string): Question | undefined {
  for (const b of survey.blocks) for (const q of b.questions) if (q.id === id) return q;
  return undefined;
}

export function findPage(survey: Survey, id: string): Page | undefined {
  return pagesOf(survey).find((p) => p.id === id);
}

/** Блок, в котором находится вопрос */
export function blockOf(survey: Survey, questionId: string): Block | undefined {
  return survey.blocks.find((b) => b.questions.some((q) => q.id === questionId));
}

export function hasOptions(q: Question): q is Extract<Question, { options: Option[] }> {
  return q.type === 'single' || q.type === 'multi' || q.type === 'dropdown' || q.type === 'ranking';
}

// ---------- Рандомизация ----------

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededShuffle<T>(items: T[], seed: string): T[] {
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

/**
 * Перемешивает или сдвигает варианты. «Другое» и эксклюзивные варианты остаются в конце,
 * закреплённые (fixed) — на своих местах.
 */
function orderOptions(options: Option[], seed: string, order: 'random' | 'rotate' | undefined): Option[] {
  if (!order) return options;
  const tail = options.filter((o) => o.other || o.exclusive);
  const body = options.filter((o) => !o.other && !o.exclusive);
  const free = body.filter((o) => !o.fixed);
  let moved: Option[];
  if (order === 'random') moved = seededShuffle(free, seed);
  else {
    const shift = free.length ? hash(seed) % free.length : 0;
    moved = [...free.slice(shift), ...free.slice(0, shift)];
  }
  let k = 0;
  return [...body.map((o) => (o.fixed ? o : moved[k++])), ...tail];
}

const shown = (list: Option[]) => (list.some((o) => o.hidden) ? list.filter((o) => !o.hidden) : list);

// ---------- Порядок экранов у респондента ----------

const orderCache = new WeakMap<Survey, Map<string, Page[]>>();

/**
 * Экраны в том порядке, в котором их видит респондент: вопросы блоков с order перемешаны
 * (стабильно для одного респондента), закреплённые вопросы (fixed) остаются на местах.
 */
export function pagesFor(ctx: RespondentContext): Page[] {
  const { survey, seed } = ctx;
  if (!survey.blocks.some((b) => b.order)) return pagesOf(survey);
  let bySeed = orderCache.get(survey);
  if (!bySeed) orderCache.set(survey, (bySeed = new Map()));
  let pages = bySeed.get(seed);
  if (!pages) {
    const byId = new Map(pagesOf(survey).map((pg) => [pg.id, pg]));
    pages = survey.blocks.flatMap((b) => {
      let qs = b.questions;
      if (b.order) {
        // Скрытые переменные не видны респонденту — не участвуют в перемешивании
        const free = qs.filter((q) => !q.fixed && q.type !== 'hidden');
        const moved = b.order === 'random'
          ? seededShuffle(free, `${seed}:block:${b.id}`)
          : (() => { const s = free.length ? hash(`${seed}:block:${b.id}`) % free.length : 0; return [...free.slice(s), ...free.slice(0, s)]; })();
        let k = 0;
        qs = qs.map((q) => (q.fixed || q.type === 'hidden' ? q : moved[k++]));
      }
      return qs.map((q) => byId.get(q.id)!);
    });
    if (bySeed.size > 500) bySeed.clear();
    bySeed.set(seed, pages);
  }
  return pages;
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

/** Действия «перед показом», скрывающие варианты или строки */
function filterByActions(ctx: RespondentContext, q: Question, opts: Option[], depth: number): Option[] {
  for (const a of q.actions?.before ?? []) {
    if (depth > 10 || !evalCondition(a.if, ctx)) continue;
    const codes = new Set(a.codes ?? []);
    if (a.do === 'hideOptions') opts = opts.filter((o) => !codes.has(o.code));
    else if (a.do === 'showOnlyOptions') opts = opts.filter((o) => codes.has(o.code));
    else if (a.do === 'hideOptionsFrom' && a.question) {
      const sel = selectedCodes(ctx.answers[a.question]);
      opts = opts.filter((o) => (a.filter === 'notSelected' ? sel.has(o.code) : !sel.has(o.code)));
    }
  }
  return opts;
}

/** Варианты, которые видит конкретный респондент */
export function resolveOptions(ctx: RespondentContext, q: Question, depth = 0, shuffle = true): Option[] {
  if (!hasOptions(q)) return [];
  let opts = q.optionsFrom && depth < 10 ? applyFrom(ctx, q.optionsFrom, shown(q.options), depth) : shown(q.options);
  opts = filterByActions(ctx, q, opts, depth);
  if (shuffle) opts = orderOptions(opts, ctx.seed + ':' + q.id, q.order ?? (q.randomize ? 'random' : undefined));
  return opts;
}

export function resolveRows(ctx: RespondentContext, q: MatrixQuestion, depth = 0): Option[] {
  let rows = q.rowsFrom && depth < 10 ? applyFrom(ctx, q.rowsFrom, shown(q.rows), depth) : shown(q.rows);
  rows = filterByActions(ctx, q, rows, depth);
  rows = orderOptions(rows, ctx.seed + ':' + q.id, q.rowOrder ?? (q.randomizeRows ? 'random' : undefined));
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

/** Сколько вариантов (строк матрицы) видит респондент; null — у вопроса нет вариантов */
function visibleCount(ctx: RespondentContext, q: Question): number | null {
  if (hasOptions(q)) return resolveOptions(ctx, q, 0, false).length;
  if (q.type === 'matrix') return resolveRows(ctx, q).length;
  return null;
}

/**
 * Значение, которым действие «answer» отмечает вопрос без показа.
 * undefined — действие не сработало (вопрос показывается как обычно).
 */
/** Ответ из параметра ссылки для prefillParam; undefined — параметра нет или значение не подходит */
export function paramAnswer(ctx: RespondentContext, q: Question): AnswerValue | undefined {
  const raw = q.prefillParam ? ctx.params[q.prefillParam]?.trim() : undefined;
  if (!raw) return undefined;
  const num = Number(raw.replace(',', '.'));
  switch (q.type) {
    case 'single':
    case 'dropdown':
      return resolveOptions(ctx, q, 0, false).some((o) => o.code === num && !o.other) ? num : undefined;
    case 'multi': {
      const codes = raw.split(',').map((x) => Number(x.trim()));
      const allowed = new Set(resolveOptions(ctx, q, 0, false).filter((o) => !o.other).map((o) => o.code));
      return codes.length && codes.every((c) => allowed.has(c)) ? [...new Set(codes)] : undefined;
    }
    case 'scale':
      return Number.isInteger(num) && ((num >= q.from && num <= q.to) || q.extraOptions?.some((o) => o.code === num)) ? num : undefined;
    case 'number':
      return isFinite(num) && (q.min === undefined || num >= q.min) && (q.max === undefined || num <= q.max) ? num : undefined;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    case 'text':
    case 'phone':
      return raw.slice(0, 2000);
    default:
      return undefined;
  }
}

export function autoAnswerValue(ctx: RespondentContext, q: Question): AnswerValue | undefined {
  // Предзаполнение из ссылки с пропуском вопроса
  if (q.prefillSkip) {
    const v = paramAnswer(ctx, q);
    if (v !== undefined) return v;
  }
  for (const a of q.actions?.before ?? []) {
    if (a.do !== 'answer' || !evalCondition(a.if, ctx)) continue;
    if (a.value !== undefined && a.value !== '') return a.value as AnswerValue;
    // Без значения — единственный оставшийся вариант
    if (!hasOptions(q)) continue;
    const opts = resolveOptions(ctx, q, 0, false);
    if (opts.length === 1) return q.type === 'multi' ? [opts[0].code] : opts[0].code;
  }
  return undefined;
}

export function isQuestionVisible(ctx: RespondentContext, q: Question): boolean {
  if (!evalCondition(q.showIf, ctx)) return false;
  const count = visibleCount(ctx, q);
  // Все варианты скрыты (перенос или действия) — вопрос не показываем
  if (count === 0) return false;
  for (const a of q.actions?.before ?? []) {
    if (a.do === 'skipIfFewer' && count !== null && count < (a.n ?? 1) && evalCondition(a.if, ctx)) return false;
  }
  if (autoAnswerValue(ctx, q) !== undefined) return false;
  return true;
}

/** Ошибка из действия «error» после ответа (null — всё хорошо) */
export function actionError(ctx: RespondentContext, q: Question): string | null {
  for (const a of q.actions?.after ?? []) {
    if (a.do === 'error' && evalCondition(a.if, ctx)) return a.message || 'Проверьте ответ';
  }
  return null;
}

/** Значение для setValue: подстановки {{Q1}} и приведение к числу для числовых переменных */
function actionValue(ctx: RespondentContext, a: Action): AnswerValue | undefined {
  if (!a.target || a.value === undefined) return undefined;
  let v: AnswerValue = typeof a.value === 'string' ? pipe(a.value, ctx) : (a.value as AnswerValue);
  const target = findQuestion(ctx.survey, a.target);
  if (target?.type === 'hidden' && target.valueType === 'number' && typeof v === 'string') {
    const n = Number(v.replace(',', '.'));
    if (v.trim() !== '' && isFinite(n)) v = n;
  }
  return v === '' ? undefined : v;
}

export function visibleQuestions(ctx: RespondentContext, page: Page): Question[] {
  return page.questions.filter((q) => isQuestionVisible(ctx, q));
}

/** Страница показывается, если на ней есть хотя бы один видимый не скрытый вопрос */
export function isPageVisible(ctx: RespondentContext, page: Page): boolean {
  return evalCondition(page.showIf, ctx) && visibleQuestions(ctx, page).some((q) => q.type !== 'hidden');
}

/**
 * Первая видимая страница начиная с индекса. onScan вызывается для каждой просмотренной страницы
 * до проверки видимости — так действия «перед показом» срабатывают и на пропускаемых страницах.
 */
function firstVisibleFrom(ctx: RespondentContext, index: number, onScan?: (p: Page) => void): string {
  const pages = pagesFor(ctx);
  for (let i = index; i < pages.length; i++) {
    onScan?.(pages[i]);
    if (isPageVisible(ctx, pages[i])) return pages[i].id;
  }
  return END;
}

/** Индекс экрана по ID вопроса или блока (переход к блоку — к его первому вопросу в порядке респондента) */
function targetIndex(ctx: RespondentContext, id: string): number {
  const pages = pagesFor(ctx);
  const byQuestion = pages.findIndex((p) => p.id === id);
  if (byQuestion >= 0) return byQuestion;
  const block = ctx.survey.blocks.find((b) => b.id === id);
  if (!block?.questions.length) return -1;
  const ids = new Set(block.questions.map((q) => q.id));
  return pages.findIndex((p) => ids.has(p.id));
}

export function firstPage(ctx: RespondentContext): string {
  return firstVisibleFrom(ctx, 0);
}

/**
 * Куда идти после страницы: ID страницы, END или SCREENOUT.
 * Сначала действия «после ответа» видимых вопросов (по порядку), затем переходы страницы.
 */
export function nextPage(ctx: RespondentContext, pageId: string, onScan?: (p: Page) => void): string {
  const pages = pagesFor(ctx);
  const idx = pages.findIndex((p) => p.id === pageId);
  if (idx < 0) return END;
  const rules: { if?: Condition; goTo: string }[] = [];
  for (const q of pages[idx].questions) {
    if (!isQuestionVisible(ctx, q)) continue;
    for (const a of q.actions?.after ?? []) {
      if (a.do === 'goTo' && a.target) rules.push({ if: a.if, goTo: a.target });
      else if (a.do === 'end') rules.push({ if: a.if, goTo: END });
      else if (a.do === 'screenout') rules.push({ if: a.if, goTo: SCREENOUT });
    }
  }
  rules.push(...(pages[idx].jumps ?? []));
  for (const j of rules) {
    if (!evalCondition(j.if, ctx)) continue;
    if (j.goTo === END || j.goTo === SCREENOUT) return j.goTo;
    const t = targetIndex(ctx, j.goTo);
    if (t >= 0) return firstVisibleFrom(ctx, t, onScan);
  }
  return firstVisibleFrom(ctx, idx + 1, onScan);
}

/** Действие «Завершить» / «Отсеять», которое сработало на экране (для своего сообщения и редиректа) */
export function endingAction(ctx: RespondentContext, pageId: string): Action | null {
  const page = findPage(ctx.survey, pageId);
  if (!page) return null;
  for (const q of page.questions) {
    if (!isQuestionVisible(ctx, q)) continue;
    for (const a of q.actions?.after ?? []) {
      if ((a.do === 'goTo' || a.do === 'end' || a.do === 'screenout') && evalCondition(a.if, ctx)) {
        return a.do === 'goTo' ? null : a;
      }
    }
  }
  return null;
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
  const idx = pagesFor(ctx).findIndex((p) => p.id === currentPageId);
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
export function cleanAnswers(ctx: RespondentContext, pagesVisited: string[]): Answers {
  const kept: Answers = {};
  const base = loopBase(ctx.survey);
  const loops = hasLoops(base);
  const c: RespondentContext = { ...ctx, answers: kept };
  // Циклы разворачиваются по уже принятым ответам: повторы появляются, когда отвечен вопрос-источник
  const reexpand = () => { if (loops) c.survey = expandLoops(base, kept, ctx.params, ctx.seed); };
  // Скрытые переменные не привязаны к маршруту: их задают скрипты и параметры ссылки
  for (const q of allQuestions(loops ? expandAllLoops(base) : ctx.survey)) {
    if (q.type === 'hidden' && ctx.answers[q.id] !== undefined && !q.calc) kept[q.id] = ctx.answers[q.id];
  }
  reexpand();
  // Вычисляемые переменные — по порядку анкеты, чтобы следующая формула видела предыдущую
  const recalc = () => {
    const calcs = allQuestions(c.survey).filter((q): q is Extract<Question, { type: 'hidden' }> => q.type === 'hidden' && !!q.calc);
    for (const q of calcs) {
      const v = calcValue(q.calc!, c);
      if (v === undefined) delete kept[q.id]; else kept[q.id] = { v };
    }
  };
  recalc();
  // Действия «перед показом»: переменные и автоответы
  const before = (page: Page) => {
    if (!evalCondition(page.showIf, c)) return;
    for (const q of page.questions) {
      if (!evalCondition(q.showIf, c)) continue;
      for (const a of q.actions?.before ?? []) {
        if (a.do === 'setValue' && evalCondition(a.if, c)) {
          const v = actionValue(c, a);
          if (v !== undefined) kept[a.target!] = { v };
        }
      }
      const auto = autoAnswerValue(c, q);
      if (auto !== undefined) kept[q.id] = { v: auto };
    }
  };
  const visited = new Set(pagesVisited);
  const seen = new Set<string>();
  let cur = firstVisibleFrom(c, 0, before);
  while (cur !== END && cur !== SCREENOUT && visited.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const page = findPage(c.survey, cur)!;
    for (const q of page.questions) {
      if (q.type !== 'hidden' && ctx.answers[q.id] !== undefined && isQuestionVisible(c, q)) kept[q.id] = ctx.answers[q.id];
    }
    // Действия «после ответа»: переменные
    for (const q of page.questions) {
      if (!isQuestionVisible(c, q) && !(q.id in kept)) continue;
      for (const a of q.actions?.after ?? []) {
        if (a.do === 'setValue' && evalCondition(a.if, c)) {
          const v = actionValue(c, a);
          if (v !== undefined) kept[a.target!] = { v };
        }
      }
    }
    reexpand();
    recalc();
    cur = nextPage(c, cur, before);
  }
  return kept;
}

// ---------- Подстановка ответов (пайпинг) ----------

export function answerText(ctx: RespondentContext, q: Question, rowCode?: string): string {
  const a = ctx.answers[q.id];
  if (!a) return '';
  const label = (opts: Option[], code: number) => {
    const o = opts.find((x) => x.code === code) ?? allOptions(ctx.survey, q).find((x) => x.code === code);
    if (!o) return String(code);
    return o.other && a.o?.[String(code)] ? a.o[String(code)] : o.text;
  };
  switch (q.type) {
    case 'single':
    case 'dropdown':
      return typeof a.v === 'number' ? label(resolveOptions(ctx, q, 0, false), a.v) : '';
    case 'multi':
    case 'ranking':
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

/**
 * Адрес редиректа: подстановки как в тексте плюс {{resp_id}}; значения кодируются для URL.
 * Для вопросов с вариантами подставляется код ответа, а не текст — так удобнее панелям.
 */
export function pipeUrl(url: string, ctx: RespondentContext, respId: string): string {
  return url.replace(/\{\{\s*([A-Za-z][\w]*)(?:\.([\w]+))?\s*\}\}/g, (_m, id: string, sub?: string) => {
    let v = '';
    if (id === 'resp_id') v = respId;
    else if (id === 'param' && sub) v = ctx.params[sub] ?? '';
    else {
      const a = ctx.answers[id]?.v;
      if (sub !== undefined && a && typeof a === 'object' && !Array.isArray(a)) {
        const rv = (a as Record<string, number | number[]>)[sub];
        v = rv === undefined ? '' : String(rv);
      } else if (a !== undefined && (typeof a !== 'object' || Array.isArray(a))) v = Array.isArray(a) ? a.join(',') : String(a);
    }
    return encodeURIComponent(v);
  });
}

/** Заменяет {{Q1}}, {{Q5.2}} (строка матрицы), {{param.src}}, {{resp_id}} на значения */
export function pipe(text: string, ctx: RespondentContext): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([A-Za-z][\w]*)(?:\.([\w]+))?\s*\}\}/g, (_m, id: string, sub?: string) => {
    if (id === 'param' && sub) return ctx.params[sub] ?? '';
    if (id === 'resp_id') return ctx.seed;
    const q = findQuestion(ctx.survey, id);
    if (!q) return '';
    return answerText(ctx, q, sub);
  });
}
