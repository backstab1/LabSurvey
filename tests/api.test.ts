import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
let cookie = '';
let surveyId = '';
const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8'));

after(() => app.close());

before(async () => {
  app = await buildApp();
});

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null, raw: res };
};
const login = async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
};
const answer = (sid: string, rid: string, page: string, answers: object) =>
  call('POST', `/api/s/${sid}/submit`, { rid, page, answers });

test('admin login and survey import', async () => {
  assert.equal((await call('GET', '/api/admin/surveys')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { login: 'admin', password: 'nope' })).status, 401);
  await login();

  const bad = await call('POST', '/api/admin/surveys', { definition: { formatVersion: 2, title: 'x', blocks: [] } });
  assert.equal(bad.status, 422);

  const created = await call('POST', '/api/admin/surveys', { definition: demo });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.errors, []);
  surveyId = created.json.id;

  // До публикации опрос закрыт для респондентов
  const closed = await call('POST', `/api/s/${surveyId}/start`, {});
  assert.equal(closed.json.closed, true);
  assert.equal((await call('POST', `/api/admin/surveys/${surveyId}/publish`)).json.version, 1);
});

test('respondent path: one question per screen, actions, back, completion', async () => {
  cookie = '';
  let st = (await call('POST', `/api/s/${surveyId}/start`, { params: { utm_source: 'tg', preview: '1' } })).json;
  assert.equal(st.page, 'INTRO');
  assert.deepEqual(st.params, { utm_source: 'tg' });
  const rid = st.rid;

  st = (await answer(surveyId, rid, 'INTRO', {})).json;
  assert.equal(st.page, 'S1');
  const bad = await answer(surveyId, rid, 'S1', { S1: { v: 10 } });
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.S1, /меньше 14/);
  st = (await answer(surveyId, rid, 'S1', { S1: { v: 30 } })).json;
  st = (await answer(surveyId, rid, 'S2', { S2: { v: 2 } })).json;
  assert.equal(st.page, 'Q1');
  assert.ok(st.progress > 0 && st.progress < 100);

  const e = await answer(surveyId, rid, 'Q1', { Q1: { v: [1, 97] } });
  assert.match(e.json.errors.Q1, /Укажите/);
  st = (await answer(surveyId, rid, 'Q1', { Q1: { v: [1, 97], o: { '97': 'Даблби' } } })).json;
  assert.equal(st.page, 'Q2');
  st = (await answer(surveyId, rid, 'Q2', { Q2: { v: 97 } })).json;
  assert.equal(st.page, 'Q3');
  st = (await answer(surveyId, rid, 'Q3', { Q3: { v: { '1': 4, '2': 3, '3': 2 } } })).json;
  assert.equal(st.page, 'Q4');

  // Действие «после ответа»: NPS ≥ 7 → переход к блоку «О вас», Q4a пропускается
  st = (await answer(surveyId, rid, 'Q4', { Q4: { v: 9 } })).json;
  assert.equal(st.page, 'D1');

  // Назад и смена ответа: NPS 3 → теперь задаётся Q4a
  st = (await call('POST', `/api/s/${surveyId}/back`, { rid, page: 'D1', answers: {} })).json;
  assert.equal(st.page, 'Q4');
  assert.equal(st.answers.Q4.v, 9);
  st = (await answer(surveyId, rid, 'Q4', { Q4: { v: 3 } })).json;
  assert.equal(st.page, 'Q4a');
  st = (await answer(surveyId, rid, 'Q4a', { Q4a: { v: 'Дешевле' } })).json;
  assert.equal(st.page, 'D1');

  st = (await answer(surveyId, rid, 'D1', { D1: { v: 1 } })).json;
  st = (await answer(surveyId, rid, 'D2', { D2: { v: '2026-09-01' } })).json;
  const phoneErr = await answer(surveyId, rid, 'D3', { D3: { v: '123' } });
  assert.match(phoneErr.json.errors.D3, /\+7/);
  st = (await answer(surveyId, rid, 'D3', { D3: { v: '8 916 123 45 67' } })).json;
  assert.equal(st.status, 'completed');
  assert.equal(st.page, null);
  assert.equal(st.answers.D3.v, '+79161234567');
  assert.equal(st.answers.Q4a.v, 'Дешевле');

  const again = (await call('POST', `/api/s/${surveyId}/start`, { rid })).json;
  assert.equal(again.status, 'completed');
});

