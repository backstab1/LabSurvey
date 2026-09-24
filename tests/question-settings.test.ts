import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptions, resolveRows } from '../shared/logic.ts';
import { validateAnswer } from '../shared/answers.ts';
import { validateSurvey } from '../shared/validate.ts';
import type { MatrixQuestion, Option, Question, RespondentContext, Survey } from '../shared/types.ts';

const survey = (questions: Question[]): Survey => ({ formatVersion: 2, title: 't', blocks: [{ id: 'B1', questions }] });
const ctx = (s: Survey, seed = 'seed'): RespondentContext => ({ survey: s, answers: {}, params: {}, seed });

test('fixed options keep their place when shuffled or rotated', () => {
  const options: Option[] = Array.from({ length: 8 }, (_, i) => ({ code: i + 1, text: `o${i + 1}` }));
  options[0] = { ...options[0], fixed: true };
  options[4] = { ...options[4], fixed: true };
  for (const order of ['random', 'rotate'] as const) {
    const q: Question = { id: 'Q1', type: 'single', text: 'q', order, options: [...options, { code: 97, text: 'Другое', other: true }] };
    for (const seed of ['a', 'b', 'c', 'd']) {
      const codes: number[] = resolveOptions(ctx(survey([q]), seed), q).map((o) => o.code);
      assert.equal(codes[0], 1);
      assert.equal(codes[4], 5);
      assert.equal(codes[8], 97);
      assert.deepEqual([...codes].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 97]);
    }
  }
});

test('hidden options and rows are not shown and not accepted', () => {
  const q: Question = { id: 'Q1', type: 'single', text: 'q', options: [{ code: 1, text: 'a' }, { code: 2, text: 'b', hidden: true }] };
  const c = ctx(survey([q]));
  assert.deepEqual(resolveOptions(c, q).map((o) => o.code), [1]);
  assert.ok(validateAnswer(c, q, { v: 2 }));
  const m: MatrixQuestion = { id: 'M', type: 'matrix', mode: 'single', text: 'm', rows: [{ code: 1, text: 'r1' }, { code: 2, text: 'r2', hidden: true }], columns: [{ code: 1, text: 'c' }] };
  const cm = ctx(survey([m]));
  assert.deepEqual(resolveRows(cm, m).map((o) => o.code), [1]);
  assert.equal(validateAnswer(cm, m, { v: { '1': 1 } }), null);
  const all = validateSurvey(survey([{ id: 'Q1', type: 'single', text: 'q', options: [{ code: 1, text: 'a', hidden: true }] }]));
  assert.match(all.errors[0].message, /все варианты скрыты/);
});

test('text length, pattern and custom required message', () => {
  const q: Question = { id: 'T', type: 'text', text: 't', minLength: 3, pattern: '[А-Яа-яЁё\\s-]+', patternMessage: 'Только кириллица', requiredMessage: 'Напишите хоть что-то' };
  const c = ctx(survey([q]));
  assert.equal(validateAnswer(c, q, undefined), 'Напишите хоть что-то');
  assert.equal(validateAnswer(c, q, { v: 'аб' }), 'Не менее 3 символов');
  assert.equal(validateAnswer(c, q, { v: 'abcd' }), 'Только кириллица');
  assert.equal(validateAnswer(c, q, { v: 'Анна-Мария' }), null);
});

test('new question fields are validated', () => {
  const r = validateSurvey(survey([
    { id: 'T', type: 'text', text: 't', minLength: 10, maxLength: 5, pattern: '([' },
    { id: 'Q', type: 'multi', text: 'q', columnCount: 7, options: [{ code: 1, text: 'a', fixed: 'yes' as unknown as boolean }] },
  ]));
  const msgs = r.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /minLength больше maxLength/);
  assert.match(msgs, /pattern:/);
  assert.match(msgs, /columnCount/);
  assert.match(msgs, /fixed: true или false/);
});
