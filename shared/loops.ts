// Циклы: блок вопросов повторяется для каждого элемента — выбранного варианта, строки матрицы, числа или своего списка.
// Как в Survey Studio (questions.repeat): на время прохождения анкета «разворачивается» — для каждого повтора создаются
// копии вопросов с ID по коду элемента (Q6 → Q6_3, во вложенном цикле Q7_3_2). Ссылки внутри повтора переписываются на
// копии этого же повтора, {{loop}} / {{loop.code}} заменяются текстом и кодом элемента. Дальше работает обычный движок.
import { allOptions, allRows, hasOptions, hash, resolveOptions, resolveRows, seededShuffle } from './logic.ts';
import type { Answers, Block, Condition, LoopSpec, Option, Question, RespondentContext, Survey } from './types.ts';

export interface LoopItem { code: number; text: string }

/** Условие «код текущего повтора» в условиях: { "q": "LOOP", ... }; LOOP1 — внешний уровень */
export const LOOP_REF = /^LOOP(\d?)$/;
/** Предел повторов для цикла по числу, если max не задан */
export const NUMBER_LOOP_MAX = 20;

const baseOf = new WeakMap<Survey, Survey>();
/** Исходная (не развёрнутая) анкета */
export const loopBase = (s: Survey): Survey => baseOf.get(s) ?? s;

export const hasLoops = (s: Survey): boolean => s.blocks.some((b) => b.loop || b.parent);

// ---------- Структура ----------

/** Дочерние блоки (parent = id) — идут сразу после родителя и его потомков */
function childrenOf(blocks: Block[], id: string): Block[] {
  return blocks.filter((b) => b.parent === id);
}

/** Уровень вложенности блока: 0 — верхний */
export function loopDepth(s: Survey, block: Block): number {
  let d = 0;
  let cur: Block | undefined = block;
  const seen = new Set<string>();
  while (cur?.parent && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = s.blocks.find((b) => b.id === cur!.parent);
    d++;
  }
  return d;
}

/** Цепочка циклов, внутри которых находится блок (снаружи внутрь), включая сам блок, если он цикл */
export function loopChain(s: Survey, block: Block): Block[] {
  const chain: Block[] = [];
  let cur: Block | undefined = block;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.loop) chain.unshift(cur);
    cur = cur.parent ? s.blocks.find((b) => b.id === cur!.parent) : undefined;
  }
  return chain;
}

// ---------- Элементы цикла ----------

function sourceItems(spec: LoopSpec, ctx: RespondentContext | null, survey: Survey, sourceId: string | undefined): LoopItem[] {
  if (spec.items) return spec.items.map((o) => ({ code: o.code, text: o.text }));
  const src = sourceId ? findIn(survey, sourceId) : undefined;
  if (!src) return [];
  const filter = spec.filter ?? 'selected';
  const answer = ctx?.answers[src.id];
  const otherText = (o: Option) => (o.other && answer?.o?.[String(o.code)]) || o.text;

  if (src.type === 'number') {
    const max = spec.max ?? NUMBER_LOOP_MAX;
    const n = ctx ? Math.max(0, Math.min(max, Math.floor(typeof answer?.v === 'number' ? answer.v : 0))) : max;
    return Array.from({ length: n }, (_, i) => ({ code: i + 1, text: String(i + 1) }));
  }
  if (src.type === 'matrix') {
    const rows = (ctx ? resolveRows(ctx, src) : allRows(survey, src)).filter((r) => !r.noLoop);
    if (!ctx) return rows.map((r) => ({ code: r.code, text: r.text }));
    const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number | number[]>;
    const hit = (r: Option) => {
      const x = v[String(r.code)];
      if (x === undefined || (Array.isArray(x) && !x.length)) return false;
      return !spec.columns?.length || (Array.isArray(x) ? x : [x]).some((c) => spec.columns!.includes(c));
    };
    return rows.filter((r) => (filter === 'all' ? true : filter === 'selected' ? hit(r) : !hit(r)))
      .map((r) => ({ code: r.code, text: otherText(r) }));
  }
  if (!hasOptions(src)) return [];
  const opts = (ctx ? resolveOptions(ctx, src, 0, false) : allOptions(survey, src)).filter((o) => !o.exclusive && !o.group && !o.noLoop);
  if (!ctx) return opts.map((o) => ({ code: o.code, text: o.text }));
  const v = answer?.v;
  const chosen: number[] = Array.isArray(v) ? v : typeof v === 'number' ? [v] : [];
  if (filter === 'selected') {
    // Для ранжирования — в порядке мест
    const byCode = new Map(opts.map((o) => [o.code, o]));
    return chosen.filter((c) => byCode.has(c)).map((c) => ({ code: c, text: otherText(byCode.get(c)!) }));
  }
  return opts.filter((o) => filter === 'all' || !chosen.includes(o.code)).map((o) => ({ code: o.code, text: otherText(o) }));
}