test('screenout and skipping after "none of these"', async () => {
  let st = (await call('POST', `/api/s/${surveyId}/start`, {})).json;
  const rid = st.rid;
  st = (await answer(surveyId, rid, 'INTRO', {})).json;
  const done = (await answer(surveyId, rid, 'S1', { S1: { v: 16 } })).json;
  assert.equal(done.status, 'screened_out');
  assert.match(done.message, /не подходите/);

  // «Ничего из перечисленного» → Q2–Q4a пропускаются
  st = (await call('POST', `/api/s/${surveyId}/start`, {})).json;
  const r2 = st.rid;
  await answer(surveyId, r2, 'INTRO', {});
  await answer(surveyId, r2, 'S1', { S1: { v: 40 } });
  await answer(surveyId, r2, 'S2', { S2: { v: 1 } });
  st = (await answer(surveyId, r2, 'Q1', { Q1: { v: [99] } })).json;
  assert.equal(st.page, 'D1');
});

test('exports', async () => {
  await login();
  const x = await call('GET', `/api/admin/surveys/${surveyId}/export.xlsx?statuses=completed,screened_out`);
  assert.equal(x.status, 200);
  assert.equal(x.raw.rawPayload.subarray(0, 2).toString(), 'PK');
  const s = await call('GET', `/api/admin/surveys/${surveyId}/export.sav`);
  assert.equal(s.raw.rawPayload.subarray(0, 4).toString(), '$FL2');
  const info = await call('GET', `/api/admin/surveys/${surveyId}`);
  assert.deepEqual(info.json.counts.real, { completed: 1, screened_out: 1, in_progress: 1 });
});

test('hidden variables from URL param and from scripts', async () => {
  await login();
  const def = {
    formatVersion: 2, title: 'Hidden',
    blocks: [
      { id: 'B1', questions: [
        { id: 'H_pid', type: 'hidden', text: 'Панелист', fromParam: 'pid' },
        { id: 'H_cell', type: 'hidden', text: 'Ячейка', valueType: 'number' },
        { id: 'Q1', type: 'single', text: 'Q', options: [{ code: 1, text: 'a' }, { code: 2, text: 'b' }],
          scripts: { onChange: "sl.set('H_cell', sl.value * 10)" } },
        { id: 'Q2', type: 'text', text: 'Только для ячейки 20', showIf: { q: 'H_cell', op: 'eq', value: 20 } },
      ] },
    ],
  };
  const created = await call('POST', '/api/admin/surveys', { definition: def });
  assert.deepEqual(created.json.errors, []);
  await call('POST', `/api/admin/surveys/${created.json.id}/publish`);
  cookie = '';
  const sid = created.json.id;
  let st = (await call('POST', `/api/s/${sid}/start`, { params: { pid: 'abc' } })).json;
  assert.equal(st.page, 'Q1');
  assert.equal(st.answers.H_pid.v, 'abc');
  st = (await answer(sid, st.rid, 'Q1', { Q1: { v: 2 }, H_cell: { v: 20 } })).json;
  assert.equal(st.page, 'Q2');
  st = (await answer(sid, st.rid, 'Q2', { Q2: { v: 'ok' } })).json;
  assert.equal(st.status, 'completed');
  assert.equal(st.answers.H_cell.v, 20);
  assert.equal(st.answers.H_pid.v, 'abc');
  // Некорректное значение скрытой переменной игнорируется
  const st2 = (await call('POST', `/api/s/${sid}/start`, {})).json;
  const done = (await answer(sid, st2.rid, 'Q1', { Q1: { v: 1 }, H_cell: { v: [1, 2] } })).json;
  assert.equal(done.status, 'completed');
  assert.equal(done.answers.H_cell, undefined);
});

test('old page-based surveys are migrated on import', async () => {
  await login();
  const v1 = {
    formatVersion: 1, title: 'Old',
    pages: [
      { id: 'P1', questions: [{ id: 'A', type: 'number', text: 'Возраст' }], jumps: [{ if: { q: 'A', op: 'lt', value: 18 }, goTo: 'SCREENOUT' }] },
      { id: 'P2', showIf: { q: 'A', op: 'gte', value: 30 }, questions: [{ id: 'B', type: 'text', text: '30+' }] },
    ],
  };
  const created = await call('POST', '/api/admin/surveys', { definition: v1 });
  assert.deepEqual(created.json.errors, []);
  const info = (await call('GET', `/api/admin/surveys/${created.json.id}`)).json;
  assert.equal(info.draft.formatVersion, 2);
  assert.deepEqual(info.draft.blocks.map((b: { id: string }) => b.id), ['P1', 'P2']);
  assert.deepEqual(info.draft.blocks[0].questions[0].actions.after, [{ if: { q: 'A', op: 'lt', value: 18 }, do: 'screenout' }]);
  assert.deepEqual(info.draft.blocks[1].questions[0].showIf, { q: 'A', op: 'gte', value: 30 });
});
