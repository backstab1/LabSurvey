// Эталонная анкета со всеми типами вопросов и приёмами (examples/full-demo.json): сервер должен
// принять её, пройти ботами и построить по ней отчёт, таблицы и все выгрузки без ошибок.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import { analyzeFlow } from '../shared/flow.ts';
import { imageLibrary } from '../shared/images.ts';
import { QUESTION_TYPE_LABELS, type QuestionType, type Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-full-'));
process.env.ADMIN_PASSWORD = 'secret';
process.env.BACKUP_HOURS = '0';
const { buildApp } = await import('../server/app.ts');
let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

const def: Survey = JSON.parse(readFileSync(new URL('../examples/full-demo.json', import.meta.url), 'utf8'));

test('full demo: covers every question type, valid, routes ok, images collected', () => {
  const used = new Set(def.blocks.flatMap((b) => b.questions.map((q) => q.type)));
  const missing = (Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).filter((t) => !used.has(t));
  assert.deepEqual(missing, [], 'в эталонной анкете должен быть каждый тип вопроса – добавьте новый тип в examples/full-demo.json');
  const v = validateSurvey(def);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(analyzeFlow(def).issues, []);
  assert.ok(imageLibrary(def).length >= 7);
});

test('full demo: import, publish, bots, report, crosstabs and every export', async () => {
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as never, headers: { cookie } });
    assert.ok(r.statusCode < 400, `${method} ${url}: ${r.statusCode} ${r.body.slice(0, 300)}`);
    return r;
  };
  const survey = (await call('POST', '/api/admin/surveys', { definition: def })).json();
  await call('POST', `/api/admin/surveys/${survey.id}/publish`);
  const project = (await call('POST', '/api/admin/projects', { surveyId: survey.id })).json();
  const sim = (await call('POST', `/api/admin/projects/${project.id}/simulate`, { count: 60 })).json();
  assert.ok((sim.stats.completed ?? 0) > 10, JSON.stringify(sim.stats));

  const report = (await call('GET', `/api/admin/projects/${project.id}/report?statuses=completed,screened_out,overquota&test=1`)).json();
  assert.ok(report.total > 0);
  const spec = { rows: def.blocks.flatMap((b) => b.questions).filter((q) => q.type !== 'info' && q.type !== 'hidden').map((q) => ({ q: q.id })), cols: [{ q: 'S2' }], statuses: ['completed'], sig: 0.95, test: true };
  await call('GET', `/api/admin/projects/${project.id}/crosstab?spec=${encodeURIComponent(JSON.stringify(spec))}`);
  await call('GET', `/api/admin/projects/${project.id}/crosstab.xlsx?spec=${encodeURIComponent(JSON.stringify(spec))}&measures=colPct,count`);
  const q = 'statuses=completed,screened_out,overquota,terminated,in_progress&test=1&timings=1';
  for (const format of ['xlsx', 'sav', 'csv']) {
    const r = await call('GET', `/api/admin/projects/${project.id}/export.${format}?${q}`);
    assert.ok(r.rawPayload.length > 100, format);
  }
  for (const id of ['X1', 'X2']) await call('GET', `/api/admin/projects/${project.id}/design.csv?q=${id}&statuses=completed&test=1`);
  // Каждый ответ открывается
  const list = (await call('GET', `/api/admin/projects/${project.id}/responses`)).json() as { id: string }[];
  for (const r of list.slice(0, 20)) await call('GET', `/api/admin/projects/${project.id}/responses/${r.id}`);
});
