import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandAllLoops, expandLoops } from '../shared/loops.ts';
import { buildVariables } from '../shared/variables.ts';
import { validateSurvey } from '../shared/validate.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-loops-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => { app = await buildApp(); });
after(() => app.close());
const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null, body: res.body };
};

/** Категории → по каждой выбранной: частота и марки → по каждой выбранной марке: оценка (вложенный цикл) → итог по категории */
export const loopSurvey: Survey = {
  formatVersion: 2, title: 'Циклы',
  blocks: [
    { id: 'B1', questions: [
      { id: 'CAT', type: 'multi', text: 'Что покупаете?', options: [
        { code: 1, text: 'Кофе' }, { code: 2, text: 'Чай' }, { code: 3, text: 'Сок' }, { code: 97, text: 'Другое', other: true },
        { code: 99, text: 'Ничего', exclusive: true },
      ] },
    ] },
    { id: 'L_cat', title: 'Про {{loop}}', loop: { question: 'CAT' }, questions: [
      { id: 'FREQ', type: 'single', text: 'Как часто покупаете {{loop}}?', options: [{ code: 1, text: 'Часто' }, { code: 2, text: 'Редко' }] },
      { id: 'BRAND', type: 'multi', text: 'Какие марки ({{loop.code}})?', options: [{ code: 1, text: 'Альфа' }, { code: 2, text: 'Бета' }] },
      { id: 'TEA_ONLY', type: 'text', text: 'Только про чай', showIf: { q: 'LOOP', op: 'eq', value: 2 } },
    ] },
    { id: 'L_brand', parent: 'L_cat', loop: { question: 'BRAND' }, questions: [
      { id: 'RATE', type: 'scale', text: 'Оцените {{loop}} в категории {{loop1}}', from: 1, to: 5 },
    ] },
    { id: 'P_sum', parent: 'L_cat', questions: [
      { id: 'WHY', type: 'text', text: 'Почему часто {{loop}}? Частота: {{FREQ}}', showIf: { q: 'FREQ', op: 'eq', value: 1 } },
    ] },
    { id: 'B_end', questions: [
      { id: 'FIN', type: 'text', text: 'Про кофе вы сказали: {{FREQ_1}}', required: false },
    ] },
  ],
};

test('expansion: ids by item code, rewritten references, placeholders, LOOP conditions', () => {
  const s = expandLoops(loopSurvey, { CAT: { v: [2, 97], o: { 97: 'Какао' } }, BRAND_2: { v: [2] } }, {}, 'r1');
  const ids = s.blocks.flatMap((b) => b.questions.map((q) => q.id));
  assert.deepEqual(ids, ['CAT', 'FREQ_2', 'BRAND_2', 'TEA_ONLY_2', 'RATE_2_2', 'WHY_2', 'FREQ_97', 'BRAND_97', 'TEA_ONLY_97', 'WHY_97', 'FIN']);
  const q = (id: string) => s.blocks.flatMap((b) => b.questions).find((x) => x.id === id)!;
  assert.equal(q('FREQ_97').text, 'Как часто покупаете Какао?');
  assert.equal(q('BRAND_2').text, 'Какие марки (2)?');
  assert.equal(q('RATE_2_2').text, 'Оцените Бета в категории Чай');
  assert.deepEqual(q('WHY_2').showIf, { q: 'FREQ_2', op: 'eq', value: 1 });
  assert.equal(q('WHY_2').text, 'Почему часто Чай? Частота: {{FREQ_2}}');
  assert.deepEqual(q('TEA_ONLY_2').showIf, { all: [] });
  assert.deepEqual(q('TEA_ONLY_97').showIf, { any: [] });
  assert.equal(s.blocks.find((b) => b.id === 'L_cat_2')!.title, 'Про Чай');
});

test('export has variables for every possible iteration', () => {
  const names = buildVariables(expandAllLoops(loopSurvey), []).map((v) => v.name);
  for (const n of ['FREQ_1', 'FREQ_97', 'BRAND_3_1', 'RATE_1_2', 'RATE_97_1', 'WHY_2']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => n.startsWith('FREQ_99')), 'эксклюзивный вариант не повторяется');
});

