import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatFormula, parseFormula, FormulaError } from '../shared/condFormula.ts';
import type { Condition } from '../shared/types.ts';

test('formula: simple comparisons and lists', () => {
  assert.deepEqual(parseFormula('Q1 = 1'), { q: 'Q1', op: 'eq', value: 1 });
  assert.deepEqual(parseFormula('S1>=18'), { q: 'S1', op: 'gte', value: 18 });
  assert.deepEqual(parseFormula('Q2 in (1, 2)'), { q: 'Q2', op: 'in', value: [1, 2] });
  assert.deepEqual(parseFormula('Q2 not in (3)'), { q: 'Q2', op: 'notIn', value: [3] });
  assert.deepEqual(parseFormula('Q3 contains any (1,5)'), { q: 'Q3', op: 'containsAny', value: [1, 5] });
  assert.deepEqual(parseFormula('Q5[2] > 3'), { q: 'Q5', row: 2, op: 'gt', value: 3 });
  assert.deepEqual(parseFormula('param.src = "vk"'), { param: 'src', op: 'eq', value: 'vk' });
  assert.deepEqual(parseFormula('not answered(Q4)'), { q: 'Q4', op: 'notAnswered' });
  assert.deepEqual(parseFormula('Q1 = -1'), { q: 'Q1', op: 'eq', value: -1 });
  assert.equal(parseFormula('  '), undefined);
});

test('formula: and / or precedence, russian words, not', () => {
  assert.deepEqual(parseFormula('Q1 = 1 or Q2 = 2 and Q3 = 3'),
    { any: [{ q: 'Q1', op: 'eq', value: 1 }, { all: [{ q: 'Q2', op: 'eq', value: 2 }, { q: 'Q3', op: 'eq', value: 3 }] }] });
  assert.deepEqual(parseFormula('Q1 = 1 и Q2 = 2 и Q3 = 3'),
    { all: [{ q: 'Q1', op: 'eq', value: 1 }, { q: 'Q2', op: 'eq', value: 2 }, { q: 'Q3', op: 'eq', value: 3 }] });
  assert.deepEqual(parseFormula('not (Q1 = 1 or Q2 = 2)'), { not: { any: [{ q: 'Q1', op: 'eq', value: 1 }, { q: 'Q2', op: 'eq', value: 2 }] } });
});

test('formula: errors are readable', () => {
  assert.throws(() => parseFormula('Q1 ='), FormulaError);
  assert.throws(() => parseFormula('Q1 = 1 Q2 = 2'), /and \/ or/);
  assert.throws(() => parseFormula('Q1 ~ 2'), FormulaError);
});

test('formula: format round-trips', () => {
  const cases: Condition[] = [
    { q: 'Q1', op: 'eq', value: 1 },
    { all: [{ q: 'S1', op: 'gte', value: 18 }, { q: 'Q2', op: 'in', value: [1, 2] }] },
    { any: [{ q: 'Q1', op: 'eq', value: 1 }, { all: [{ q: 'Q2', op: 'eq', value: 2 }, { param: 'src', op: 'eq', value: 'v"k' }] }] },
    { all: [{ any: [{ q: 'A', op: 'eq', value: 1 }, { q: 'B', op: 'eq', value: 2 }] }, { q: 'C', op: 'notAnswered' }] },
    { not: { all: [{ q: 'A', op: 'contains', value: 3 }, { q: 'B', op: 'containsAll', value: [1, 2] }] } },
    { q: 'Q5', row: 2, op: 'lte', value: 3 },
    { q: 'D', op: 'eq', value: '2024-01-01' },
  ];
  for (const c of cases) assert.deepEqual(parseFormula(formatFormula(c)), c, formatFormula(c));
});
