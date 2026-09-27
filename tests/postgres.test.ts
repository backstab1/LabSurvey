// PostgreSQL через настоящий драйвер pg: сервис работает с базой по сетевому протоколу PostgreSQL
// (сервер — PGlite с pglite-socket, отдельный PostgreSQL для тестов не нужен). Плюс перенос данных SQLite → PostgreSQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Survey } from '../shared/types.ts';

const pgServer = new PGLiteSocketServer({ db: await PGlite.create(), port: 0, host: '127.0.0.1' });
await pgServer.start();
const port = ((pgServer as unknown as { server: { address(): AddressInfo } }).server.address()).port;
const url = `postgres://postgres@127.0.0.1:${port}/postgres`;

const dir = mkdtempSync(join(tmpdir(), 'surveylab-pg-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'secret';
process.env.DATABASE_URL = url;
// PGlite — одна сессия на все подключения: одно соединение, чтобы транзакции не смешивались
process.env.DATABASE_POOL = '1';
const { buildApp } = await import('../server/app.ts');
const { sql } = await import('../server/db.ts');
const { launch } = await import('./helpers.ts');
const { makeBackup } = await import('../server/backup.ts');
const { copyDatabase } = await import('../server/tools/db-copy.ts');
const { openSql } = await import('../server/sql.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(async () => { await app.close(); await sql.close(); await pgServer.stop(); });

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, auth = true) => {
  const res = await app.inject({ method, url, payload: body as object, headers: auth ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : res.body, raw: res.rawPayload };
};

const survey: Survey = {
  formatVersion: 2, title: 'PG',
  blocks: [{ id: 'B1', questions: [
    { id: 'S1', type: 'number', text: 'Возраст', min: 1, max: 99, actions: { after: [{ if: { q: 'S1', op: 'lt', value: 18 }, do: 'screenout' }] } },
    { id: 'Q1', type: 'multi', text: 'Что пьёте?', options: [{ code: 1, text: 'Чай' }, { code: 2, text: 'Кофе' }] },
  ] }],
};

test('service on PostgreSQL (pg driver): surveys, projects, responses, panels, counts, export, audit, users', async () => {
  assert.equal(sql.kind, 'postgres');
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  assert.equal((await call('POST', `/api/admin/surveys/${s.json.id}/publish`)).status, 200);
  const pid = await launch(call, s.json.id);
  await call('PUT', `/api/admin/projects/${pid}`, { panels: [{ id: 'vk', idParam: 'uid' }] });

  // Два респондента: один завершил с панели, второй отсеян
  const a = (await call('POST', `/api/s/${pid}/start`, { params: { panel: 'vk', uid: 'u1' } }, false)).json;
  await call('POST', `/api/s/${pid}/submit`, { rid: a.rid, page: 'S1', answers: { S1: { v: 30 } } }, false);
  const done = (await call('POST', `/api/s/${pid}/submit`, { rid: a.rid, page: 'Q1', answers: { Q1: { v: [1, 2] } } }, false)).json;
  assert.equal(done.status, 'completed');
  // Тот же ID панелиста второй раз не пройдёт (поиск по JSON-параметрам)
  const again = (await call('POST', `/api/s/${pid}/start`, { params: { panel: 'vk', uid: 'u1' } }, false)).json;
  assert.equal(again.closed, true);
  assert.match(again.message, /уже прошли/);
  const b = (await call('POST', `/api/s/${pid}/start`, {}, false)).json;
  assert.equal((await call('POST', `/api/s/${pid}/submit`, { rid: b.rid, page: 'S1', answers: { S1: { v: 12 } } }, false)).json.status, 'screened_out');

  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  assert.equal(info.counts.real.completed, 1);
  assert.equal(info.counts.real.screened_out, 1);
  const sources = info.panelCounts as { panel: string | null; statuses: Record<string, number> }[];
  assert.equal(sources.find((x) => x.panel === 'vk')?.statuses.completed, 1);
  assert.equal(sources.find((x) => x.panel === null)?.statuses.screened_out, 1);

  const xlsx = await call('GET', `/api/admin/projects/${pid}/export.xlsx`);
  assert.equal(xlsx.status, 200);
  assert.ok(xlsx.raw.length > 1000);

  // Пользователи: логин без учёта регистра
  assert.equal((await call('POST', '/api/admin/users', { login: 'Anna', password: 'pass12345', role: 'viewer' })).status, 200);
  assert.equal((await call('POST', '/api/admin/users', { login: 'anna', password: 'pass12345', role: 'viewer' })).status, 400);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'ANNA', password: 'pass12345' } });
  assert.equal(login.statusCode, 200);

  // Журнал с поиском без учёта регистра
  const log = (await call('GET', '/api/admin/audit?q=ОПУБЛИКОВАЛ')).json;
  assert.ok(log.entries.some((e: { action: string }) => e.action === 'Опубликовал анкету'));

  // Персональные ссылки: вставка порциями, повторы по ID
  const people = Array.from({ length: 450 }, (_, i) => ({ extId: String(i % 400), fields: { email: `p${i}@example.ru` } }));
  assert.deepEqual((await call('POST', `/api/admin/projects/${pid}/invitees`, { people })).json, { added: 400, skipped: 50 });
  const list = (await call('GET', `/api/admin/projects/${pid}/invitees`)).json as { id: number }[];
  assert.equal((await call('POST', `/api/admin/projects/${pid}/invitees/delete`, { ids: list.slice(0, 10).map((p) => p.id) })).json.deleted, 10);

  // Резервная копия PostgreSQL — выгрузка .json.gz
  const backup = await makeBackup();
  assert.match(backup.name, /\.json\.gz$/);
  assert.ok(backup.size > 100);
});