test('respondent walks loops including a nested one', async () => {
  const lr = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(lr.headers['set-cookie']).split(';')[0];
  const created = await call('POST', '/api/admin/surveys', { definition: loopSurvey });
  assert.deepEqual(created.json.errors, []);
  await call('POST', `/api/admin/surveys/${created.json.id}/publish`);
  const sid = await launch(call, created.json.id);
  cookie = '';

  let st = (await call('POST', `/api/s/${sid}/start`, {})).json;
  const rid = st.rid;
  const answer = async (page: string, v: unknown) => (await call('POST', `/api/s/${sid}/submit`, { rid, page, answers: { [page]: { v } } })).json;
  const path: string[] = [st.page];
  st = await answer('CAT', [1, 2]); path.push(st.page);
  st = await answer('FREQ_1', 1); path.push(st.page);
  st = await answer('BRAND_1', [1, 2]); path.push(st.page);
  st = await answer('RATE_1_1', 5); path.push(st.page);
  st = await answer('RATE_1_2', 3); path.push(st.page);
  st = await answer('WHY_1', 'вкусно'); path.push(st.page);
  st = await answer('FREQ_2', 2); path.push(st.page);
  st = await answer('BRAND_2', [2]); path.push(st.page);
  st = await answer('TEA_ONLY_2', 'зелёный'); path.push(st.page);
  st = await answer('RATE_2_2', 4); path.push(st.page);
  assert.deepEqual(path, ['CAT', 'FREQ_1', 'BRAND_1', 'RATE_1_1', 'RATE_1_2', 'WHY_1', 'FREQ_2', 'BRAND_2', 'TEA_ONLY_2', 'RATE_2_2', 'FIN']);
  // Назад и смена ответа во вложенном источнике
  st = (await call('POST', `/api/s/${sid}/back`, { rid, page: 'FIN', answers: {} })).json;
  assert.equal(st.page, 'RATE_2_2');
  st = await answer('RATE_2_2', 2);
  st = await answer('FIN', 'ok');
  assert.equal(st.status, 'completed');
  assert.equal(st.answers.RATE_1_2.v, 3);
  assert.equal(st.answers.WHY_2, undefined);

  // Смена выбора источника: при возврате лишние повторы удаляются из ответов
  const st2 = (await call('POST', `/api/s/${sid}/start`, {})).json;
  const a2 = async (page: string, v: unknown) => (await call('POST', `/api/s/${sid}/submit`, { rid: st2.rid, page, answers: { [page]: { v } } })).json;
  let s2 = await a2('CAT', [3]);
  assert.equal(s2.page, 'FREQ_3');
  s2 = await a2('FREQ_3', 2);
  s2 = await a2('BRAND_3', [1]);
  s2 = await a2('RATE_3_1', 1);
  assert.equal(s2.page, 'FIN');
  s2 = await a2('FIN', '');
  assert.equal(s2.status, 'completed');

  cookie = String(lr.headers['set-cookie']).split(';')[0];
  const csv = await call('GET', `/api/admin/projects/${sid}/export.csv`);
  const [head, row1] = csv.body.replace(/^﻿/, '').split('\r\n');
  const cols = head.split(';');
  const val = (row: string, name: string) => row.split(';')[cols.indexOf(name)];
  assert.equal(val(row1, 'RATE_1_1'), '5');
  assert.equal(val(row1, 'RATE_2_2'), '2');
  assert.equal(val(row1, 'FREQ_1'), '1');
  const report = (await call('GET', `/api/admin/projects/${sid}/report`)).json;
  assert.ok(report.questions.some((q: { id: string; n: number }) => q.id === 'RATE_3_1' && q.n === 1));
});

