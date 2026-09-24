import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import { renameId } from '../shared/refactor.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-quotas-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => { app = await buildApp(); });
after(() => app.close());

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.json() };
};
const login = async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
};

const survey: Survey = {
  formatVersion: 2, title: 'Квоты',
  settings: { redirectOverquota: 'https://panel.example/qf?pid={{param.pid}}' },
  quotas: [
    { id: 'QT_m', title: 'Мужчины', if: { q: 'SEX', op: 'eq', value: 1 }, limit: 2 },
    { id: 'QT_vk', title: 'Из VK', if: { param: 'src', op: 'eq', value: 'vk' }, limit: 0 },
  ],
  blocks: [{ id: 'B1', questions: [
    { id: 'SEX', type: 'single', text: 'Пол', options: [{ code: 1, text: 'М' }, { code: 2, text: 'Ж' }] },
    { id: 'Q1', type: 'text', text: 'Почему?' },
  ] }],
};

async function pass(sid: string, sex: number, params: Record<string, string> = {}) {
  let st = (await call('POST', `/api/s/${sid}/start`, { params })).json;
  if (st.page !== 'SEX') return st;
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'SEX', answers: { SEX: { v: sex } } })).json;
  if (st.page !== 'Q1') return st;
  return (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 'ok' } } })).json;
}

test('quotas are validated and follow renames', () => {
  assert.ok(validateSurvey(survey).ok);
  const bad = validateSurvey({ ...survey, quotas: [{ id: 'QT1', if: { q: 'NOPE', op: 'eq', value: 1 }, limit: -1 }, { id: 'qt1', if: { q: 'SEX', op: 'answered' }, limit: 1 }] });
  const msgs = bad.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /NOPE/);
  assert.match(msgs, /limit/);
  assert.match(msgs, /повторяется/);
  assert.equal((renameId(survey, 'SEX', 'D1').quotas![0].if as { q: string }).q, 'D1');
});

test('full quota ends the survey with overquota status and redirect', async () => {
  await login();
  const created = await call('POST', '/api/admin/surveys', { definition: survey });
  const sid = created.json.id;
  await call('POST', `/api/admin/surveys/${sid}/publish`);
  cookie = '';

  assert.equal((await pass(sid, 1)).status, 'completed');
  assert.equal((await pass(sid, 1)).status, 'completed');
  // Третий мужчина — сверх квоты сразу после ответа на квотный вопрос
  const over = await pass(sid, 1, { pid: 'X9' });
  assert.equal(over.status, 'overquota');
  assert.equal(over.redirect, 'https://panel.example/qf?pid=X9');
  assert.equal((await pass(sid, 2)).status, 'completed');
  // Квота по параметру ссылки с лимитом 0 закрыта с самого начала
  assert.equal((await pass(sid, 2, { src: 'vk' })).status, 'overquota');

  await login();
  const info = (await call('GET', `/api/admin/surveys/${sid}`)).json;
  assert.deepEqual(info.quotas.map((q: { id: string; count: number }) => [q.id, q.count]), [['QT_m', 2], ['QT_vk', 0]]);
  assert.equal(info.counts.real.overquota, 2);
});
