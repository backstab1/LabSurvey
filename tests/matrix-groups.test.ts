import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurvey } from '../shared/validate.ts';
import { answerRows, resolveRows } from '../shared/logic.ts';
import { validateAnswer } from '../shared/answers.ts';
import { buildVariables } from '../shared/variables.ts';
import type { MatrixQuestion, Survey } from '../shared/types.ts';

const m: MatrixQuestion = {
  id: 'M1', type: 'matrix', text: 'Оцените', mode: 'single', rowOrder: 'random',
  rows: [
    { code: 100, text: 'Вкус', group: true },
    { code: 1, text: 'Кофе' }, { code: 2, text: 'Выпечка' }, { code: 3, text: 'Десерты' },
    { code: 101, text: 'Сервис', group: true },
    { code: 4, text: 'Скорость' }, { code: 5, text: 'Вежливость' },
    { code: 102, text: 'Пустая группа', group: true },
  ],
  columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Хорошо' }],
};
const survey: Survey = { formatVersion: 2, title: 'Группы строк', blocks: [{ id: 'B1', questions: [m] }] };

test('matrix row groups: valid, shuffled inside groups, headers not answerable or exported', () => {
  assert.ok(validateSurvey(survey).ok, JSON.stringify(validateSurvey(survey).errors));

  for (const seed of ['a', 'b', 'c', 'd']) {
    const ctx = { survey, answers: {}, params: {}, seed };
    const rows = resolveRows(ctx, m).map((r) => r.code);
    // Заголовки на местах, строки — внутри своих групп, пустая группа убрана
    assert.equal(rows[0], 100);
    assert.equal(rows[4], 101);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.slice(1, 4).sort(), [1, 2, 3]);
    assert.deepEqual(rows.slice(5).sort(), [4, 5]);
    assert.deepEqual(answerRows(ctx, m).map((r) => r.code).sort(), [1, 2, 3, 4, 5]);
  }

  const ctx = { survey, answers: {}, params: {}, seed: 'x' };
  assert.equal(validateAnswer(ctx, m, { v: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 1 } }), null);
  assert.ok(validateAnswer(ctx, m, { v: { 1: 1, 2: 1, 3: 2, 4: 2, 5: 1, 100: 1 } }), 'ответ в заголовке группы — ошибка');

  const names = buildVariables(survey, []).map((v) => v.name);
  assert.ok(names.includes('M1_1') && names.includes('M1_5'));
  assert.ok(!names.some((n) => n === 'M1_100' || n === 'M1_101'));
});
