import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import { validateAnswer } from '../shared/answers.ts';
import { conjointDesign, maxdiffDesign } from '../shared/choiceDesign.ts';
import type { ConjointQuestion, MaxDiffQuestion, Survey } from '../shared/types.ts';

const md: MaxDiffQuestion = {
  id: 'MD', type: 'maxdiff', text: 'Что важнее?', perSet: 4,
  options: Array.from({ length: 12 }, (_, i) => ({ code: i + 1, text: `Свойство ${i + 1}` })),
};
const cj: ConjointQuestion = {
  id: 'CJ', type: 'conjoint', text: 'Что выберете?', tasks: 8, alternatives: 3, none: 'Ничего из этого',
  attributes: [
    { id: 'PRICE', text: 'Цена', levels: [1, 2, 3, 4].map((c) => ({ code: c, text: `${150 + c * 50} ₽` })) },
    { id: 'VOL', text: 'Объём', levels: [{ code: 1, text: '250 мл' }, { code: 2, text: '350 мл' }] },
    { id: 'BRAND', text: 'Бренд', levels: [1, 2, 3].map((c) => ({ code: c, text: `Бренд ${c}` })) },
  ],
};
const survey: Survey = {
  formatVersion: 2, title: 'Новые типы',
  blocks: [{ id: 'B1', questions: [
    { id: 'SL', type: 'slider', text: 'Сколько готовы заплатить?', min: 0, max: 500, step: 10, unit: '₽' },
    { id: 'SUM', type: 'sum', text: 'Распределите 100%', options: [{ code: 1, text: 'Вкус' }, { code: 2, text: 'Цена' }, { code: 3, text: 'Бренд' }] },
    {
      id: 'HS', type: 'hotspot', text: 'Что бросается в глаза?', image: 'https://example.com/pack.png', maxSelected: 2,
      options: [{ code: 1, text: 'Логотип', area: { x: 10, y: 10, w: 30, h: 20 } }, { code: 2, text: 'Цена', area: { x: 60, y: 70, w: 30, h: 20 } }],
    },
    { id: 'PH', type: 'file', text: 'Сфотографируйте чек', maxFiles: 2 },
    md,
    cj,
  ] }],
};

/** Граф «встречались в одном наборе» связный — все варианты сравнимы между собой */
function connected(sets: number[][]): boolean {
  const all = [...new Set(sets.flat())];
  const seen = new Set([all[0]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of sets) if (s.some((c) => seen.has(c)) && s.some((c) => !seen.has(c))) { s.forEach((c) => seen.add(c)); changed = true; }
  }
  return seen.size === all.length;
}

test('designs are balanced and deterministic', () => {
  // 8 вариантов по 4 — самый опасный случай: без приоритета пар наборы чередуются между двумя несвязанными четвёрками
  for (let r = 0; r < 50; r++) {
    const d8 = maxdiffDesign({ ...md, options: md.options.slice(0, 8) }, `r${r}`);
    assert.ok(connected(d8), `8 вариантов: дизайн распался на группы (${JSON.stringify(d8)})`);
    const pairs = new Map<string, number>();
    d8.forEach((s) => s.forEach((a) => s.forEach((b) => a < b && pairs.set(`${a}-${b}`, (pairs.get(`${a}-${b}`) ?? 0) + 1))));
    assert.ok(pairs.size >= 20, `8 вариантов: мало разных пар (${pairs.size} из 28)`);
  }
  for (let r = 0; r < 50; r++) {
    const d = maxdiffDesign(md, `r${r}`);
    assert.equal(d.length, 9);
    assert.ok(d.every((s) => s.length === 4 && new Set(s).size === 4));
    const counts = new Map<number, number>();
    d.flat().forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
    assert.equal(counts.size, 12);
    assert.deepEqual([...new Set(counts.values())], [3]); // каждый вариант ровно 3 раза
    assert.ok(connected(d), 'все варианты связаны сравнениями');

    const c = conjointDesign(cj, `r${r}`);
    assert.equal(c.length, 8);
    for (const task of c) {
      assert.equal(new Set(task.map((card) => card.join('.'))).size, 3); // карточки разные
      assert.equal(new Set(task.map((card) => card[0])).size, 3); // цена (4 уровня) в задании не повторяется
    }
    [4, 2, 3].forEach((levels, ai) => {
      const n = new Map<number, number>();
      c.forEach((t) => t.forEach((card) => n.set(card[ai], (n.get(card[ai]) ?? 0) + 1)));
      assert.equal(n.size, levels);
      assert.ok(Math.max(...n.values()) - Math.min(...n.values()) <= 1, 'уровни показываются поровну');
    });
  }
  assert.deepEqual(maxdiffDesign(md, 'same'), maxdiffDesign(md, 'same'));
  assert.notDeepEqual(maxdiffDesign(md, 'a'), maxdiffDesign(md, 'b'));
});

