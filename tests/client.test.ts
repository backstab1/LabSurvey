import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-client-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');
const { clientAllowed } = await import('../server/auth.ts');
const { dailyStats } = await import('../server/daily.ts');

let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

const as = (cookie: string) => async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null };
};
async function loginAs(login: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login, password } });
  assert.equal(res.statusCode, 200, res.body);
  return as(String(res.headers['set-cookie']).split(';')[0]);
}

const survey: Survey = {
  formatVersion: 2, title: 'Для заказчика',
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Да?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
};

test('client paths whitelist', () => {
  const mine = ['p1'];
  assert.ok(clientAllowed('GET', '/api/admin/projects', mine));
  assert.ok(clientAllowed('GET', '/api/admin/projects/p1', mine));
  assert.ok(clientAllowed('GET', '/api/admin/projects/p1/report?statuses=completed', mine));
  assert.ok(clientAllowed('GET', '/api/admin/projects/p1/export.xlsx', mine));
  assert.ok(clientAllowed('GET', '/api/admin/projects/p1/responses/abc', mine));
  assert.ok(clientAllowed('POST', '/api/admin/me/password', mine));
  assert.ok(!clientAllowed('GET', '/api/admin/projects/p2', mine));
  assert.ok(!clientAllowed('GET', '/api/admin/surveys', mine));
  assert.ok(!clientAllowed('PUT', '/api/admin/projects/p1', mine));
  assert.ok(!clientAllowed('POST', '/api/admin/projects/p1/copy', mine));
  assert.ok(!clientAllowed('POST', '/api/admin/projects/p1/responses/abc/reject', mine));
});

test('client sees only own projects, read-only, without service fields; copy makes a new wave', async () => {
  const admin = await loginAs('admin', 'secret');
  const s = await admin('POST', '/api/admin/surveys', { definition: survey });
  await admin('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const p1 = await launch(admin, s.json.id, 'Волна 1');
  const p2 = await launch(admin, s.json.id, 'Чужой проект');
  await admin('PUT', `/api/admin/projects/${p1}`, {
    settings: { password: 'pw123', maxResponses: 100 },
    panels: [{ id: 'pa', title: 'Панель А', redirectComplete: 'https://pa.example/c' }],
    quotas: [{ id: 'QT1', if: { q: 'Q1', op: 'eq', value: 1 }, limit: 5 }],
  });

  const bad = await admin('POST', '/api/admin/users', { login: 'client1', password: 'password1', role: 'client', projects: 'x' });
  assert.equal(bad.status, 400);
  const created = await admin('POST', '/api/admin/users', { login: 'client1', password: 'password1', role: 'client', projects: [p1, 'nope'] });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const users = (await admin('GET', '/api/admin/users')).json as { login: string; projects: string[] }[];
  assert.deepEqual(users.find((u) => u.login === 'client1')?.projects, [p1]);

  const client = await loginAs('client1', 'password1');
  const list = (await client('GET', '/api/admin/projects')).json as { id: string }[];
  assert.deepEqual(list.map((p) => p.id), [p1]);

  const info = (await client('GET', `/api/admin/projects/${p1}`)).json;
  assert.equal(info.testToken, '');
  assert.equal(info.settings.password, undefined);
  assert.equal(info.settings.maxResponses, 100);
  assert.deepEqual(info.panels, [{ id: 'pa', title: 'Панель А' }]);

  assert.equal((await client('GET', `/api/admin/projects/${p2}`)).status, 403);
  assert.equal((await client('GET', '/api/admin/surveys')).status, 403);
  assert.equal((await client('GET', `/api/admin/surveys/${s.json.id}`)).status, 403);
  assert.equal((await client('PUT', `/api/admin/projects/${p1}`, { title: 'x' })).status, 403);
  assert.equal((await client('POST', `/api/admin/projects/${p1}/status`, { status: 'processing' })).status, 403);
  assert.equal((await client('GET', `/api/admin/projects/${p1}/report`)).status, 200);
  assert.equal((await client('GET', `/api/admin/projects/${p1}/export.csv`)).status, 200);
  // Предпросмотр черновика заказчику не положен
  const preview = await client('POST', `/api/s/${s.json.id}/start`, { preview: true, surveyPreview: true });
  assert.equal(preview.status, 401);

  // Копия: анкета, настройки, квоты, панели; без ответов, статус «Разработка»
  const pass = await as('')('POST', `/api/s/${p1}/start`, { password: 'pw123' });
  await as('')('POST', `/api/s/${p1}/submit`, { rid: pass.json.rid, page: 'Q1', answers: { Q1: { v: 1 } } });
  const copy = await admin('POST', `/api/admin/projects/${p1}/copy`, { title: 'Волна 2' });
  assert.equal(copy.status, 200);
  const c = (await admin('GET', `/api/admin/projects/${copy.json.id}`)).json;
  assert.equal(c.title, 'Волна 2');
  assert.equal(c.status, 'development');
  assert.equal(c.settings.password, 'pw123');
  assert.equal(c.quotaDefs.length, 1);
  assert.equal(c.panels[0].redirectComplete, 'https://pa.example/c');
  assert.deepEqual(c.counts.real, {});
  // Заказчик копию не видит, пока её не выдали
  assert.equal((await client('GET', `/api/admin/projects/${copy.json.id}`)).status, 403);

  // Динамика по дням в карточке проекта
  const daily = (await admin('GET', `/api/admin/projects/${p1}`)).json.daily as { started: number; completed: number }[];
  assert.equal(daily.length, 1);
  assert.equal(daily[0].started, 1);
  assert.equal(daily[0].completed, 1);
});

test('daily stats fill empty days and count endings by finish day', () => {
  const now = new Date('2026-03-10T09:00:00Z');
  const days = dailyStats([
    { startedAt: '2026-03-07T10:00:00Z', completedAt: '2026-03-07T10:10:00Z', status: 'completed' },
    { startedAt: '2026-03-07T20:55:00Z', completedAt: '2026-03-07T21:05:00Z', status: 'screened_out' },
    { startedAt: '2026-03-09T10:00:00Z', completedAt: null, status: 'in_progress' },
  ], now);
  // Москва: 21:05 UTC — уже 8 марта
  assert.deepEqual(days.map((d) => d.day), ['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.deepEqual(days.map((d) => [d.started, d.completed, d.screenedOut]), [[2, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 0]]);
});
