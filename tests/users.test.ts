import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-users-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

async function login(l: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: l, password: p } });
  return res.statusCode === 200 ? String(res.headers['set-cookie']).split(';')[0] : '';
}
const as = (cookie: string) => async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: { cookie } });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null };
};

test('roles: admin manages users, editor edits, viewer only reads', async () => {
  const admin = as(await login('admin', 'secret'));
  assert.equal((await admin('GET', '/api/admin/me')).json.role, 'admin');
  assert.equal((await admin('POST', '/api/admin/users', { login: 'anna', password: 'short', role: 'editor' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users', { login: 'admin', password: 'longenough', role: 'editor' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users', { login: 'anna', password: 'annapass1', role: 'editor' })).status, 200);
  assert.equal((await admin('POST', '/api/admin/users', { login: 'vova', password: 'vovapass1', role: 'viewer' })).status, 200);
  assert.deepEqual((await admin('GET', '/api/admin/users')).json.map((u: { login: string }) => u.login), ['anna', 'vova']);

  assert.equal(await login('anna', 'wrong'), '');
  const anna = as(await login('ANNA', 'annapass1'));
  const created = await anna('POST', '/api/admin/surveys', {});
  assert.equal(created.status, 200);
  const sid = created.json.id;
  assert.equal((await anna('POST', `/api/admin/surveys/${sid}/publish`)).status, 200);
  assert.equal((await anna('GET', `/api/admin/surveys/${sid}/versions`)).json[0].publishedBy, 'anna');
  // Редактор не управляет пользователями и копиями базы
  assert.equal((await anna('GET', '/api/admin/users')).status, 403);
  assert.equal((await anna('POST', '/api/admin/backups')).status, 403);

  const vova = as(await login('vova', 'vovapass1'));
  assert.equal((await vova('GET', `/api/admin/surveys/${sid}`)).status, 200);
  assert.equal((await vova('GET', `/api/admin/surveys/${sid}/report`)).status, 200);
  assert.equal((await vova('PUT', `/api/admin/surveys/${sid}`, { definition: {} })).status, 403);
  assert.equal((await vova('POST', '/api/admin/surveys', {})).status, 403);
  // Свой пароль наблюдатель сменить может
  assert.equal((await vova('POST', '/api/admin/me/password', { current: 'vovapass1', next: 'vovapass2' })).status, 200);
  assert.equal(await login('vova', 'vovapass1'), '');

  // Отключённый пользователь сразу теряет доступ, даже с действующей сессией
  await admin('PUT', '/api/admin/users/anna', { disabled: true });
  assert.equal((await anna('GET', '/api/admin/surveys')).status, 401);
  assert.equal(await login('anna', 'annapass1'), '');
  await admin('PUT', '/api/admin/users/anna', { disabled: false, role: 'admin' });
  const anna2 = as(await login('anna', 'annapass1'));
  assert.equal((await anna2('PUT', '/api/admin/users/anna', { role: 'viewer' })).status, 400);
  assert.equal((await anna2('DELETE', '/api/admin/users/vova')).status, 200);
});

test('timings, reject, CSV and date filter in exports; per-branch endings', async () => {
  const admin = as(await login('admin', 'secret'));
  const def = {
    formatVersion: 2, title: 'Данные',
    blocks: [{ id: 'B1', questions: [
      { id: 'A', type: 'single', text: 'Возраст', options: [{ code: 1, text: 'до 18' }, { code: 2, text: '18+' }],
        actions: { after: [{ if: { q: 'A', op: 'eq', value: 1 }, do: 'screenout', message: 'Опрос для взрослых', redirect: 'https://p.example/young' }] } },
      { id: 'B', type: 'text', text: 'Комментарий; с разделителем' },
    ] }],
  };
  const sid = (await admin('POST', '/api/admin/surveys', { definition: def })).json.id;
  await admin('POST', `/api/admin/surveys/${sid}/publish`);
  const resp = as('');
  let st = (await resp('POST', `/api/s/${sid}/start`, {})).json;
  st = (await resp('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'A', answers: { A: { v: 1 } } })).json;
  assert.equal(st.status, 'screened_out');
  assert.equal(st.message, 'Опрос для взрослых');
  assert.equal(st.redirect, 'https://p.example/young');

  const ok = (await resp('POST', `/api/s/${sid}/start`, {})).json;
  await resp('POST', `/api/s/${sid}/submit`, { rid: ok.rid, page: 'A', answers: { A: { v: 2 } } });
  await resp('POST', `/api/s/${sid}/submit`, { rid: ok.rid, page: 'B', answers: { B: { v: 'да; "нет"' } } });

  const csv = await app.inject({ method: 'GET', url: `/api/admin/surveys/${sid}/export.csv?timings=1`, headers: { cookie: (await login('admin', 'secret')) } });
  const text = csv.body.replace(/^\ufeff/, '');
  const [head, row] = text.split('\r\n');
  assert.ok(head.split(';').includes('t_A'));
  assert.ok(row.includes('"да; ""нет"""'));

  // Брак: не считается и не выгружается по умолчанию
  await admin('POST', `/api/admin/surveys/${sid}/responses/${ok.rid}/reject`, { rejected: true });
  const info = (await admin('GET', `/api/admin/surveys/${sid}`)).json;
  assert.equal(info.counts.real.completed, undefined);
  assert.equal(info.counts.rejected, 1);
  const cookie = await login('admin', 'secret');
  const without = await app.inject({ method: 'GET', url: `/api/admin/surveys/${sid}/export.csv`, headers: { cookie } });
  assert.equal(without.body.split('\r\n').length, 1);
  const withRejected = await app.inject({ method: 'GET', url: `/api/admin/surveys/${sid}/export.csv?rejected=1`, headers: { cookie } });
  assert.equal(withRejected.body.split('\r\n').length, 2);
  const future = await app.inject({ method: 'GET', url: `/api/admin/surveys/${sid}/export.csv?rejected=1&from=2099-01-01`, headers: { cookie } });
  assert.equal(future.body.split('\r\n').length, 1);
});
