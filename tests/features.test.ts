import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { renameId, nextId } from '../shared/refactor.ts';
import { validateSurvey } from '../shared/validate.ts';
import { validateAnswer } from '../shared/answers.ts';
import { buildVariables, type ResponseRecord } from '../shared/variables.ts';
import type { Survey } from '../shared/types.ts';

const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8')) as Survey;

test('renameId updates every reference', () => {
  const s = renameId(demo, 'Q2', 'FAV');
  const json = JSON.stringify(s);
  assert.ok(!/"Q2"/.test(json) && !json.includes('{{Q2}}'));
  assert.equal(s.blocks[1].questions[1].id, 'FAV');
  assert.deepEqual(s.blocks[1].questions[2].showIf, { q: 'FAV', op: 'answered' });
  assert.match(s.blocks[1].questions[2].text, /\{\{FAV\}\}/);
  assert.deepEqual(validateSurvey(s).errors, []);
  // Переименование блока меняет цель перехода
  const b = renameId(demo, 'B_profile', 'B_demo');
  assert.equal(b.blocks[2].id, 'B_demo');
  assert.equal(b.blocks[1].questions[3].actions!.after![0].target, 'B_demo');
  // Скрипты: ID в кавычках
  const withScript = { ...demo, scripts: { init: "sl.shared.x = sl.get('Q2') + sl.get(\"Q20\")" } };
  assert.equal(renameId(withScript, 'Q2', 'FAV').scripts!.init, "sl.shared.x = sl.get('FAV') + sl.get(\"Q20\")");
  assert.equal(nextId(['Q1', 'Q2', 'q3'], 'Q'), 'Q4');
});

test('ranking: validation and export', () => {
  const q = { id: 'R1', type: 'ranking' as const, text: 'Упорядочьте', rankCount: 2,
    options: [{ code: 1, text: 'Цена' }, { code: 2, text: 'Вкус' }, { code: 3, text: 'Сервис' }] };
  const survey: Survey = { formatVersion: 2, title: 't', blocks: [{ id: 'B', questions: [q] }] };
  const ctx = { survey, answers: {}, params: {}, seed: 's' };
  assert.deepEqual(validateSurvey(survey).errors, []);
  assert.match(validateAnswer(ctx, q, { v: [2] })!, /2 первых/);
  assert.equal(validateAnswer(ctx, q, { v: [2, 3] }), null);
  const r = { id: 'r', status: 'completed', answers: { R1: { v: [2, 3] } }, params: {}, startedAt: '2026-01-01T00:00:00Z',
    completedAt: null, durationSec: null, ip: null, userAgent: null, isTest: false, version: 1 } as ResponseRecord;
  const vars = buildVariables(survey, [r]);
  const get = (n: string) => vars.find((v) => v.name === n)!.get(r);
  assert.equal(get('R1_2'), 1);
  assert.equal(get('R1_3'), 2);
  assert.equal(get('R1_1'), null);
});

// ---- API ----
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-f-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
let app: FastifyInstance;
let cookie = '';
before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(() => app?.close());
const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: { cookie } });
  return { status: res.statusCode, json: res.json() };
};

test('simulation walks the survey by its logic', async () => {
  const { json: created } = await call('POST', '/api/admin/surveys', { definition: demo });
  // Тестовое заполнение — в проекте, по черновику анкеты (публиковать не нужно)
  const pid = (await call('POST', '/api/admin/projects', { surveyId: created.id })).json.id;
  const { json } = await call('POST', `/api/admin/projects/${pid}/simulate`, { count: 40 });
  assert.equal(json.count, 40);
  assert.equal((json.stats.completed ?? 0) + (json.stats.screened_out ?? 0), 40);
  const list = (await call('GET', `/api/admin/projects/${pid}/responses`)).json;
  assert.equal(list.length, 40);
  assert.ok(list.every((r: { isTest: boolean }) => r.isTest));
  // Каждый ответ соответствует логике: Q4 ≥ 7 → Q4a не задан
  for (const row of list.slice(0, 15)) {
    const { json: d } = await call('GET', `/api/admin/projects/${pid}/responses/${row.id}`);
    const a = d.response.answers;
    if (d.response.status === 'screened_out') assert.ok(a.S1?.v < 18 || a.S2?.v === 5);
    if (a.Q4 && typeof a.Q4.v === 'number' && a.Q4.v >= 7 && a.Q4.v <= 10) assert.equal(a.Q4a, undefined);
    if (a.Q1?.v?.includes?.(99)) assert.equal(a.Q2, undefined);
  }
  // Удаление одного ответа
  assert.equal((await call('DELETE', `/api/admin/projects/${pid}/responses/${list[0].id}`)).status, 200);
  assert.equal((await call('GET', `/api/admin/projects/${pid}/responses`)).json.length, 39);
});

test('preview can start from a chosen question', async () => {
  const { json: created } = await call('POST', '/api/admin/surveys', { definition: demo });
  const { json: st } = await call('POST', `/api/s/${created.id}/start`, { preview: true, startAt: 'D1' });
  assert.equal(st.page, 'D1');
  assert.equal(st.preview, true);
});
