import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import { pipeUrl } from '../shared/logic.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-settings-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => { app = await buildApp(); });
after(() => app.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.json() };
};
const login = async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
};

const base = (settings: Survey['settings']): Survey => ({
  formatVersion: 2, title: 'Настройки', settings,
  blocks: [{ id: 'B1', questions: [
    { id: 'Q1', type: 'single', text: 'Возраст 18+?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }],
      actions: { after: [{ if: { q: 'Q1', op: 'eq', value: 2 }, do: 'screenout' }] } },
  ] }],
});

/** Создаёт и публикует анкету; возвращает её ID (после вызова мы — респондент без входа) */
async function publish(def: Survey): Promise<string> {
  await login();
  const created = await call('POST', '/api/admin/surveys', { definition: def });
  assert.deepEqual(created.json.errors, []);
  await call('POST', `/api/admin/surveys/${created.json.id}/publish`);
  cookie = '';
  return created.json.id;
}

test('settings are validated', () => {
  const r = validateSurvey(base({
    redirectComplete: 'panel.example', maxResponses: 0, accentColor: 'red',
    openFrom: '2026-10-02T00:00:00Z', closeAt: '2026-10-01T00:00:00Z', showQuestionNumbers: 'yes' as unknown as boolean,
  }));
  const where = r.errors.map((e) => e.where).sort();
  assert.deepEqual(where, ['settings.accentColor', 'settings.closeAt', 'settings.maxResponses', 'settings.redirectComplete', 'settings.showQuestionNumbers']);
  assert.ok(validateSurvey(base({ redirectComplete: 'https://p.example/c?id={{param.pid}}&r={{resp_id}}' })).ok);
});

test('redirect urls get url-encoded substitutions', () => {
  const survey = base({});
  const url = pipeUrl('https://p.example/?pid={{param.pid}}&a={{Q1}}&r={{resp_id}}&x={{NOPE}}',
    { survey, answers: { Q1: { v: 2 } }, params: { pid: 'a b&c' }, seed: 'r1' }, 'r1');
  assert.equal(url, 'https://p.example/?pid=a%20b%26c&a=2&r=r1&x=');
});

test('redirects after complete and screenout, message piping', async () => {
  const sid = await publish(base({
    redirectScreenout: 'https://panel.example/so?pid={{param.pid}}',
    completeMessage: 'Спасибо, ответ {{Q1}} записан',
  }));
  let st = (await call('POST', `/api/s/${sid}/start`, { params: { pid: 'P7' } })).json;
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 2 } } })).json;
  assert.equal(st.status, 'screened_out');
  assert.equal(st.redirect, 'https://panel.example/so?pid=P7');

  st = (await call('POST', `/api/s/${sid}/start`, {})).json;
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } })).json;
  assert.equal(st.status, 'completed');
  assert.equal(st.redirect, undefined);
  assert.equal(st.message, 'Спасибо, ответ Да записан');
});

test('password: required for new respondents, never sent to the browser', async () => {
  const sid = await publish(base({ password: 'kod123' }));
  let r = (await call('POST', `/api/s/${sid}/start`, {})).json;
  assert.equal(r.needPassword, true);
  assert.equal(r.error, undefined);
  r = (await call('POST', `/api/s/${sid}/start`, { password: 'nope' })).json;
  assert.equal(r.error, 'Неверный пароль');
  const st = (await call('POST', `/api/s/${sid}/start`, { password: 'kod123' })).json;
  assert.equal(st.page, 'Q1');
  assert.equal(st.survey.settings.password, undefined);
  // Продолжение по rid — без пароля
  const again = (await call('POST', `/api/s/${sid}/start`, { rid: st.rid })).json;
  assert.equal(again.rid, st.rid);
});