test('other sources: static list, number, matrix rows by column; order and max', () => {
  const s: Survey = {
    formatVersion: 2, title: 's',
    blocks: [
      { id: 'B1', questions: [
        { id: 'KIDS', type: 'number', text: 'Сколько детей?' },
        { id: 'M', type: 'matrix', mode: 'single', text: 'Оцените', rows: [{ code: 1, text: 'Цена' }, { code: 2, text: 'Вкус' }, { code: 3, text: 'Сервис' }],
          columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Хорошо' }] },
      ] },
      { id: 'L_kid', loop: { question: 'KIDS', max: 5 }, questions: [{ id: 'AGE', type: 'number', text: 'Возраст ребёнка №{{loop}}' }] },
      { id: 'L_bad', loop: { question: 'M', columns: [1] }, questions: [{ id: 'WHY', type: 'text', text: 'Что не так с «{{loop}}»?' }] },
      { id: 'L_ads', loop: { items: [{ code: 1, text: 'Ролик A' }, { code: 2, text: 'Ролик B' }, { code: 3, text: 'Ролик C' }], order: 'random', max: 2 },
        questions: [{ id: 'AD', type: 'scale', text: '{{loop}}', from: 1, to: 5 }] },
    ],
  };
  const ids = (answers: any, seed = 'x') => expandLoops(s, answers, {}, seed).blocks.flatMap((b) => b.questions.map((q) => q.id));
  const got = ids({ KIDS: { v: 9 }, M: { v: { 1: 1, 2: 2, 3: 1 } } });
  assert.deepEqual(got.filter((x) => x.startsWith('AGE')), ['AGE_1', 'AGE_2', 'AGE_3', 'AGE_4', 'AGE_5']);
  assert.deepEqual(got.filter((x) => x.startsWith('WHY')), ['WHY_1', 'WHY_3']);
  const ads = new Set<string>();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const a = ids({}, seed).filter((x) => x.startsWith('AD'));
    assert.equal(a.length, 2);
    ads.add(a.join());
  }
  assert.ok(ads.size > 1, 'случайные 2 из 3 различаются');
  assert.ok(validateSurvey(s).ok, JSON.stringify(validateSurvey(s).errors));
});

test('loop structure is validated', () => {
  const bad = structuredClone(loopSurvey);
  bad.blocks[2].parent = 'B1';
  assert.match(validateSurvey(bad).errors.map((e) => e.message).join('|'), /не цикл/);
  const bad2 = structuredClone(loopSurvey);
  bad2.blocks.splice(2, 0, { id: 'X', questions: [{ id: 'XQ', type: 'info', text: 'x' }] });
  assert.match(validateSurvey(bad2).errors.map((e) => e.message).join('|'), /сразу за циклом/);
  const bad3 = structuredClone(loopSurvey);
  bad3.blocks[1].loop = { question: 'FIN' };
  assert.match(validateSurvey(bad3).errors.map((e) => e.message).join('|'), /Источник цикла|раньше цикла/);
  const bad4 = structuredClone(loopSurvey);
  bad4.blocks[0].questions.push({ id: 'FREQ_1', type: 'info', text: 'конфликт' });
  assert.match(validateSurvey(bad4).errors.map((e) => e.message).join('|'), /FREQ_1/);
  const bad5 = structuredClone(loopSurvey);
  bad5.blocks[4].questions[0].showIf = { q: 'LOOP', op: 'eq', value: 1 };
  assert.match(validateSurvey(bad5).errors.map((e) => e.message).join('|'), /только в вопросах внутри цикла/);
  // Снаружи можно ссылаться на копии: FIN подставляет {{FREQ_1}}
  assert.deepEqual(validateSurvey(loopSurvey).warnings.filter((w) => /FREQ_1/.test(w.message)), []);
});

test('logic map counts loop repeats in the path length', async () => {
  const { analyzeFlow } = await import('../shared/flow.ts');
  const f = analyzeFlow(loopSurvey);
  // CAT + FIN без повторов; максимум: 4 категории × 3 вопроса + 4×2 оценки марок + 4 «почему» + CAT + FIN
  assert.equal(f.stats.minPath, 2);
  assert.equal(f.stats.maxPath, 26);
  assert.deepEqual(f.nodes.find((n) => n.id === 'RATE')!.repeats, { max: 8, depth: 2 });
  assert.deepEqual(f.nodes.find((n) => n.id === 'CAT')!.loopSource, ['L_cat']);
  assert.deepEqual(f.nodes.find((n) => n.id === 'BRAND')!.loopSource, ['L_brand']);
  assert.ok(f.nodes.every((n) => n.reachable));
});