function orderItems(items: LoopItem[], spec: LoopSpec, seed: string): LoopItem[] {
  let out = items;
  if (spec.order === 'random') out = seededShuffle(items, seed);
  else if (spec.order === 'rotate' && items.length) {
    const s = hash(seed) % items.length;
    out = [...items.slice(s), ...items.slice(0, s)];
  }
  return spec.max && spec.max > 0 ? out.slice(0, spec.max) : out;
}

function findIn(s: Survey, id: string): Question | undefined {
  for (const b of s.blocks) for (const q of b.questions) if (q.id === id) return q;
  return undefined;
}

// ---------- Переписывание копии ----------

const REF_KEYS = new Set(['q', 'question', 'target']);
const TEXT_KEYS = new Set(['text', 'hint', 'title', 'value', 'message', 'placeholder', 'redirect', 'requiredMessage']);
const PIPE = /\{\{\s*([A-Za-z][\w]*)((?:\.\w+)?)\s*\}\}/g;

interface Scope {
  /** base ID вопроса или блока → ID в этом повторе */
  ids: Map<string, string>;
  /** Элементы повторов снаружи внутрь */
  path: LoopItem[];
}

/** Значение LOOP-условия: код текущего повтора (LOOP) или уровня N (LOOP1 — самый внешний) */
function loopCode(scope: Scope, ref: string): number | undefined {
  const m = ref.match(LOOP_REF);
  if (!m) return undefined;
  const level = m[1] ? Number(m[1]) - 1 : scope.path.length - 1;
  return scope.path[level]?.code;
}

function loopText(scope: Scope, name: string, sub: string): string | undefined {
  const m = name.match(/^loop(\d?)$/);
  if (!m) return undefined;
  const level = m[1] ? Number(m[1]) - 1 : scope.path.length - 1;
  const item = scope.path[level];
  if (!item) return '';
  return sub === '.code' ? String(item.code) : item.text;
}

const TRUE: Condition = { all: [] };
const FALSE: Condition = { any: [] };

function evalLoopCond(c: { op: string; value?: unknown }, code: number): boolean {
  const vals = (Array.isArray(c.value) ? c.value : [c.value]).map(Number);
  switch (c.op) {
    case 'eq': case 'contains': return code === Number(c.value);
    case 'neq': case 'notContains': return code !== Number(c.value);
    case 'in': case 'containsAny': return vals.includes(code);
    case 'notIn': return !vals.includes(code);
    case 'gt': return code > Number(c.value);
    case 'gte': return code >= Number(c.value);
    case 'lt': return code < Number(c.value);
    case 'lte': return code <= Number(c.value);
    case 'answered': return true;
    case 'notAnswered': return false;
    default: return false;
  }
}

