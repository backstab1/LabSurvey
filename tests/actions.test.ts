import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurvey } from '../shared/validate.ts';
import { actionError, cleanAnswers, findQuestion, isQuestionVisible, nextPage, resolveOptions } from '../shared/logic.ts';
import type { Answers, RespondentContext, Survey } from '../shared/types.ts';

const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ code: i + 1, text: `Бренд ${i + 1}` }));

const survey: Survey = {
  formatVersion: 2,
  title: 'Действия',
  blocks: [
    { id: 'B1', questions: [
      { id: 'H_seg', type: 'hidden', text: 'Сегмент' },
      { id: 'A1', type: 'number', text: 'Возраст',
        actions: { after: [
          { if: { q: 'A1', op: 'lt', value: 18 }, do: 'screenout' },
          { if: { q: 'A1', op: 'gte', value: 60 }, do: 'setValue', target: 'H_seg', value: 'senior' },
          { if: { q: 'A1', op: 'gt', value: 120 }, do: 'error', message: 'Проверьте возраст' },
        ] } },
    ] },
    { id: 'B2', questions: [{ id: 'Q1', type: 'multi', text: 'Знаете', options: opts(4) }] },
    { id: 'B3', questions: [{
      id: 'Q2', type: 'single', text: 'Любимый', options: opts(4),
      actions: {
        before: [
          { do: 'hideOptionsFrom', question: 'Q1', filter: 'notSelected' },
          { do: 'answer' },
        ],
        after: [{ if: { q: 'Q2', op: 'eq', value: 4 }, do: 'goTo', target: 'Q9' }],
      },
    }] },
    { id: 'B4', questions: [{ id: 'Q3', type: 'text', text: 'Почему', required: false }] },
    { id: 'B5', questions: [{ id: 'Q9', type: 'text', text: 'Финал', required: false,
      actions: { before: [{ if: { q: 'H_seg', op: 'eq', value: 'senior' }, do: 'setValue', target: 'H_seg', value: 'senior+{{Q2}}' }] } }] },
  ],
};
const ctx = (answers: Answers): RespondentContext => ({ survey, answers, params: {}, seed: 's' });

test('actions survey is valid', () => {
  const r = validateSurvey(survey);
  assert.deepEqual(r.errors, []);
});

test('after: screenout, error, setValue', () => {
  const a1 = findQuestion(survey, 'A1')!;
  assert.equal(nextPage(ctx({ A1: { v: 16 } }), 'A1'), 'SCREENOUT');
  assert.equal(actionError(ctx({ A1: { v: 130 } }), a1), 'Проверьте возраст');
  assert.equal(actionError(ctx({ A1: { v: 30 } }), a1), null);
  const kept = cleanAnswers(ctx({ A1: { v: 65 } }), ['A1']);
  assert.equal(kept.H_seg.v, 'senior');
});

test('before: hide options from other question, auto-answer single option', () => {
  const q2 = findQuestion(survey, 'Q2')!;
  assert.deepEqual(resolveOptions(ctx({ Q1: { v: [2, 4] } }), q2).map((o) => o.code), [2, 4]);
  assert.ok(isQuestionVisible(ctx({ Q1: { v: [2, 4] } }), q2));
  // Знает один бренд — Q2 отмечается автоматически и не показывается, страница пропускается
  const c = ctx({ A1: { v: 30 }, Q1: { v: [3] } });
  assert.ok(!isQuestionVisible(c, q2));
  assert.equal(nextPage(c, 'Q1'), 'Q3');
  const kept = cleanAnswers(c, ['A1', 'Q1', 'Q3']);
  assert.equal(kept.Q2.v, 3);
});

test('after: goTo question skips pages; setValue with piping', () => {
  assert.equal(nextPage(ctx({ Q1: { v: [1, 4] }, Q2: { v: 4 } }), 'Q2'), 'Q9');
  const kept = cleanAnswers(ctx({ A1: { v: 70 }, Q1: { v: [1, 4] }, Q2: { v: 4 } }), ['A1', 'Q1', 'Q2', 'Q9']);
  assert.equal(kept.H_seg.v, 'senior+Бренд 4');
});
