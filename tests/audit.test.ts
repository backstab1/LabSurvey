import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-audit-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');

let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

const as = (cookie: string) => async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null };
};
async function loginAs(login: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password } });
  return as(String(res.headers['set-cookie']).split(';')[0]);
}

const survey: Survey = {
  formatVersion: 2, title: 'Журнал',
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Да?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
};

test('audit log records team actions, coalesces autosave, is admin-only', async () => {
  await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'wrong' } });
  const admin = await loginAs('admin', 'secret');

  const s = await admin('POST', '/api/admin/surveys', { definition: survey });
  await admin('PUT', `/api/admin/surveys/${s.json.id}`, { definition: { ...survey, title: 'Журнал 2' } });
  await admin('PUT', `/api/admin/surveys/${s.json.id}`, { definition: { ...survey, title: 'Журнал 3' } });
  await admin('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(admin, s.json.id, 'Проект журнала');
  await admin('PUT', `/api/admin/projects/${pid}`, { settings: { maxResponses: 10 }, panels: [{ id: 'pa' }] });
  await app.inject({ method: 'GET', url: `/api/admin/projects/${pid}/export.csv?panel=pa`, headers: { cookie: '' } }); // без входа — не пишется
  await admin('GET', `/api/admin/projects/${pid}/export.csv?panel=pa`);
  await admin('PUT', `/api/admin/projects/${pid}`, { title: '' }); // ошибка 400 — не пишется
  await admin('POST', '/api/admin/users', { login: 'viewer1', password: 'password1', role: 'viewer' });
  await admin('DELETE', `/api/admin/projects/${pid}`);

  const { entries, logins } = (await admin('GET', '/api/admin/audit')).json as {
    entries: { login: string; action: string; targetId: string | null; targetTitle: string | null; details: Record<string, unknown> | null }[];
    logins: string[];
  };
  const actions = entries.map((e) => e.action).reverse();
  assert.deepEqual(actions, [
    'Неудачная попытка входа', 'Вошёл в админку', 'Создал анкету', 'Изменил черновик анкеты', 'Опубликовал анкету',
    'Создал проект', 'Сменил статус проекта', 'Изменил проект: настройки сбора, панели', 'Выгрузил данные (CSV)', 'Создал пользователя', 'Удалил проект',
  ]);
  const byAction = (a: string) => entries.find((e) => e.action === a)!;
  assert.equal(byAction('Создал анкету').targetId, s.json.id);
  assert.equal(byAction('Изменил черновик анкеты').targetTitle, 'Журнал 3');
  assert.equal(byAction('Опубликовал анкету').details?.version, 1);
  assert.equal(byAction('Сменил статус проекта').details?.status, 'Сбор данных');
  assert.equal(byAction('Выгрузил данные (CSV)').details?.panel, 'pa');
  assert.equal(byAction('Удалил проект').targetTitle, 'Проект журнала');
  assert.equal(byAction('Создал пользователя').details?.role, 'viewer');
  assert.ok(logins.includes('admin'));

  const filtered = (await admin('GET', `/api/admin/audit?targetType=project&targetId=${pid}`)).json.entries as unknown[];
  assert.equal(filtered.length, 5);
  const viewer = await loginAs('viewer1', 'password1');
  assert.equal((await viewer('GET', '/api/admin/audit')).status, 403);
});
