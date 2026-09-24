import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcValue, parseCalc, CalcError } from '../shared/calc.ts';
import { cleanAnswers } from '../shared/logic.ts';
import { validateSurvey } from '../shared/validate.ts';
import { renameId } from '../shared/refactor.ts';
import type { Survey } from '../shared/types.ts';

const survey: Survey = {
  formatVersion: 2, title: 'calc',
  blocks: [{ id: 'B1', questions: [
    { id: 'Q1', type: 'multi', text: 'q1', options: [{ code: 1, text: 'a', score: 2 }, { code: 2, text: 'b', score: 3 }, { code: 3, text: 'c' }] },
    { id: 'Q2', type: 'scale', text: 'q2', from: 1, to: 5 },
    { id: 'M', type: 'matrix', mode: 'single', text: 'm', rows: [{ code: 1, text: 'r1' }, { code: 2, text: 'r2' }], columns: [{ code: 1, text: 'нет', score: 0 }, { code: 2, text: 'да', score: 10 }] },
    { id: 'H_total', type: 'hidden', text: 'Итог', calc: 'score(Q1) + Q2 * 2 + score(M)' },
    { id: 'H_seg', type: 'hidden', text: 'Сегмент', calc: 'if(H_total >= 20, 1, 2)' },
    { id: 'Q3', type: 'text', text: 'Сегмент {{H_seg}}', showIf: { q: 'H_seg', op: 'eq', value: 1 } },
  ] }],
};
const ctx = (answers: any) => ({ survey, answers, params: {}, seed: 's' });

test('formulas: arithmetic, functions, errors', () => {
  const c = ctx({ Q1: { v: [1, 2] }, Q2: { v: 4 } });
  assert.equal(calcValue('score(Q1) + count(Q1) * 10', c), 25);
  assert.equal(calcValue('round(10 / 3, 2)', c), 3.33);
  assert.equal(calcValue('avg(Q2, 2) + max(1, 7) - min(3, -1)', c), 11);
  assert.equal(calcValue('answered(Q3) + (Q2 > 3) + (Q2 == 4)', c), 2);
  assert.equal(calcValue('1 / 0', c), undefined);
  assert.throws(() => parseCalc('score(1)'), CalcError);
  assert.throws(() => parseCalc('Q1 +'), CalcError);
  assert.throws(() => parseCalc('foo(Q1)'), CalcError);
  assert.throws(() => parseCalc('Q1; drop'), CalcError);
});

test('calc variables are recomputed along the route and usable in logic', () => {
  const kept = cleanAnswers(ctx({ Q1: { v: [1, 2] }, Q2: { v: 5 }, M: { v: { '1': 2, '2': 1 } } }), ['Q1', 'Q2', 'M']);
  assert.equal(kept.H_total.v, 25);
  assert.equal(kept.H_seg.v, 1);
  const low = cleanAnswers(ctx({ Q1: { v: [3] }, Q2: { v: 1 } }), ['Q1', 'Q2', 'M']);
  assert.equal(low.H_total.v, 2);
  assert.equal(low.H_seg.v, 2);
});

test('formulas are validated and follow renames', () => {
  assert.ok(validateSurvey(survey).ok);
  const bad = structuredClone(survey);
  (bad.blocks[0].questions[3] as any).calc = 'score(NOPE) +';
  assert.ok(!validateSurvey(bad).ok);
  (bad.blocks[0].questions[3] as any).calc = 'NOPE + 1';
  assert.match(validateSurvey(bad).errors[0].message, /NOPE/);
  const renamed = renameId(survey, 'Q1', 'A1');
  assert.equal((renamed.blocks[0].questions[3] as any).calc, 'score(A1) + Q2 * 2 + score(M)');
});

test('built-in templates are valid surveys', async () => {
  const { TEMPLATES } = await import('../web/src/admin/templates.ts');
  for (const t of TEMPLATES) {
    if (!t.survey) continue;
    const r = validateSurvey(t.survey);
    assert.deepEqual(r.errors, [], t.id);
  }
});
