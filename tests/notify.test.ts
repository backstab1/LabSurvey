import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-notify-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
let hook: Server;
let hookUrl = '';
const received: any[] = [];
let cookie = '';

before(async () => {
  app = await buildApp();
  // Локальный приёмник вебхуков
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
});
after(() => { app.close(); hook.close(); });

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, json: res.json() };
};
const waitFor = async (n: number) => {
  for (let i = 0; i < 100 && received.length < n; i++) await new Promise((r) => setTimeout(r, 20));
};

const survey: Survey = {
  formatVersion: 2, title: 'Уведомления',
  settings: { maxResponses: 2 },
  quotas: [{ id: 'QT1', title: 'Все', if: { q: 'Q1', op: 'answered' }, limit: 1 }],
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'text', text: 'Как дела?' }] }],
};

test('webhook gets completed, quota and limit events', async () => {
  const lr = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(lr.headers['set-cookie']).split(';')[0];
  const sid = (await call('POST', '/api/admin/surveys', { definition: survey })).json.id;
  await call('POST', `/api/admin/surveys/${sid}/publish`);
  assert.equal((await call('PUT', `/api/admin/surveys/${sid}/notify`, { webhookUrl: 'ftp://x' })).status, 400);
  await call('PUT', `/api/admin/surveys/${sid}/notify`, { webhookUrl: hookUrl, everyN: 1, quotaFull: true, limitReached: true });

  assert.equal((await call('POST', `/api/admin/surveys/${sid}/notify/test`)).status, 200);
  await waitFor(1);
  assert.equal(received[0].event, 'test');

  cookie = '';
  const st = (await call('POST', `/api/s/${sid}/start`, { params: { pid: 'P1' } })).json;
  await call('POST', `/api/s/${sid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 'хорошо' } } });
  await waitFor(3);
  const events = received.slice(1).map((e) => e.event).sort();
  assert.deepEqual(events, ['completed', 'quota_full']);
  const done = received.find((e) => e.event === 'completed');
  assert.equal(done.count, 1);
  assert.equal(done.response.answers.Q1.v, 'хорошо');
  assert.equal(done.survey.title, 'Уведомления');
});

test('database backups: create, list, download', async () => {
  const lr = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(lr.headers['set-cookie']).split(';')[0];
  const made = (await call('POST', '/api/admin/backups')).json;
  assert.match(made.name, /^surveylab-.*\.db$/);
  assert.ok(made.size > 0);
  const list = (await call('GET', '/api/admin/backups')).json.list;
  assert.equal(list[0].name, made.name);
  const file = await app.inject({ method: 'GET', url: `/api/admin/backups/${made.name}`, headers: { cookie } });
  assert.equal(file.rawPayload.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/backups/..%2F.session-secret', headers: { cookie } })).statusCode, 404);
});
