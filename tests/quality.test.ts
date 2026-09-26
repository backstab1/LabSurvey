import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-quality-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(() => app.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, auth = true) => {
  const res = await app.inject({ method, url, payload: body as object, headers: auth ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};

const scale = [{ code: 1, text: 'Нет' }, { code: 2, text: 'Скорее нет' }, { code: 3, text: 'Скорее да' }, { code: 4, text: 'Да' }];
const survey: Survey = {
  formatVersion: 2, title: 'Качество',
  blocks: [{ id: 'B1', questions: [
    {
      id: 'ATT', type: 'single', text: 'Чтобы показать, что читаете внимательно, выберите «Скорее да»', options: scale,
      attention: { correct: { q: 'ATT', op: 'eq', value: 3 } },
    },
    {
      id: 'M1', type: 'matrix', mode: 'single', text: 'Оцените', straightline: 'screenout', columns: scale,
      rows: [{ code: 1, text: 'Вкус' }, { code: 2, text: 'Цена' }, { code: 3, text: 'Сервис' }],
    },
    { id: 'END', type: 'text', text: 'Комментарий', required: false },
  ] }],
};

async function pass(att: number, m1: Record<string, number>, hp?: string) {
  let st = (await call('POST', `/api/s/${pid}/start`, {}, false)).json;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'ATT', answers: { ATT: { v: att } }, hp }, false)).json;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'M1', answers: { M1: { v: m1 } } }, false)).json;
  if (st.page === 'END') st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'END', answers: {} }, false)).json;
  return st;
}
let pid = '';

test('quality settings are validated', () => {
  assert.ok(validateSurvey(survey).ok, JSON.stringify(validateSurvey(survey).errors));
  const bad = validateSurvey({
    ...survey,
    blocks: [{ id: 'B1', questions: [
      { id: 'A', type: 'text', text: 'x', attention: { correct: { q: 'NOPE', op: 'answered' }, onFail: 'kill' } } as never,
      { id: 'B', type: 'text', text: 'y', straightline: 'flag' } as never,
    ] }],
  }).errors.map((e) => e.message).join(' | ');
  assert.match(bad, /NOPE/);
  assert.match(bad, /onFail/);
  assert.match(bad, /только у матрицы/);
});

test('attention flags, straightlining screens out, honeypot flags, bulk reject', async () => {
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  pid = await launch(call, s.json.id);

  const good = await pass(3, { 1: 2, 2: 3, 3: 4 });
  assert.equal(good.status, 'completed');
  const inattentive = await pass(4, { 1: 2, 2: 3, 3: 4 });
  assert.equal(inattentive.status, 'completed');
  const straight = await pass(3, { 1: 4, 2: 4, 3: 4 });
  assert.equal(straight.status, 'screened_out');
  const bot = await pass(3, { 1: 1, 2: 2, 3: 1 }, 'http://spam.example');
  assert.equal(bot.status, 'completed');

  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  assert.equal(info.counts.suspect, 3);
  const list = (await call('GET', `/api/admin/projects/${pid}/responses`)).json as { id: string; flags: string[] }[];
  const flagsOf = (rid: string) => list.find((r) => r.id === rid)!.flags;
  assert.deepEqual(flagsOf(good.rid), []);
  assert.deepEqual(flagsOf(inattentive.rid), ['attention:ATT']);
  assert.deepEqual(flagsOf(straight.rid), ['straightline:M1']);
  assert.deepEqual(flagsOf(bot.rid), ['bot']);

  const csv = (await call('GET', `/api/admin/projects/${pid}/export.csv?statuses=completed,screened_out`)).json as string;
  const [head, ...rows] = csv.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(';'));
  const col = (name: string) => head.indexOf(name);
  assert.ok(col('suspect') > 0 && col('quality_flags') > 0);
  assert.deepEqual(rows.map((r) => r[col('suspect')]).sort(), ['0', '1', '1', '1']);

  const rej = (await call('POST', `/api/admin/projects/${pid}/reject-suspect`)).json;
  assert.equal(rej.rejected, 3);
  const after = (await call('GET', `/api/admin/projects/${pid}`)).json.counts;
  assert.equal(after.rejected, 3);
  assert.equal(after.suspect, 0);
  assert.equal(after.real.completed, 1);
});