test('new types: survey validation and answer checks', () => {
  assert.ok(validateSurvey(survey).ok, JSON.stringify(validateSurvey(survey).errors));
  const bad = validateSurvey({ formatVersion: 2, title: 'x', blocks: [{ id: 'B1', questions: [
    { id: 'A', type: 'slider', text: 'a', min: 5, max: 1 },
    { id: 'B', type: 'hotspot', text: 'b', image: 'nope', options: [{ code: 1, text: 'x', area: { x: 90, y: 0, w: 20, h: 10 } }] },
    { id: 'C', type: 'maxdiff', text: 'c', options: [{ code: 1, text: 'x' }, { code: 2, text: 'y' }] },
    { id: 'D', type: 'conjoint', text: 'd', attributes: [{ id: 'P', text: 'Цена', levels: [{ code: 1, text: '1' }] }] },
    { id: 'E', type: 'file', text: 'e', maxFiles: 50 },
  ] }] } as never).errors.map((e) => e.message).join(' | ');
  for (const re of [/min должно быть меньше max/, /image/, /area/, /хотя бы 3 варианта/, /хотя бы 2 атрибута/, /maxFiles/]) assert.match(bad, re);

  const ctx = { survey, answers: {}, params: {}, seed: 'resp1' };
  const q = (id: string) => survey.blocks[0].questions.find((x) => x.id === id)!;
  assert.equal(validateAnswer(ctx, q('SL'), { v: 250 }), null);
  assert.ok(validateAnswer(ctx, q('SL'), { v: 255 }));
  assert.equal(validateAnswer(ctx, q('SUM'), { v: { 1: 50, 2: 30, 3: 20 } }), null);
  assert.match(validateAnswer(ctx, q('SUM'), { v: { 1: 50, 2: 30 } })!, /80%/);
  assert.equal(validateAnswer(ctx, q('HS'), { v: [1, 2] }), null);
  assert.ok(validateAnswer(ctx, q('HS'), { v: [3] }));
  const design = maxdiffDesign(md, 'resp1');
  const good = Object.fromEntries(design.map((s, i) => [String(i + 1), [s[0], s[1]]]));
  assert.equal(validateAnswer(ctx, md, { v: good }), null);
  assert.match(validateAnswer(ctx, md, { v: { ...good, 3: [design[2][0], design[2][0]] } })!, /Набор 3/);
  assert.ok(validateAnswer(ctx, md, { v: { ...good, 1: [99, design[0][1]] } }));
  const { 9: _last, ...partial } = good;
  assert.match(validateAnswer(ctx, md, { v: partial })!, /набор 9 из 9/);
  const choices = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), i % 4]));
  assert.equal(validateAnswer(ctx, cj, { v: choices }), null);
  assert.ok(validateAnswer(ctx, cj, { v: { ...choices, 1: 4 } }));
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-newtypes-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');
let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

