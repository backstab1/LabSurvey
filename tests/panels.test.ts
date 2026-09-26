import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validatePanels } from '../shared/validate.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-panels-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');

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
  formatVersion: 2, title: 'Панели',
  settings: { redirectComplete: 'https://survey.example/done', redirectScreenout: 'https://survey.example/so' },
  blocks: [{ id: 'B1', questions: [
    {
      id: 'S1', type: 'single', text: 'Возраст', options: [{ code: 1, text: '18+' }, { code: 2, text: 'Младше' }],
      actions: { after: [{ if: { q: 'S1', op: 'eq', value: 2 }, do: 'screenout' }] },
    },
  ] }],
};

/** Проходит анкету без входа в админку: 1 — завершает, 2 — отсеивается */
async function pass(pid: string, params: Record<string, string>, code = 1) {
  const saved = cookie;
  cookie = '';
  try {
    const st = (await call('POST', `/api/s/${pid}/start`, { params })).json;
    if (st.page !== 'S1') return st;
    return (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'S1', answers: { S1: { v: code } } })).json;
  } finally { cookie = saved; }
}

test('panels are validated', () => {
  assert.deepEqual(validatePanels([{ id: 'a', idParam: 'uid', redirectComplete: 'https://x.example/?id={{param.uid}}' }]), []);
  const errs = validatePanels([
    { id: 'bad code' }, { id: 'A' }, { id: 'a' }, { id: 'b', idParam: 'panel' }, { id: 'c', limit: 0 }, { id: 'd', redirectScreenout: 'ftp://x' },
  ]).join(' | ');
  assert.match(errs, /латиница/);
  assert.match(errs, /уже есть/);
  assert.match(errs, /занят опросом/);
  assert.match(errs, /лимит/);
  assert.match(errs, /http/);
});

test('panel redirects, per-panel dedupe, limit, stop and counters', async () => {
  await login();
  const created = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${created.json.id}/publish`);
  const pid = await launch(call, created.json.id);

  const bad = await call('PUT', `/api/admin/projects/${pid}`, { panels: [{ id: 'x y' }] });
  assert.equal(bad.status, 422);
  const ok = await call('PUT', `/api/admin/projects/${pid}`, { panels: [
    {
      id: 'pa', title: 'Панель А', idParam: 'uid', limit: 2,
      redirectComplete: 'https://pa.example/c?uid={{param.uid}}', redirectOverquota: 'https://pa.example/q?uid={{param.uid}}',
    },
    { id: 'pb', title: 'Панель Б' },
  ] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  // Редирект панели важнее редиректа анкеты; без редиректа панели — редирект анкеты
  let st = await pass(pid, { panel: 'pa', uid: 'u1' });
  assert.equal(st.status, 'completed');
  assert.equal(st.redirect, 'https://pa.example/c?uid=u1');
  st = await pass(pid, { panel: 'pa', uid: 'u2' }, 2);
  assert.equal(st.status, 'screened_out');
  assert.equal(st.redirect, 'https://survey.example/so');
  st = await pass(pid, { panel: 'pb' });
  assert.equal(st.redirect, 'https://survey.example/done');

  // Без ID панели ссылка неполная; тот же ID повторно не пускает; тот же ID на другой панели — можно
  st = await pass(pid, { panel: 'pa' });
  assert.equal(st.closed, true);
  st = await pass(pid, { panel: 'pa', uid: 'u1' });
  assert.match(st.message, /уже прошли/);
  st = await pass(pid, { panel: 'pb', uid: 'u1' });
  assert.equal(st.status, 'completed');

  // Лимит панели: 2 завершённых — дальше «Сверх квоты» с редиректом панели
  st = await pass(pid, { panel: 'pa', uid: 'u3' });
  assert.equal(st.status, 'completed');
  st = await pass(pid, { panel: 'pa', uid: 'u4' });
  assert.equal(st.status, 'overquota');
  assert.equal(st.redirect, 'https://pa.example/q?uid=u4');

  // Остановленная панель не принимает новых
  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  await call('PUT', `/api/admin/projects/${pid}`, { panels: info.panels.map((p: { id: string }) => (p.id === 'pb' ? { ...p, closed: true } : p)) });
  st = await pass(pid, { panel: 'pb' });
  assert.equal(st.closed, true);

  // Прямая ссылка — без панели
  st = await pass(pid, {});
  assert.equal(st.status, 'completed');

  const counts = (await call('GET', `/api/admin/projects/${pid}`)).json.panelCounts as { panel: string | null; statuses: Record<string, number> }[];
  const of = (p: string | null) => counts.find((c) => c.panel === p)?.statuses ?? {};
  assert.deepEqual(of('pa'), { completed: 2, screened_out: 1, overquota: 1 });
  assert.deepEqual(of('pb'), { completed: 2 });
  assert.deepEqual(of(null), { completed: 1 });

  // Выгрузка по одной панели
  const res = await app.inject({ method: 'GET', url: `/api/admin/projects/${pid}/export.csv?statuses=completed&panel=pa`, headers: { cookie } });
  assert.equal(res.body.trim().split('\r\n').length, 1 + 2);
  const direct = await app.inject({ method: 'GET', url: `/api/admin/projects/${pid}/export.csv?statuses=completed&panel=-`, headers: { cookie } });
  assert.equal(direct.body.trim().split('\r\n').length, 1 + 1);
});
