import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSurvey } from '../shared/validate.ts';
import { computePath, evalCondition, nextPage, pipe, resolveOptions, cleanAnswers, findQuestion } from '../shared/logic.ts';
import { validateAnswer, normalizePhone } from '../shared/answers.ts';
import { buildVariables, type ResponseRecord } from '../shared/variables.ts';
import type { Answers, RespondentContext, Survey } from '../shared/types.ts';

const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8')) as Survey;
const ctx = (answers: Answers, params: Record<string, string> = {}): RespondentContext => ({ survey: demo, answers, params, seed: 'x' });

test('demo survey is valid', () => {
  const r = validateSurvey(demo);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('validator catches common mistakes', () => {
  const bad = structuredClone(demo) as Survey;
  bad.pages[1].questions[0].id = 'S1';
  (bad.pages[0].jumps![0] as { goTo: string }).goTo = 'NOPE';
  (bad.pages[2].questions[0] as { rows: unknown[] }).rows.push({ code: 1, text: 'dup' });
  const r = validateSurvey(bad);
  const msgs = r.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /повторяется/);
  assert.match(msgs, /нет страницы «NOPE»/);
  assert.match(msgs, /код 1 повторяется/);
});

test('screenout jumps', () => {
  assert.equal(nextPage(ctx({ S1: { v: 16 }, S2: { v: 1 } }), 'P_intro'), 'SCREENOUT');
  assert.equal(nextPage(ctx({ S1: { v: 30 }, S2: { v: 5 } }), 'P_intro'), 'SCREENOUT');
  assert.equal(nextPage(ctx({ S1: { v: 30 }, S2: { v: 1 } }), 'P_intro'), 'P_brands');
});

test('carry forward + page skipped when nothing to carry', () => {
  const a: Answers = { S1: { v: 30 }, S2: { v: 1 }, Q1: { v: [2, 97] , o: { '97': 'Даблби' } } };
  const q2 = findQuestion(demo, 'Q2')!;
  assert.deepEqual(resolveOptions(ctx(a), q2).map((o) => o.text), ['Coffee Like', 'Даблби']);
  // «Ничего из перечисленного» → Q2 скрыт → страница оценки пропускается
  const none: Answers = { S1: { v: 30 }, S2: { v: 1 }, Q1: { v: [99] } };
  assert.equal(nextPage(ctx(none), 'P_brands'), 'P_profile');
  assert.deepEqual(computePath(ctx(none)).pages, ['P_intro', 'P_brands', 'P_profile']);
});

test('piping', () => {
  const a: Answers = { Q1: { v: [2] }, Q2: { v: 2 } };
  assert.equal(pipe('Оцените «{{Q2}}»', ctx(a)), 'Оцените «Coffee Like»');
  assert.equal(pipe('src={{param.src}}', ctx(a, { src: 'vk' })), 'src=vk');
});

test('conditions on multi and matrix', () => {
  const a: Answers = { Q1: { v: [1, 3] }, Q3: { v: { '1': 4, '2': 2 } } };
  assert.ok(evalCondition({ q: 'Q1', op: 'contains', value: 3 }, ctx(a)));
  assert.ok(evalCondition({ q: 'Q1', op: 'containsAll', value: [1, 3] }, ctx(a)));
  assert.ok(!evalCondition({ q: 'Q1', op: 'containsAny', value: [2, 4] }, ctx(a)));
  assert.ok(evalCondition({ q: 'Q3', row: 1, op: 'gte', value: 3 }, ctx(a)));
  assert.ok(evalCondition({ not: { q: 'Q3', row: 3, op: 'answered' } }, ctx(a)));
});

test('answer validation', () => {
  const c = ctx({ Q1: { v: [1, 2] }, Q2: { v: 1 } });
  const q1 = findQuestion(demo, 'Q1')!;
  assert.equal(validateAnswer(c, q1, { v: [1, 99] }), 'Вариант «Ничего из перечисленного» нельзя сочетать с другими');
  assert.match(validateAnswer(c, q1, { v: [97] })!, /Укажите ваш вариант/);
  assert.equal(validateAnswer(c, q1, { v: [97], o: { '97': 'X' } }), null);

  const q3 = findQuestion(demo, 'Q3')!;
  assert.match(validateAnswer(c, q3, { v: { '1': 1, '2': 1 } })!, /Скорость обслуживания/);
  assert.equal(validateAnswer(c, q3, { v: { '1': 1, '2': 1, '3': 2 } }), null);
  assert.match(validateAnswer(c, q3, { v: { '1': 1, '2': 1, '3': 2, '9': 3 } })!, /Укажите ваш вариант/);
  assert.match(validateAnswer(c, q3, { v: { '1': 1, '2': 1, '3': 2 }, o: { '9': 'Музыка' } })!, /Музыка/);

  const s1 = findQuestion(demo, 'S1')!;
  assert.match(validateAnswer(c, s1, { v: 12 })!, /меньше 14/);
  assert.match(validateAnswer(c, s1, { v: 20.5 })!, /целое/);
  assert.equal(normalizePhone('8 (916) 123-45-67'), '+79161234567');
  assert.equal(normalizePhone('123'), null);
});

test('cleanAnswers drops answers from abandoned branch', () => {
  const a: Answers = { S1: { v: 30 }, S2: { v: 1 }, Q1: { v: [99] }, Q2: { v: 1 }, Q4: { v: 3 }, D1: { v: 1 } };
  const path = computePath(ctx(a)).pages;
  assert.deepEqual(Object.keys(cleanAnswers(ctx(a), path)).sort(), ['D1', 'Q1', 'S1', 'S2']);
});

test('export variables', () => {
  const r: ResponseRecord = {
    id: 'r1', status: 'completed', params: { utm_source: 'tg' }, startedAt: '2026-01-01T10:00:00Z',
    completedAt: '2026-01-01T10:05:00Z', durationSec: 300, ip: null, userAgent: null, isTest: false, version: 1,
    answers: { Q1: { v: [1, 97], o: { '97': 'Даблби' } }, Q3: { v: { '1': 4 } } },
  };
  const vars = buildVariables(demo, [r]);
  const get = (n: string) => vars.find((v) => v.name === n)!.get(r);
  assert.equal(get('url_utm_source'), 'tg');
  assert.equal(get('Q1_1'), 1);
  assert.equal(get('Q1_2'), 0);
  assert.equal(get('Q1_97_other'), 'Даблби');
  assert.equal(get('Q3_1'), 4);
  assert.equal(get('Q3_2'), null);
  assert.equal(get('S1'), null);
});