function rewrite<T>(node: T, scope: Scope, key?: string): T {
  if (Array.isArray(node)) return node.map((x) => rewrite(x, scope)) as T;
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // Условие по коду повтора — вычисляется сразу
    if (typeof obj.q === 'string' && typeof obj.op === 'string' && LOOP_REF.test(obj.q)) {
      const code = loopCode(scope, obj.q);
      return (code !== undefined && evalLoopCond(obj as { op: string }, code) ? TRUE : FALSE) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = rewrite(v, scope, k);
    return out as T;
  }
  if (typeof node === 'string' && key) {
    if (REF_KEYS.has(key)) return (scope.ids.get(node) ?? node) as T;
    if (TEXT_KEYS.has(key)) {
      return node.replace(PIPE, (m, name: string, sub: string) => {
        const lt = loopText(scope, name, sub);
        if (lt !== undefined) return lt;
        const id = scope.ids.get(name);
        return id ? `{{${id}${sub}}}` : m;
      }) as T;
    }
    if (key === 'calc') return node.replace(/\b[A-Za-z_]\w*\b/g, (w) => scope.ids.get(w) ?? w) as T;
    if (key === 'onShow' || key === 'onChange' || key === 'validate') {
      return node.replace(/(['"`])([A-Za-z]\w*)\1/g, (m, qch, id) => (scope.ids.has(id) ? `${qch}${scope.ids.get(id)}${qch}` : m)) as T;
    }
  }
  return node;
}

// ---------- Развёртка ----------

/**
 * Разворачивает циклы. ctx = null — все возможные повторы (для выгрузки, отчёта и проверки ссылок),
 * иначе — повторы конкретного респондента по его ответам.
 */
function build(base: Survey, answers: Answers | null, params: Record<string, string>, seed: string): Survey {
  const out: Block[] = [];
  const partial: Survey = { ...base, blocks: out };
  const ctx = (): RespondentContext | null => (answers ? { survey: partial, answers, params, seed } : null);

  const emit = (block: Block, scope: Scope, depth: number) => {
    if (depth > 5) return;
    const inner = (sc: Scope) => {
      const suffix = sc.path.map((i) => `_${i.code}`).join('');
      // Простой вложенный блок дополняет карту повтора — следующие блоки этого повтора видят его вопросы
      const ids = block.loop ? new Map(sc.ids) : sc.ids;
      if (sc.path.length) {
        ids.set(block.id, `${block.id}${suffix}`);
        for (const q of block.questions) ids.set(q.id, `${q.id}${suffix}`);
      }
      const own: Scope = { ids, path: sc.path };
      const copy: Block = sc.path.length
        ? rewrite({ ...block, loop: undefined, parent: undefined, id: `${block.id}${suffix}`, questions: block.questions.map((q) => ({ ...q, id: `${q.id}${suffix}` })) }, own)
        : { ...block, loop: undefined, parent: undefined };
      out.push(copy);
      for (const child of childrenOf(base.blocks, block.id)) emit(child, own, depth + 1);
    };
    if (!block.loop) return inner(scope);
    const spec = block.loop;
    const sourceId = spec.question ? scope.ids.get(spec.question) ?? spec.question : undefined;
    const suffix = scope.path.map((i) => `_${i.code}`).join('');
    let items = sourceItems(spec, ctx(), answers ? partial : partialAll(base, out), sourceId);
    if (answers) items = orderItems(items, spec, `${seed}:loop:${block.id}${suffix}`);
    for (const item of items) inner({ ids: scope.ids, path: [...scope.path, item] });
  };

  for (const b of base.blocks) {
    if (b.parent) continue;
    emit(b, { ids: new Map(), path: [] }, 0);
  }
  baseOf.set(partial, base);
  return partial;
}

/** Для «всех возможных» повторов источник ищется среди уже развёрнутых блоков */
function partialAll(base: Survey, out: Block[]): Survey {
  return { ...base, blocks: out };
}

const respondentCache = new WeakMap<Survey, Map<string, Survey>>();
const allCache = new WeakMap<Survey, Survey>();
const sourcesCache = new WeakMap<Survey, string[]>();

function sourceIds(base: Survey): string[] {
  let ids = sourcesCache.get(base);
  if (!ids) {
    ids = base.blocks.map((b) => b.loop?.question).filter((x): x is string => !!x);
    sourcesCache.set(base, ids);
  }
  return ids;
}

/** Анкета конкретного респондента: циклы развёрнуты по его ответам. Без циклов — та же анкета */
export function expandLoops(survey: Survey, answers: Answers, params: Record<string, string>, seed: string): Survey {
  const base = loopBase(survey);
  if (!hasLoops(base)) return base;
  // Развёртка зависит только от ответов на вопросы-источники (и их копии во вложенных циклах)
  const srcs = sourceIds(base);
  const relevant = Object.keys(answers).filter((k) => srcs.some((s) => k === s || k.startsWith(`${s}_`))).sort();
  const key = `${seed}|${JSON.stringify(relevant.map((k) => [k, answers[k]]))}|${JSON.stringify(params)}`;
  let bySeed = respondentCache.get(base);
  if (!bySeed) respondentCache.set(base, (bySeed = new Map()));
  let s = bySeed.get(key);
  if (!s) {
    s = build(base, answers, params, seed);
    if (bySeed.size > 300) bySeed.clear();
    bySeed.set(key, s);
  }
  return s;
}

/** Все возможные повторы — для выгрузки, отчёта, просмотра ответа и проверки ссылок */
export function expandAllLoops(survey: Survey): Survey {
  const base = loopBase(survey);
  if (!hasLoops(base)) return base;
  let s = allCache.get(base);
  if (!s) {
    s = build(base, null, {}, '');
    allCache.set(base, s);
  }
  return s;
}

/** Контекст с развёрнутыми циклами */
export function withLoops(ctx: RespondentContext): RespondentContext {
  const survey = expandLoops(ctx.survey, ctx.answers, ctx.params, ctx.seed);
  return survey === ctx.survey ? ctx : { ...ctx, survey };
}

// ---------- Для конструктора ----------

/** Все возможные элементы цикла блока (по исходной анкете) */
export function possibleItems(survey: Survey, block: Block): LoopItem[] {
  if (!block.loop) return [];
  return sourceItems(block.loop, null, loopBase(survey), block.loop.question);
}

const lookupCache = new WeakMap<Survey, Survey>();
/** Исходная анкета + копии вопросов из циклов (FREQ_1…) — чтобы на копии можно было ссылаться в условиях */
export function withInstances(survey: Survey): Survey {
  if (!hasLoops(survey)) return survey;
  let s = lookupCache.get(survey);
  if (!s) {
    const own = new Set(survey.blocks.flatMap((b) => b.questions.map((q) => q.id)));
    const extra = expandAllLoops(survey).blocks
      .map((b) => ({ ...b, questions: b.questions.filter((q) => !own.has(q.id)) }))
      .filter((b) => b.questions.length);
    s = { ...survey, blocks: [...survey.blocks, ...extra] };
    lookupCache.set(survey, s);
  }
  return s;
}

/** Уровни циклов вокруг вопроса: LOOP1 — внешний … LOOP — текущий */
export function loopLevelsOf(survey: Survey, questionId: string | undefined): { ref: string; label: string; items: LoopItem[] }[] {
  if (!questionId) return [];
  const block = survey.blocks.find((b) => b.questions.some((q) => q.id === questionId));
  if (!block) return [];
  const chain = loopChain(survey, block);
  return chain.map((b, i) => ({
    ref: i === chain.length - 1 ? 'LOOP' : `LOOP${i + 1}`,
    label: `повтор цикла «${b.title?.replace(/\{\{[^}]*\}\}/g, '[элемент]') || b.id}»`,
    items: possibleItems(survey, b),
  }));
}