test('moving to PostgreSQL: SQLite file → PostgreSQL → json.gz → SQLite, row counts and ids preserved', async () => {
  // Источник — SQLite с данными
  const srcFile = join(dir, 'src.db');
  const src = await openSql({ sqliteFile: srcFile });
  const { initSchema } = await import('../server/schema.ts');
  await initSchema(src);
  const t = new Date().toISOString();
  await src.run("INSERT INTO surveys (id, title, draft, created_at, updated_at) VALUES ('s1', 'Анкета', ?, ?, ?)", [JSON.stringify(survey), t, t]);
  await src.run("INSERT INTO projects (id, title, survey_id, created_at, updated_at) VALUES ('p1', 'Проект', 's1', ?, ?)", [t, t]);
  await src.run(`INSERT INTO responses (id, project_id, survey_id, version, status, answers, params, started_at, updated_at)
    VALUES ('r1', 'p1', 's1', 1, 'completed', '{"S1":{"v":30}}', '{"panel":"vk"}', ?, ?)`, [t, t]);
  for (let i = 0; i < 5; i++) await src.run("INSERT INTO audit (at, action) VALUES (?, 'x')", [t]);
  await src.run('DELETE FROM audit WHERE id <= 2');
  await src.close();

  // В чистую базу PostgreSQL (отдельная PGlite)
  const pgDir = join(dir, 'pg2');
  const counts = await copyDatabase(srcFile, `pglite:${pgDir}`, () => {});
  assert.equal(counts.responses, 1);
  assert.equal(counts.audit, 3);
  const pg2 = await openSql({ url: `pglite:${pgDir}`, sqliteFile: '' });
  // id сохранились, счётчик сдвинут за последний: новая запись не конфликтует
  assert.deepEqual((await pg2.all('SELECT id FROM audit ORDER BY id')).map((r) => r.id), [3, 4, 5]);
  const ins = await pg2.get("INSERT INTO audit (at, action) VALUES (?, 'y') RETURNING id", [t]);
  assert.equal(ins!.id, 6);
  assert.equal((await pg2.get("SELECT params::jsonb ->> 'panel' AS p FROM responses"))!.p, 'vk');
  await pg2.close();

  // Повторная загрузка в непустую базу запрещена
  await assert.rejects(copyDatabase(srcFile, `pglite:${pgDir}`, () => {}), /не пустая/);

  // PostgreSQL → выгрузка → новая SQLite
  const dumpFile = join(dir, 'export.json.gz');
  await copyDatabase(`pglite:${pgDir}`, dumpFile, () => {});
  const back = await copyDatabase(dumpFile, join(dir, 'back.db'), () => {});
  assert.equal(back.audit, 4);
  assert.equal(back.responses, 1);
});
