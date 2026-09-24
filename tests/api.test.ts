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

test('admin login and survey import', async () => {
  assert.equal((await call('GET', '/api/admin/surveys')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { login: 'admin', password: 'nope' })).status, 401);
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  assert.equal(res.statusCode, 200);
  cookie = String(res.headers['set-cookie']).split(';')[0];

  const bad = await call('POST', '/api/admin/surveys', { definition: { formatVersion: 1, title: 'x', pages: [] } });
  assert.equal(bad.status, 422);

  const created = await call('POST', '/api/admin/surveys', { definition: demo });
  assert.equal(created.status, 200);
  surveyId = created.json.id;

  // До публикации опрос закрыт для респондентов
  const closed = await call('POST', `/api/s/${surveyId}/start`, {});
  assert.equal(closed.json.closed, true);
  assert.equal((await call('POST', `/api/admin/surveys/${surveyId}/publish`)).json.version, 1);
});

test('full respondent path with validation, carry-forward, back and completion', async () => {
  cookie = '';
  let st = (await call('POST', `/api/s/${surveyId}/start`, { params: { utm_source: 'tg', preview: '1' } })).json;
  assert.equal(st.page, 'P_intro');
  assert.deepEqual(st.params, { utm_source: 'tg' });
  const rid = st.rid;

  const bad = await call('POST', `/api/s/${surveyId}/submit`, { rid, page: 'P_intro', answers: { S1: { v: 10 } } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.errors.S1 && bad.json.errors.S2);

  st = (await call('POST', `/api/s/${surveyId}/submit`, { rid, page: 'P_intro', answers: { S1: { v: 30 }, S2: { v: 2 } } })).json;
  assert.equal(st.page, 'P_brands');
  assert.ok(st.progress > 0 && st.progress < 100);

  // Q2 скрыт до выбора в Q1 на той же странице; выбор «Другое» без текста — ошибка
  const e = await call('POST', `/api/s/${surveyId}/submit`, { rid, page: 'P_brands', answers: { Q1: { v: [1, 97] } } });
  assert.match(e.json.errors.Q1, /Укажите/);
  st = (await call('POST', `/api/s/${surveyId}/submit`, {
    rid, page: 'P_brands', answers: { Q1: { v: [1, 97], o: { '97': 'Даблби' } }, Q2: { v: 97 } },
  })).json;
  assert.equal(st.page, 'P_eval');

  // Назад и обратно
  st = (await call('POST', `/api/s/${surveyId}/back`, { rid, page: 'P_eval', answers: { Q4: { v: 9 } } })).json;
  assert.equal(st.page, 'P_brands');
  assert.equal(st.answers.Q4.v, 9);
  // Меняем ответ: «Ничего из перечисленного» → страница оценки пропускается
  st = (await call('POST', `/api/s/${surveyId}/submit`, { rid, page: 'P_brands', answers: { Q1: { v: [99] } } })).json;
  assert.equal(st.page, 'P_profile');

  const phoneErr = await call('POST', `/api/s/${surveyId}/submit`, {
    rid, page: 'P_profile', answers: { D1: { v: 1 }, D2: { v: '2026-09-01' }, D3: { v: '123' } },
  });
  assert.match(phoneErr.json.errors.D3, /\+7/);
  st = (await call('POST', `/api/s/${surveyId}/submit`, {
    rid, page: 'P_profile', answers: { D1: { v: 1 }, D2: { v: '2026-09-01' }, D3: { v: '8 916 123 45 67' } },
  })).json;
  assert.equal(st.status, 'completed');
  assert.equal(st.page, null);
  // Ответы из брошенной ветки удалены, телефон нормализован
  assert.equal(st.answers.Q2, undefined);
  assert.equal(st.answers.Q4, undefined);
  assert.equal(st.answers.D3.v, '+79161234567');

  // Повторный start с тем же rid показывает финальный экран
  const again = (await call('POST', `/api/s/${surveyId}/start`, { rid })).json;
  assert.equal(again.status, 'completed');
});

test('screenout', async () => {
  const st = (await call('POST', `/api/s/${surveyId}/start`, {})).json;
  const done = (await call('POST', `/api/s/${surveyId}/submit`, { rid: st.rid, page: 'P_intro', answers: { S1: { v: 16 }, S2: { v: 1 } } })).json;
  assert.equal(done.status, 'screened_out');
  assert.match(done.message, /не подходите/);
});

test('exports', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  const x = await call('GET', `/api/admin/surveys/${surveyId}/export.xlsx?statuses=completed,screened_out`);
  assert.equal(x.status, 200);
  assert.equal(x.raw.rawPayload.subarray(0, 2).toString(), 'PK');
  const s = await call('GET', `/api/admin/surveys/${surveyId}/export.sav`);
  assert.equal(s.raw.rawPayload.subarray(0, 4).toString(), '$FL2');
  const info = await call('GET', `/api/admin/surveys/${surveyId}`);
  assert.deepEqual(info.json.counts.real, { completed: 1, screened_out: 1 });
});

test('hidden variables from URL param and from scripts', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  const def = {
    formatVersion: 1, title: 'Hidden',
    pages: [
      { id: 'P1', questions: [
        { id: 'H_pid', type: 'hidden', text: 'Панелист', fromParam: 'pid' },
        { id: 'H_cell', type: 'hidden', text: 'Ячейка', valueType: 'number' },
        { id: 'Q1', type: 'single', text: 'Q', options: [{ code: 1, text: 'a' }, { code: 2, text: 'b' }],
          scripts: { onChange: "sl.set('H_cell', sl.value * 10)" } },
      ] },
      { id: 'P2', showIf: { q: 'H_cell', op: 'eq', value: 20 }, questions: [{ id: 'Q2', type: 'text', text: 'Только для ячейки 20' }] },
    ],
  };
  const created = await call('POST', '/api/admin/surveys', { definition: def });
  assert.deepEqual(created.json.errors, []);
  await call('POST', `/api/admin/surveys/${created.json.id}/publish`);
  cookie = '';
  const sid = created.json.id;
  let st = (await call('POST', `/api/s/${sid}/start`, { params: { pid: 'abc' } })).json;
  assert.equal(st.answers.H_pid.v, 'abc');
  // Страница P1 содержит только скрытые переменные + Q1 — она видима
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'P1', answers: { Q1: { v: 2 }, H_cell: { v: 20 } } })).json;
  assert.equal(st.page, 'P2');
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'P2', answers: { Q2: { v: 'ok' } } })).json;
  assert.equal(st.status, 'completed');
  assert.equal(st.answers.H_cell.v, 20);
  assert.equal(st.answers.H_pid.v, 'abc');
  // Некорректное значение скрытой переменной игнорируется
  const st2 = (await call('POST', `/api/s/${sid}/start`, {})).json;
  const done = (await call('POST', `/api/s/${sid}/submit`, { rid: st2.rid, page: 'P1', answers: { Q1: { v: 1 }, H_cell: { v: [1, 2] } } })).json;
  assert.equal(done.status, 'completed');
  assert.equal(done.answers.H_cell, undefined);
});
