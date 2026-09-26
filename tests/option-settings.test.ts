import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSurvey } from '../shared/validate.ts';
import { validateAnswer } from '../shared/answers.ts';
import { cleanAnswers, isQuestionVisible, nextPage, resolveOptions, resolveRows } from '../shared/logic.ts';
import { expandLoops } from '../shared/loops.ts';
import { buildVariables, type ResponseRecord } from '../shared/variables.ts';
import type { Answers, Question, RespondentContext, Survey } from '../shared/types.ts';

const survey: Survey = {
  formatVersion: 2,
  title: 'Настройки вариантов',
  blocks: [{ id: 'B1', questions: [
    { id: 'Q1', type: 'multi', text: 'Что пьёте', order: 'random', options: [
      { code: 100, text: 'Горячее', group: true },
      { code: 1, text: 'Кофе' }, { code: 2, text: 'Чай' }, { code: 3, text: 'Какао' },
      { code: 4, text: 'Ничего горячего', groupExclusive: true, noLoop: true },
      { code: 101, text: 'Холодное', group: true },
      { code: 5, text: 'Сок' }, { code: 6, text: 'Вода', alwaysShow: true, noExport: true },
      { code: 97, text: 'Сколько раз в день', other: true, otherType: 'number', otherDecimals: true, noExportOther: true },
      { code: 98, text: 'Когда последний раз', other: true, otherType: 'date', otherOptional: true },
      { code: 99, text: 'Ничего из этого', exclusive: true, bottom: true },
    ], actions: { before: [{ do: 'hideOptions', codes: [5, 6] }], after: [
      { if: { q: 'Q1', op: 'contains', value: 99 }, do: 'skipQuestion', target: 'Q2' },
      { if: { q: 'Q1', op: 'contains', value: 1 }, do: 'markAnswered', target: 'Q3', value: '2' },
    ] } },
    { id: 'Q2', type: 'text', text: 'Почему ничего?', required: false, actions: { before: [{ if: { param: 'skip', op: 'eq', value: '1' }, do: 'skip' }] } },
    { id: 'Q3', type: 'single', text: 'Любимое', options: [{ code: 1, text: 'Кофе' }, { code: 2, text: 'Чай' }] },
    { id: 'M1', type: 'matrix', text: 'Оцените', mode: 'single',
      rows: [{ code: 1, text: 'Вкус' }, { code: 2, text: 'Цена', noExport: true }],
      columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Хорошо' }, { code: 9, text: 'Не пробовал', shared: true }] },
  ] }],
};
const ctx = (answers: Answers, params: Record<string, string> = {}): RespondentContext => ({ survey, answers, params, seed: 'x' });
const q = (id: string) => survey.blocks[0].questions.find((x) => x.id === id) as Question;

test('option settings survey is valid', () => {
  const r = validateSurvey(survey);
  assert.deepEqual(r.errors, []);
});

test('groups: shuffled inside the group, headers kept, empty groups and hidden-by-action options dropped, bottom last', () => {
  for (const seed of ['a', 'b', 'c', 'd']) {
    const opts = resolveOptions({ ...ctx({}), seed }, q('Q1'));
    const codes = opts.map((o) => o.code);
    assert.equal(codes[0], 100, 'заголовок первой группы на месте');
    assert.deepEqual(codes.slice(1, 5).sort(), [1, 2, 3, 4]);
    assert.equal(codes[5], 101);
    // Сок скрыт действием, вода — «всегда отображается»
    assert.ok(!codes.includes(5));
    assert.ok(codes.includes(6));
    assert.equal(codes.at(-1), 99, 'вариант «внизу» последним');
  }
  const hideAll = { ...survey, blocks: [{ id: 'B', questions: [{ ...(q('Q1') as any), actions: { before: [{ do: 'hideOptions', codes: [5, 6, 97, 98] }] } }] }] } as Survey;
  const codes = resolveOptions({ survey: hideAll, answers: {}, params: {}, seed: 'x' }, hideAll.blocks[0].questions[0]).map((o) => o.code);
  assert.ok(codes.includes(6) && codes.includes(101), 'группа с видимым вариантом остаётся');
});

test('answers: group headers are not choices, group-exclusive, typed open values', () => {
  const c = ctx({});
  assert.match(validateAnswer(c, q('Q1'), { v: [100] })!, /из списка/);
  assert.match(validateAnswer(c, q('Q1'), { v: [1, 4] })!, /группы/);
  assert.equal(validateAnswer(c, q('Q1'), { v: [4, 6] }), null, 'блокирующий в группе не мешает другой группе');
  assert.match(validateAnswer(c, q('Q1'), { v: [97], o: { 97: 'abc' } })!, /число/);
  assert.equal(validateAnswer(c, q('Q1'), { v: [97], o: { 97: '2,5' } }), null);
  assert.equal(validateAnswer(c, q('Q1'), { v: [98] }), null, 'пустое открытое значение разрешено');
  assert.match(validateAnswer(c, q('Q1'), { v: [98], o: { 98: '2024-13-40' } })!, /дату/);
});

test('matrix: shared column must cover the whole table', () => {
  const c = ctx({});
  assert.equal(validateAnswer(c, q('M1'), { v: { 1: 9, 2: 9 } }), null);
  assert.match(validateAnswer(c, q('M1'), { v: { 1: 9, 2: 1 } })!, /всей таблице/);
  assert.equal(resolveRows(c, q('M1') as any).length, 2);
});

test('actions: skip before show, skip and mark answered a later question', () => {
  assert.equal(isQuestionVisible(ctx({}, { skip: '1' }), q('Q2')), false);
  assert.equal(isQuestionVisible(ctx({}), q('Q2')), true);
  const a1: Answers = { Q1: { v: [99] } };
  assert.equal(nextPage(ctx(a1), 'Q1'), 'Q3', 'Q2 пропущен');
  const a2: Answers = { Q1: { v: [1] } };
  const kept = cleanAnswers(ctx(a2), ['Q1']);
  assert.deepEqual(kept.Q3, { v: 2 }, 'ответ записан');
  assert.equal(nextPage(ctx(kept), 'Q2'), 'M1', 'Q3 не показывается');
});

test('export: noExport and noExportOther drop columns; numeric open value is numeric', () => {
  const r: ResponseRecord = {
    id: 'r1', status: 'completed', answers: { Q1: { v: [1, 97], o: { 97: '2.5' } } }, params: {}, startedAt: new Date().toISOString(),
    completedAt: null, durationSec: null, ip: null, userAgent: null, isTest: false, version: 1,
  };
  const names = buildVariables(survey, [r]).map((v) => v.name);
  assert.ok(names.includes('Q1_1'));
  assert.ok(!names.includes('Q1_100'), 'заголовок группы не выгружается');
  assert.ok(!names.includes('Q1_6'), 'исключён из выгрузки');
  assert.ok(!names.includes('Q1_97_other'), 'открытое значение не выгружается');
  assert.ok(names.includes('Q1_98_other'));
  assert.ok(names.includes('M1_1') && !names.includes('M1_2'));
});

test('loops skip options marked noLoop', () => {
  const s: Survey = { ...survey, blocks: [survey.blocks[0], { id: 'L', loop: { question: 'Q1', filter: 'all' }, questions: [{ id: 'LQ', type: 'text', text: '{{loop}}' }] }] };
  const expanded = expandLoops(s, { Q1: { v: [1] } }, {}, 'x');
  const ids = expanded.blocks.flatMap((b) => b.questions.map((x) => x.id));
  assert.ok(ids.includes('LQ_1'));
  assert.ok(!ids.includes('LQ_4'), 'noLoop');
  assert.ok(!ids.includes('LQ_100'), 'заголовок группы');
});