test('schedule and response limit close the survey for new respondents', async () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  const past = new Date(Date.now() - 86400_000).toISOString();
  let sid = await publish(base({ openFrom: future }));
  assert.match((await call('POST', `/api/s/${sid}/start`, {})).json.message, /начнётся/);
  sid = await publish(base({ closeAt: past, closedMessage: 'Всё, закрыто' }));
  assert.equal((await call('POST', `/api/s/${sid}/start`, {})).json.message, 'Всё, закрыто');

  sid = await publish(base({ maxResponses: 1 }));
  const a = (await call('POST', `/api/s/${sid}/start`, {})).json;
  const b = (await call('POST', `/api/s/${sid}/start`, {})).json;
  await call('POST', `/api/s/${sid}/submit`, { rid: a.rid, page: 'Q1', answers: { Q1: { v: 1 } } });
  assert.equal((await call('POST', `/api/s/${sid}/start`, {})).json.closed, true);
  // Начавший до набора лимита может закончить
  const done = (await call('POST', `/api/s/${sid}/submit`, { rid: b.rid, page: 'Q1', answers: { Q1: { v: 1 } } })).json;
  assert.equal(done.status, 'completed');
});

test('retake is allowed only when enabled', async () => {
  let sid = await publish(base({}));
  let st = (await call('POST', `/api/s/${sid}/start`, {})).json;
  await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } });
  let again = (await call('POST', `/api/s/${sid}/start`, { rid: st.rid, restart: true })).json;
  assert.equal(again.rid, st.rid);
  assert.equal(again.status, 'completed');

  sid = await publish(base({ allowRetake: true }));
  st = (await call('POST', `/api/s/${sid}/start`, {})).json;
  await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } });
  again = (await call('POST', `/api/s/${sid}/start`, { rid: st.rid, restart: true })).json;
  assert.notEqual(again.rid, st.rid);
  assert.equal(again.page, 'Q1');
});

test('test link opens the draft without login', async () => {
  await login();
  const created = await call('POST', '/api/admin/surveys', { definition: base({}) });
  const sid = created.json.id;
  const token = (await call('GET', `/api/admin/surveys/${sid}`)).json.testToken;
  assert.ok(token);
  cookie = '';
  assert.equal((await call('POST', `/api/s/${sid}/start`, { preview: true })).status, 401);
  assert.equal((await call('POST', `/api/s/${sid}/start`, { test: 'wrong' })).status, 401);
  const st = (await call('POST', `/api/s/${sid}/start`, { test: token })).json;
  assert.equal(st.preview, true);
  assert.equal(st.page, 'Q1');
});

test('question numbers count answered questions', async () => {
  const def = base({ showQuestionNumbers: true });
  def.blocks[0].questions.unshift({ id: 'I1', type: 'info', text: 'Привет' });
  def.blocks[0].questions.push({ id: 'Q2', type: 'text', text: 'Почему?' });
  const sid = await publish(def);
  let st = (await call('POST', `/api/s/${sid}/start`, {})).json;
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'I1', answers: {} })).json;
  assert.equal(st.step, 1);
  st = (await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } })).json;
  assert.equal(st.page, 'Q2');
  assert.equal(st.step, 2);
});

test('archive closes collection and version history restores a draft', async () => {
  const sid = await publish(base({}));
  await login();
  const v1 = base({});
  v1.title = 'Версия 2';
  await call('PUT', `/api/admin/surveys/${sid}`, { definition: v1 });
  await call('POST', `/api/admin/surveys/${sid}/publish`);
  const versions = (await call('GET', `/api/admin/surveys/${sid}/versions`)).json;
  assert.deepEqual(versions.map((v: { version: number }) => v.version), [2, 1]);
  assert.equal((await call('GET', `/api/admin/surveys/${sid}/versions/1`)).json.title, 'Настройки');
  await call('POST', `/api/admin/surveys/${sid}/versions/1/restore`);
  assert.equal((await call('GET', `/api/admin/surveys/${sid}`)).json.draft.title, 'Настройки');

  await call('POST', `/api/admin/surveys/${sid}/archive`, { archived: true });
  const info = (await call('GET', `/api/admin/surveys/${sid}`)).json;
  assert.equal(info.archived, true);
  assert.equal(info.status, 'closed');
  assert.equal((await call('POST', `/api/admin/surveys/${sid}/status`, { status: 'active' })).status, 400);
  assert.equal((await call('GET', '/api/admin/surveys')).json.find((s: { id: string }) => s.id === sid).archived, true);
  cookie = '';
  assert.equal((await call('POST', `/api/s/${sid}/start`, {})).json.closed, true);
});