// Настоящая PNG 1×1
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('new types end to end: upload, submit, export, design CSV, cleanup', async () => {
  const cookie = String((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } })).headers['set-cookie']).split(';')[0];
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, auth = true) => {
    const res = await app.inject({ method, url, payload: body as object, headers: auth ? { cookie } : {} });
    return { status: res.statusCode, body: res.body, headers: res.headers, json: res.headers['content-type']?.includes('json') ? res.json() : null };
  };
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(call, s.json.id);

  let st = (await call('POST', `/api/s/${pid}/start`, {}, false)).json;
  const rid = st.rid;
  const submit = async (page: string, v: unknown, o?: Record<string, string>) =>
    (await call('POST', `/api/s/${pid}/submit`, { rid, page, answers: { [page]: { v, ...(o ? { o } : {}) } } }, false));
  st = (await submit('SL', 120)).json;
  st = (await submit('SUM', { 1: 60, 2: 40 })).json;
  st = (await submit('HS', [2])).json;
  assert.equal(st.page, 'PH');

  // Загрузка: подделка не проходит, настоящая картинка — проходит
  const up = async (buf: Buffer, name: string) => app.inject({
    method: 'POST', url: `/api/s/${pid}/upload?rid=${rid}&q=PH`, payload: buf,
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
  });
  assert.equal((await up(Buffer.from('<?php echo 1; ?> not an image at all'), 'evil.png')).statusCode, 415);
  const ok = await up(PNG, 'чек.png');
  assert.equal(ok.statusCode, 200, ok.body);
  const file = ok.json() as { id: string; name: string };
  assert.match(file.id, /^[a-z0-9]{12}\.png$/);
  assert.equal(file.name, 'чек.png');
  assert.equal((await submit('PH', 'aaaaaaaaaaaa.png')).status, 422); // чужой / несуществующий файл
  st = (await submit('PH', file.id, { [file.id]: file.name })).json;

  const design = maxdiffDesign(md, rid);
  st = (await submit('MD', Object.fromEntries(design.map((set, i) => [String(i + 1), [set[0], set[3]]])))).json;
  st = (await submit('CJ', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), (i % 3) + 1])))).json;
  assert.equal(st.status, 'completed');

  // Файл виден команде (картинка — inline), чужому проекту — нет
  const img = await call('GET', `/api/admin/projects/${pid}/files/${rid}/${file.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal((await call('GET', `/api/admin/projects/other/files/${rid}/${file.id}`)).status, 404);

  const csv = (await call('GET', `/api/admin/projects/${pid}/export.csv`)).body.replace(/^﻿/, '').split('\r\n');
  const head = csv[0].split(';');
  const row = csv[1].split(';');
  const val = (n: string) => row[head.indexOf(n)];
  assert.equal(val('SL'), '120');
  assert.equal(val('SUM_1'), '60');
  assert.equal(val('SUM_3'), '0');
  assert.equal(val('HS_2'), '1');
  assert.equal(val('PH_n'), '1');
  assert.equal(val('PH_files'), `${rid}/${file.id}`);
  assert.equal(val('MD_s1_best'), String(design[0][0]));
  assert.equal(val('MD_s9_worst'), String(design[8][3]));
  assert.equal(val('CJ_t2'), '2');

  const mdCsv = (await call('GET', `/api/admin/projects/${pid}/design.csv?q=MD`)).body.replace(/^﻿/, '').split('\r\n');
  assert.equal(mdCsv[0], 'resp_id;set;position;item_code;item;best;worst');
  assert.equal(mdCsv.length, 1 + 9 * 4);
  assert.equal(mdCsv[1], `${rid};1;1;${design[0][0]};Свойство ${design[0][0]};1;0`);
  const cjCsv = (await call('GET', `/api/admin/projects/${pid}/design.csv?q=CJ`)).body.replace(/^﻿/, '').split('\r\n');
  assert.equal(cjCsv[0], 'resp_id;task;card;PRICE;PRICE_text;VOL;VOL_text;BRAND;BRAND_text;chosen;none_chosen');
  assert.equal(cjCsv.length, 1 + 8 * 3);
  assert.equal(cjCsv.slice(1, 4).map((l) => l.split(';')[9]).join(''), '100');
  assert.equal((await call('GET', `/api/admin/projects/${pid}/design.csv?q=SL`)).status, 400);

  // Удаление ответа удаляет и файлы
  await call('DELETE', `/api/admin/projects/${pid}/responses/${rid}`);
  assert.equal((await call('GET', `/api/admin/projects/${pid}/files/${rid}/${file.id}`)).status, 404);
});
