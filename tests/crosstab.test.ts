import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildCrosstabs } from '../shared/crosstab.ts';
import type { Survey } from '../shared/types.ts';
import type { ResponseRecord } from '../shared/variables.ts';

const survey: Survey = {
  formatVersion: 2, title: 'Таблицы',
  blocks: [{ id: 'B1', questions: [
    { id: 'SEX', type: 'single', text: 'Пол', options: [{ code: 1, text: 'Мужчина' }, { code: 2, text: 'Женщина' }] },
    { id: 'LIKE', type: 'single', text: 'Нравится?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] },
    { id: 'BRANDS', type: 'multi', text: 'Какие бренды знаете?', options: [{ code: 1, text: 'А' }, { code: 2, text: 'Б' }] },
    { id: 'NPS', type: 'scale', text: 'Порекомендуете?', from: 0, to: 10 },
    { id: 'AGE', type: 'number', text: 'Возраст' },
    { id: 'M', type: 'matrix', mode: 'single', text: 'Оценки', rows: [{ code: 1, text: 'Вкус' }, { code: 2, text: 'Цена' }], columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Хорошо' }] },
  ] }],
};

let seq = 0;
const resp = (answers: Record<string, unknown>, params: Record<string, string> = {}): ResponseRecord => ({
  id: `r${++seq}`, status: 'completed', answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, { v }])) as ResponseRecord['answers'],
  params, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:10:00Z', durationSec: 600, ip: null, userAgent: null, isTest: false, version: 1,
});

// 40 мужчин: 30 «да»; 40 женщин: 10 «да» — различие значимо
const data: ResponseRecord[] = [
  ...Array.from({ length: 40 }, (_, i) => resp({ SEX: 1, LIKE: i < 30 ? 1 : 2, BRANDS: i < 20 ? [1, 2] : [1], NPS: 9, AGE: 30 + (i % 5), M: { 1: 2, 2: 1 } }, { panel: 'pa' })),
  ...Array.from({ length: 40 }, (_, i) => resp({ SEX: 2, LIKE: i < 10 ? 1 : 2, BRANDS: [2], NPS: i % 2 ? 5 : 6, AGE: 40 + (i % 5) }, { panel: i < 20 ? 'pa' : 'pb' })),
  resp({ SEX: 1 }), // не ответил на LIKE — не входит в базу
];

test('crosstab: bases, percentages, significance letters, multi, means, matrix rows, params', () => {
  const res = buildCrosstabs(survey, { rows: [{ q: 'LIKE' }, { q: 'BRANDS' }, { q: 'NPS' }, { q: 'AGE' }, { q: 'M' }], cols: [{ q: 'SEX' }, { param: 'panel' }] }, data);
  assert.equal(res.total, 81);
  assert.deepEqual(res.params, ['panel']);

  const like = res.tables.find((t) => t.key === 'LIKE')!;
  assert.deepEqual(like.columns.map((c) => [c.label, c.letter, c.base]), [
    ['Всего', '', 80], ['Мужчина', 'A', 40], ['Женщина', 'B', 40], ['pa', 'A', 60], ['pb', 'B', 20],
  ]);
  const yes = like.rows[0];
  assert.equal(yes.label, 'Да');
  assert.deepEqual(yes.cells.slice(0, 3).map((c) => [c.count, c.colPct]), [[40, 50], [30, 75], [10, 25]]);
  assert.equal(yes.cells[1].sig, 'B'); // мужчины значимо чаще «да»
  assert.equal(yes.cells[2].sig, '');
  assert.equal(yes.cells[1].rowPct, 75); // 30 из 40 «да»
  assert.equal(like.rows[1].cells[2].sig, 'A');

  const brands = res.tables.find((t) => t.key === 'BRANDS')!;
  assert.equal(brands.multi, true);
  assert.deepEqual(brands.rows.map((r) => r.cells[0].count), [40, 60]); // сумма > базы

  const nps = res.tables.find((t) => t.key === 'NPS')!;
  const meanRow = nps.stats!.find((s) => s.label === 'Среднее')!;
  assert.deepEqual(meanRow.cells.slice(0, 3).map((c) => c.value), [7.25, 9, 5.5]);
  assert.equal(meanRow.cells[1].sig, 'B');

  const age = res.tables.find((t) => t.key === 'AGE')!;
  assert.equal(age.rows.length, 0);
  assert.equal(age.stats![0].cells[0].value, 37);

  const matrixRows = res.tables.filter((t) => t.key.startsWith('M.'));
  assert.deepEqual(matrixRows.map((t) => t.key), ['M.1', 'M.2']);
  assert.equal(matrixRows[0].columns[0].base, 40);

  const noSig = buildCrosstabs(survey, { rows: [{ q: 'LIKE' }], cols: [{ q: 'SEX' }], sig: 0 }, data);
  assert.equal(noSig.tables[0].rows[0].cells[1].sig, '');
});

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-crosstab-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');
let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

test('crosstab API: tables, Excel, saved sets, client access', async () => {
  const login = async (l: string, p: string) => String((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: l, password: p } })).headers['set-cookie']).split(';')[0];
  const cookie = await login('admin', 'secret');
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, c = cookie) => {
    const res = await app.inject({ method, url, payload: body as object, headers: c ? { cookie: c } : {} });
    return { status: res.statusCode, headers: res.headers, json: res.headers['content-type']?.includes('json') ? res.json() : null };
  };
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(call, s.json.id);
  for (const [sex, like] of [[1, 1], [1, 1], [2, 2]]) {
    let st = (await call('POST', `/api/s/${pid}/start`, {}, '')).json;
    for (const [page, v] of [['SEX', sex], ['LIKE', like], ['BRANDS', [1]], ['NPS', 7], ['AGE', 33], ['M', { 1: 1, 2: 2 }]] as const) {
      st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page, answers: { [page]: { v } } }, '')).json;
    }
    assert.equal(st.status, 'completed');
  }
  const spec = { rows: [{ q: 'LIKE' }], cols: [{ q: 'SEX' }] };
  const q = `spec=${encodeURIComponent(JSON.stringify(spec))}`;
  const res = (await call('GET', `/api/admin/projects/${pid}/crosstab?${q}`)).json;
  assert.equal(res.total, 3);
  assert.deepEqual(res.tables[0].rows[0].cells.map((c: { count: number }) => c.count), [2, 2, 0]);
  assert.equal((await call('GET', `/api/admin/projects/${pid}/crosstab?spec=oops`)).status, 400);

  const x = await call('GET', `/api/admin/projects/${pid}/crosstab.xlsx?${q}&measures=colPct,count`);
  assert.equal(x.status, 200);
  assert.match(String(x.headers['content-type']), /spreadsheetml/);

  assert.equal((await call('PUT', `/api/admin/projects/${pid}`, { tables: [{ name: '', spec }] })).status, 400);
  await call('PUT', `/api/admin/projects/${pid}`, { tables: [{ name: 'Основные', spec }] });
  assert.deepEqual((await call('GET', `/api/admin/projects/${pid}`)).json.tableSets, [{ name: 'Основные', spec }]);

  await call('POST', '/api/admin/users', { login: 'client1', password: 'password1', role: 'client', projects: [pid] });
  const client = await login('client1', 'password1');
  assert.equal((await call('GET', `/api/admin/projects/${pid}/crosstab?${q}`, undefined, client)).status, 200);
  assert.equal((await call('GET', `/api/admin/projects/${pid}/crosstab.xlsx?${q}`, undefined, client)).status, 200);
  assert.equal((await call('PUT', `/api/admin/projects/${pid}`, { tables: [] }, client)).status, 403);
});
