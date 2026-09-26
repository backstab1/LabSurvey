// Условие в виде текста-формулы (как в Survey Studio) ⇄ структура Condition.
// Примеры: "Q1 = 1", "S1 >= 18 and Q2 in (1, 2)", "Q3 contains any (1, 5)", "not answered(Q4)",
// "Q5[2] > 3" (строка матрицы), "param.src = \"vk\"", "LOOP = 2" (код текущего повтора цикла).
// Формула хранится не строкой, а разбирается в тот же Condition — логика, квоты и карта логики работают как раньше.
import type { Condition, ConditionOp, SimpleCondition } from './types.ts';

export class FormulaError extends Error {}

type Tok = { t: 'id' | 'num' | 'str' | 'op' | 'p'; v: string };

const WORDS: Record<string, string> = {
  and: 'and', и: 'and', or: 'or', или: 'or', not: 'not', не: 'not',
  in: 'in', contains: 'contains', any: 'any', all: 'all', answered: 'answered',
};

function tokenize(src: string): Tok[] {
  const re = /\s*(?:(-?\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(>=|<=|!=|<>|==|&&|\|\||[=<>!])|([()[\],])|([A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*))/y;
  const out: Tok[] = [];
  let pos = 0;
  const s = src.trimEnd();
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) throw new FormulaError(`Непонятный символ «${s.slice(pos).trim()[0]}»`);
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (m[3] !== undefined) out.push({ t: 'op', v: m[3] === '&&' ? 'and' : m[3] === '||' ? 'or' : m[3] === '!' ? 'not' : m[3] });
    else if (m[4] !== undefined) out.push({ t: 'p', v: m[4] });
    else {
      const w = WORDS[m[5].toLowerCase()];
      out.push(w ? { t: 'op', v: w } : { t: 'id', v: m[5] });
    }
    pos = re.lastIndex;
  }
  return out;
}

