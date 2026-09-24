// Формулы для вычисляемых переменных (hidden + calc): арифметика по ответам без выполнения кода.
// Пример: "score(Q1) + score(Q2)", "(Q5 + Q6) / 2", "if(S1 >= 18, 1, 2)", "count(Q3)".
import { hasOptions, resolveOptions, resolveRows } from './logic.ts';
import type { AnswerValue, Question, RespondentContext, Survey } from './types.ts';

type Node =
  | { t: 'num'; v: number }
  | { t: 'ref'; id: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'fn'; name: string; args: Node[] };

export const CALC_FUNCTIONS: Record<string, string> = {
  score: 'сумма баллов выбранных вариантов (для матрицы — баллов столбцов)',
  count: 'сколько вариантов выбрано (строк матрицы заполнено)',
  answered: '1, если на вопрос есть ответ, иначе 0',
  sum: 'сумма аргументов', avg: 'среднее аргументов', min: 'минимум', max: 'максимум',
  round: 'round(x) или round(x, знаков)', if: 'if(условие, если да, если нет)',
};
const REF_FUNCS = new Set(['score', 'count', 'answered']);

export class CalcError extends Error {}

function tokenize(src: string): string[] {
  const re = /\s*(\d+(?:[.,]\d+)?|[A-Za-z_][\w]*|>=|<=|==|!=|[-+*/(),<>])/y;
  const out: string[] = [];
  let pos = 0;
  src = src.trim();
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new CalcError(`Непонятный символ «${src.slice(pos).trim()[0]}»`);
    out.push(m[1]);
    pos = re.lastIndex;
    while (pos < src.length && src[pos] === ' ') pos++;
  }
  return out;
}

export function parseCalc(src: string): Node {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t: string) => { if (next() !== t) throw new CalcError(`Ожидалось «${t}»`); };

  const cmp = (): Node => {
    let a = add();
    while (['>', '<', '>=', '<=', '==', '!='].includes(peek())) { const op = next(); a = { t: 'bin', op, a, b: add() }; }
    return a;
  };
  const add = (): Node => {
    let a = mul();
    while (peek() === '+' || peek() === '-') { const op = next(); a = { t: 'bin', op, a, b: mul() }; }
    return a;
  };
  const mul = (): Node => {
    let a = unary();
    while (peek() === '*' || peek() === '/') { const op = next(); a = { t: 'bin', op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => (peek() === '-' ? (next(), { t: 'neg', a: unary() }) : atom());
  const atom = (): Node => {
    const tok = next();
    if (tok === undefined) throw new CalcError('Формула оборвалась');
    if (tok === '(') { const e = cmp(); expect(')'); return e; }
    if (/^\d/.test(tok)) return { t: 'num', v: Number(tok.replace(',', '.')) };
    if (/^[A-Za-z_]/.test(tok)) {
      if (peek() === '(') {
        const name = tok.toLowerCase();
        if (!(name in CALC_FUNCTIONS)) throw new CalcError(`Неизвестная функция ${tok}()`);
        next();
        const args: Node[] = [];
        if (peek() !== ')') {
          args.push(cmp());
          while (peek() === ',') { next(); args.push(cmp()); }
        }
        expect(')');
        if (REF_FUNCS.has(name) && (args.length !== 1 || args[0].t !== 'ref')) throw new CalcError(`${name}() принимает один ID вопроса`);
        if (name === 'if' && args.length !== 3) throw new CalcError('if() принимает три аргумента');
        return { t: 'fn', name, args };
      }
      return { t: 'ref', id: tok };
    }
    throw new CalcError(`Неожиданное «${tok}»`);
  };

  const tree = cmp();
  if (i < tokens.length) throw new CalcError(`Лишнее «${tokens[i]}»`);
  return tree;
}

/** ID вопросов, на которые ссылается формула */
export function calcRefs(node: Node): string[] {
  switch (node.t) {
    case 'ref': return [node.id];
    case 'neg': return calcRefs(node.a);
    case 'bin': return [...calcRefs(node.a), ...calcRefs(node.b)];
    case 'fn': return node.args.flatMap(calcRefs);
    default: return [];
  }
}

function optionScore(ctx: RespondentContext, q: Question, v: AnswerValue): number {
  if (hasOptions(q)) {
    const opts = resolveOptions(ctx, q, 0, false);
    const codes = Array.isArray(v) ? v : [v];
    return codes.reduce<number>((s, c) => s + (opts.find((o) => o.code === c)?.score ?? 0), 0);
  }
  if (q.type === 'scale') return typeof v === 'number' ? (q.extraOptions?.find((o) => o.code === v)?.score ?? (v >= q.from && v <= q.to ? v : 0)) : 0;
  if (q.type === 'matrix' && v && typeof v === 'object' && !Array.isArray(v)) {
    const rows = new Set(resolveRows(ctx, q).map((r) => String(r.code)));
    return Object.entries(v as Record<string, number | number[]>)
      .filter(([r]) => rows.has(r))
      .reduce((s, [, x]) => s + (Array.isArray(x) ? x : [x]).reduce((a, c) => a + (q.columns.find((col) => col.code === c)?.score ?? 0), 0), 0);
  }
  return typeof v === 'number' ? v : 0;
}

function find(survey: Survey, id: string): Question | undefined {
  for (const b of survey.blocks) for (const q of b.questions) if (q.id === id) return q;
  return undefined;
}

/** Значение формулы; нет ответа — 0. Деление на ноль и прочее «не число» — undefined */
export function evalCalc(node: Node, ctx: RespondentContext): number {
  const val = (n: Node): number => {
    switch (n.t) {
      case 'num': return n.v;
      case 'neg': return -val(n.a);
      case 'ref': {
        const v = ctx.answers[n.id]?.v;
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v.replace(',', '.')))) return Number(v.replace(',', '.'));
        return 0;
      }
      case 'bin': {
        const a = val(n.a); const b = val(n.b);
        switch (n.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b;
          case '>': return +(a > b); case '<': return +(a < b); case '>=': return +(a >= b); case '<=': return +(a <= b);
          case '==': return +(a === b); case '!=': return +(a !== b);
        }
        return NaN;
      }
      case 'fn': {
        if (REF_FUNCS.has(n.name)) {
          const id = (n.args[0] as { id: string }).id;
          const q = find(ctx.survey, id);
          const v = ctx.answers[id]?.v;
          const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
          if (n.name === 'answered') return empty ? 0 : 1;
          if (empty || !q) return 0;
          if (n.name === 'count') return Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : 1;
          return optionScore(ctx, q, v);
        }
        const xs = n.args.map(val);
        switch (n.name) {
          case 'sum': return xs.reduce((a, b) => a + b, 0);
          case 'avg': return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
          case 'min': return Math.min(...xs);
          case 'max': return Math.max(...xs);
          case 'round': { const k = 10 ** (xs[1] ?? 0); return Math.round(xs[0] * k) / k; }
          case 'if': return xs[0] ? xs[1] : xs[2];
        }
        return NaN;
      }
    }
  };
  return val(node);
}

const cache = new Map<string, Node | CalcError>();

/** Вычислить формулу по строке (с кэшем разбора); ошибка или не-число — undefined */
export function calcValue(src: string, ctx: RespondentContext): number | undefined {
  let node = cache.get(src);
  if (!node) {
    try { node = parseCalc(src); } catch (e) { node = e as CalcError; }
    if (cache.size > 2000) cache.clear();
    cache.set(src, node);
  }
  if (node instanceof CalcError) return undefined;
  const v = evalCalc(node, ctx);
  return isFinite(v) ? Math.round(v * 1e6) / 1e6 : undefined;
}