const CMP: Record<string, ConditionOp> = { '=': 'eq', '==': 'eq', '!=': 'neq', '<>': 'neq', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

/** Разбирает формулу. Пустая строка — undefined (условия нет) */
export function parseFormula(src: string): Condition | undefined {
  if (!src.trim()) return undefined;
  const toks = tokenize(src);
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const is = (v: string, k = 0) => peek(k) !== undefined && peek(k).t !== 'str' && peek(k).v === v;
  const expect = (v: string, what = `«${v}»`) => {
    if (!is(v)) throw new FormulaError(`Ожидалось ${what}${peek() ? `, а не «${peek().v}»` : ' в конце'}`);
    i++;
  };

  const value = (): number | string => {
    const t = toks[i++];
    if (!t) throw new FormulaError('Не хватает значения в конце');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    throw new FormulaError(`Ожидалось значение (число или "текст"), а не «${t.v}»`);
  };
  const list = (): (number | string)[] => {
    // (1, 2, 3) или одиночное значение
    if (!is('(')) return [value()];
    i++;
    const out = [value()];
    while (is(',')) { i++; out.push(value()); }
    expect(')');
    return out;
  };

  const subject = (): Pick<SimpleCondition, 'q' | 'row' | 'param'> => {
    const t = toks[i++];
    if (!t || t.t !== 'id') throw new FormulaError(t ? `Ожидался ID вопроса, а не «${t.v}»` : 'Условие оборвано');
    if (/^param\./i.test(t.v)) return { param: t.v.slice(6) };
    const out: Pick<SimpleCondition, 'q' | 'row'> = { q: t.v };
    if (is('[')) {
      i++;
      const r = toks[i++];
      if (!r || r.t !== 'num') throw new FormulaError('В [ ] — код строки матрицы, например Q5[2]');
      out.row = Number(r.v);
      expect(']');
    }
    return out;
  };

  const simple = (negated: boolean): Condition => {
    // answered(Q1)
    if (is('answered')) {
      i++;
      expect('(');
      const s = subject();
      expect(')');
      return { ...s, op: negated ? 'notAnswered' : 'answered' };
    }
    const s = subject();
    const wrap = (c: SimpleCondition): Condition => (negated ? { not: c } : c);
    const t = peek();
    if (!t) throw new FormulaError(`После ${s.q ?? s.param} нужен оператор: =, >, in, contains…`);
    if (t.t === 'op' && CMP[t.v]) { i++; return wrap({ ...s, op: CMP[t.v], value: value() }); }
    const not = is('not') ? (i++, true) : false;
    if (is('in')) { i++; return wrap({ ...s, op: not ? 'notIn' : 'in', value: list() }); }
    if (is('contains')) {
      i++;
      if (is('any') || is('all')) {
        const kind = toks[i++].v;
        if (not) throw new FormulaError('«not contains any» не поддерживается — используйте not (Q contains any (…))');
        return wrap({ ...s, op: kind === 'any' ? 'containsAny' : 'containsAll', value: list() });
      }
      return wrap({ ...s, op: not ? 'notContains' : 'contains', value: value() });
    }
    if (is('answered')) { i++; return wrap({ ...s, op: not ? 'notAnswered' : 'answered' }); }
    throw new FormulaError(`Непонятный оператор «${t.v}» — ожидалось =, !=, >, <, in, contains, answered`);
  };

  const unary = (): Condition => {
    if (is('not')) {
      i++;
      if (is('(')) { i++; const c = or(); expect(')'); return { not: c }; }
      return simple(true);
    }
    if (is('(')) { i++; const c = or(); expect(')'); return c; }
    return simple(false);
  };
  const and = (): Condition => {
    const items = [unary()];
    while (is('and')) { i++; items.push(unary()); }
    return items.length === 1 ? items[0] : { all: items.flatMap((c) => ('all' in c ? c.all : [c])) };
  };
  const or = (): Condition => {
    const items = [and()];
    while (is('or')) { i++; items.push(and()); }
    return items.length === 1 ? items[0] : { any: items.flatMap((c) => ('any' in c ? c.any : [c])) };
  };

  const c = or();
  if (i < toks.length) throw new FormulaError(`Лишнее в конце: «${toks[i].v}». Условия соединяются через and / or`);
  return c;
}

const val = (v: unknown): string =>
  typeof v === 'number' ? String(v) : `"${String(v ?? '').replace(/["\\]/g, '\\$&')}"`;
const vals = (v: unknown): string => `(${(Array.isArray(v) ? v : [v]).map(val).join(', ')})`;

function subj(c: SimpleCondition): string {
  if (c.param !== undefined) return `param.${c.param}`;
  return `${c.q ?? '?'}${c.row !== undefined ? `[${c.row}]` : ''}`;
}

const OP_TEXT: Partial<Record<ConditionOp, string>> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** Условие → текст формулы */
export function formatFormula(c: Condition | undefined, parent: 'and' | 'or' | 'not' | null = null): string {
  if (!c) return '';
  if ('all' in c) {
    const s = c.all.map((x) => formatFormula(x, 'and')).join(' and ');
    return parent === 'not' || (parent === 'and' && c.all.length > 1) ? `(${s})` : s;
  }
  if ('any' in c) {
    const s = c.any.map((x) => formatFormula(x, 'or')).join(' or ');
    return parent === 'and' || parent === 'not' ? `(${s})` : s;
  }
  if ('not' in c) {
    const inner = c.not;
    const simpleInner = !('all' in inner) && !('any' in inner) && !('not' in inner);
    return simpleInner ? `not ${formatFormula(inner, null)}` : `not ${formatFormula(inner, 'not')}`;
  }
  const s = subj(c);
  switch (c.op) {
    case 'answered': return `answered(${s})`;
    case 'notAnswered': return `not answered(${s})`;
    case 'in': return `${s} in ${vals(c.value)}`;
    case 'notIn': return `${s} not in ${vals(c.value)}`;
    case 'contains': return `${s} contains ${val(c.value)}`;
    case 'notContains': return `${s} not contains ${val(c.value)}`;
    case 'containsAny': return `${s} contains any ${vals(c.value)}`;
    case 'containsAll': return `${s} contains all ${vals(c.value)}`;
    default: return `${s} ${OP_TEXT[c.op] ?? c.op} ${val(c.value)}`;
  }
}

/** Все ID вопросов, упомянутые в условии (для проверки ссылок в редакторе) */
export function referencedIds(c: Condition | undefined): string[] {
  if (!c) return [];
  if ('all' in c) return c.all.flatMap(referencedIds);
  if ('any' in c) return c.any.flatMap(referencedIds);
  if ('not' in c) return referencedIds(c.not);
  return c.q ? [c.q] : [];
}

export const FORMULA_HELP =
  'Q1 = 1 · S1 >= 18 · Q2 in (1, 2) · Q3 contains 5 · Q3 contains any (1, 2) · answered(Q4) · Q5[2] > 3 (строка матрицы) · param.src = "vk" · and / or / not и скобки';
