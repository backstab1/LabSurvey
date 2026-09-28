// Защита данных: балл риска и сигналы открытых ответов, проверка браузера, отпечаток устройства,
// подпись ссылок панели и постбэк, согласие на обработку ПДн, новые виды матрицы, дашборд для заказчика.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { validateSurvey } from '../shared/validate.ts';
import { aiTextSignals, looksLikeAi, qualityScore, textFlags } from '../shared/quality.ts';
import { buildVariables } from '../shared/variables.ts';
import { buildReport } from '../shared/report.ts';
import type { Panel, Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-protect-'));
process.env.ADMIN_PASSWORD = 'secret';
process.env.BACKUP_HOURS = '0';
process.env.BOT_CHECK_BITS = '8';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');
const { signUrl, verifyEntry, postbackTiming } = await import('../server/panelLinks.ts');
const { sha256Hex, sha256Words } = await import('../web/src/runner/botcheck.ts');

let app: FastifyInstance;
let cookie = '';
let hook: Server;
let hookUrl = '';
const hits: string[] = [];
before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  postbackTiming.scale = 0.001;
  hook = createServer((req, res) => { hits.push(req.url ?? ''); res.statusCode = req.url?.includes('fail') ? 500 : 200; res.end('ok'); });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}`;
});
after(async () => { await app.close(); hook.close(); });

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, auth = true) => {
  const res = await app.inject({ method, url, payload: body as object, headers: auth ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  for (let t = 0; t < ms; t += 20) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('не дождались');
};

const survey: Survey = {
  formatVersion: 2, title: 'Защита',
  blocks: [{ id: 'B1', questions: [
    { id: 'C1', type: 'consent', text: 'Согласие на обработку данных', declineLabel: 'Не согласен', declineMessage: 'Жаль, до свидания' },
    { id: 'Q1', type: 'single', text: 'Пол', options: [{ code: 1, text: 'М' }, { code: 2, text: 'Ж' }] },
    { id: 'T1', type: 'text', text: 'Почему?', required: false },
    {
      id: 'CS', type: 'matrix', view: 'cards', mode: 'single', text: 'Разложите',
      rows: [{ code: 1, text: 'Цена' }, { code: 2, text: 'Скорость' }], columns: [{ code: 1, text: 'Важно' }, { code: 2, text: 'Не важно' }],
    },
    {
      id: 'SD', type: 'matrix', view: 'differential', mode: 'single', text: 'Бренд',
      rows: [{ code: 1, text: 'Дорогой', right: 'Дешёвый' }], columns: [1, 2, 3, 4, 5].map((code) => ({ code, text: String(code) })),
    },
  ] }],
};

let sid = '';
async function run(pid: string, opts: { text?: string; tm?: unknown; consent?: number; start?: Record<string, unknown> } = {}) {
  let st = (await call('POST', `/api/s/${pid}/start`, opts.start ?? {}, false)).json;
  if (st.closed || st.needCheck) return st;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'C1', answers: { C1: { v: opts.consent ?? 1, o: { at: 'подделка' } } } }, false)).json;
  if (st.status !== 'in_progress') return st;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } }, false)).json;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'T1', answers: opts.text ? { T1: { v: opts.text } } : {}, tm: opts.tm }, false)).json;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'CS', answers: { CS: { v: { 1: 1, 2: 2 } } } }, false)).json;
  st = (await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'SD', answers: { SD: { v: { 1: 4 } } } }, false)).json;
  return st;
}
const responseOf = async (pid: string, rid: string) => (await call('GET', `/api/admin/projects/${pid}/responses/${rid}`)).json.response;

test('new question kinds validate; consent and differential in exports and report', () => {
  assert.ok(validateSurvey(survey).ok, JSON.stringify(validateSurvey(survey).errors));
  const bad = validateSurvey({
    ...survey,
    blocks: [{ id: 'B1', questions: [
      { id: 'D', type: 'matrix', view: 'differential', mode: 'multi', text: 'x', rows: [{ code: 1, text: 'a' }], columns: [{ code: 1, text: '1' }] },
      { id: 'K', type: 'matrix', view: 'cards', mode: 'single', text: 'x', rows: [{ code: 1, text: 'a', other: true }], columns: [{ code: 1, text: 'g' }] },
      { id: 'C', type: 'consent', text: ' ' },
    ] }],
  }).errors.map((e) => e.message).join(' | ');
  assert.match(bad, /только один ответ/);
  assert.match(bad, /правый полюс/);
  assert.match(bad, /от 3 до 11/);
  assert.match(bad, /«Другое» не поддерживаются/);
  assert.match(bad, /хотя бы 2 группы/);
  assert.match(bad, /текст согласия/);

  const r = { id: 'r1', status: 'completed' as const, answers: { C1: { v: 1, o: { at: '2026-09-28T10:00:00.000Z' } }, SD: { v: { 1: 4 } } }, params: {}, startedAt: '', completedAt: null, durationSec: null, ip: null, userAgent: null, isTest: false, version: 1 };
  const vars = buildVariables(survey, [r]);
  const v = (name: string) => vars.find((x) => x.name === name)!;
  assert.equal(v('C1').get(r), 1);
  assert.equal((v('C1_at').get(r) as Date).toISOString(), '2026-09-28T10:00:00.000Z');
  assert.match(v('SD_1').label, /Дорогой – Дешёвый/);
  const rep = buildReport(survey, [r]);
  assert.equal(rep.questions.find((q) => q.id === 'SD')!.matrix![0].label, 'Дорогой – Дешёвый');
  assert.deepEqual(rep.questions.find((q) => q.id === 'C1')!.rows!.map((x) => x.count), [1, 0]);
});

test('quality signals: score, AI-like text, paste and typing', () => {
  assert.equal(qualityScore(['paste:T1']), 30);
  assert.equal(qualityScore(['paste:T1', 'aitext:T1']), 60);
  assert.equal(qualityScore(['bot', 'attention:Q']), 100);
  assert.ok(looksLikeAi('Как языковая модель, я не могу иметь предпочтений в доставке еды.'));
  assert.ok(looksLikeAi('В целом, доставка удобна. Важно отметить, что цены растут — это заметно.'));
  assert.ok(!looksLikeAi('да норм всё быстро привозят только дорого'));
  assert.deepEqual(aiTextSignals('коротко'), []);
  assert.deepEqual(textFlags('T1', 'Привозят быстро, но дорого и часто холодное', { k: 1, p: 0 }), ['notyping:T1']);
  assert.deepEqual(textFlags('T1', 'Привозят быстро, но дорого и часто холодное', { k: 40, p: 0 }), []);
  assert.deepEqual(textFlags('T1', 'Привозят быстро, но дорого и часто холодное', { k: 0, p: 45 }), ['paste:T1']);
  assert.deepEqual(textFlags('T1', 'коротко', { k: 0, p: 7 }), []);
});

test('browser sha256 matches node and solves the challenge', () => {
  for (const s of ['', 'abc', 'Опрос 😊', 'x'.repeat(200)]) assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
  assert.equal(sha256Words('abc').length, 8);
});

test('consent: server time stamp, decline screens out with its message', async () => {
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  sid = s.json.id;
  await call('POST', `/api/admin/surveys/${sid}/publish`);
  const pid = await launch(call, sid);
  const ok = await run(pid, { text: 'Потому что удобно заказывать домой' });
  assert.equal(ok.status, 'completed');
  const saved = await responseOf(pid, ok.rid);
  assert.equal(saved.answers.C1.v, 1);
  assert.ok(Date.parse(saved.answers.C1.o.at) > Date.now() - 60_000, 'время согласия ставит сервер');
  const no = await run(pid, { consent: 0 });
  assert.equal(no.status, 'screened_out');
  assert.match(no.message, /Жаль/);
  // Без отказа в анкете 0 не принимается
  const strict = await call('POST', '/api/admin/surveys', { definition: { ...survey, blocks: [{ id: 'B', questions: [{ id: 'C1', type: 'consent', text: 'Согласие' }, survey.blocks[0].questions[1]] }] } });
  await call('POST', `/api/admin/surveys/${strict.json.id}/publish`);
  const pid2 = await launch(call, strict.json.id);
  const st = (await call('POST', `/api/s/${pid2}/start`, {}, false)).json;
  const r = await call('POST', `/api/s/${pid2}/submit`, { rid: st.rid, page: 'C1', answers: { C1: { v: 0 } } }, false);
  assert.equal(r.status, 422);
  const r2 = await call('POST', `/api/s/${pid2}/submit`, { rid: st.rid, page: 'C1', answers: {} }, false);
  assert.match(r2.json.errors.C1, /согласие/);
});

test('open answers: paste, duplicates, AI text; speeders; score and auto-reject', async () => {
  const pid = await launch(call, sid);
  await call('PUT', `/api/admin/projects/${pid}`, { settings: { minDurationSec: 600 } });
  const text = 'Заказываю, когда нет времени готовить ужин';
  const a = await run(pid, { text, tm: { T1: { k: 45, p: 0 } } });
  const b = await run(pid, { text, tm: { T1: { k: 45, p: 0 } } });
  const c = await run(pid, { text: 'В целом, сервис удобен. Важно отметить, что цены — высокие.', tm: { T1: { k: 0, p: 60 } } });
  const flags = async (rid: string) => (await responseOf(pid, rid)).flags as string[];
  assert.deepEqual(await flags(a.rid), ['speeder']);
  assert.deepEqual((await flags(b.rid)).sort(), ['duptext:T1', 'speeder']);
  assert.deepEqual((await flags(c.rid)).sort(), ['aitext:T1', 'paste:T1', 'speeder']);
  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  assert.equal(info.counts.suspect, 2, 'speeder alone (40) is not suspect; +50 and +60 are');

  await call('PUT', `/api/admin/projects/${pid}`, { settings: { minDurationSec: 600, autoRejectScore: 90 } });
  const d = await run(pid, { text: 'Как языковая модель, я не могу оценить доставку еды', tm: { T1: { k: 0, p: 60 } } });
  assert.equal(d.status, 'completed');
  const dr = await responseOf(pid, d.rid);
  assert.equal(dr.rejected, true, 'score 100 ≥ 90 – auto reject');
  const csv = (await call('GET', `/api/admin/projects/${pid}/export.csv?statuses=completed&rejected=1`)).json as string;
  assert.match(csv.split('\r\n')[0], /quality_score/);
});

test('bot check: challenge, solution, replay; automation and device flags', async () => {
  const pid = await launch(call, sid);
  await call('PUT', `/api/admin/projects/${pid}`, { settings: { botCheck: true, deviceCheck: 'flag' } });
  const first = (await call('POST', `/api/s/${pid}/start`, {}, false)).json;
  assert.ok(first.needCheck);
  const c = first.challenge;
  let n = 0;
  while (createHash('sha256').update(`${c.salt}${n}`).digest()[0] !== 0) n++;
  const pow = { ...c, n };
  const fp = 'a'.repeat(32);
  const ok = (await call('POST', `/api/s/${pid}/start`, { pow, fp, wd: true }, false)).json;
  assert.equal(ok.status, 'in_progress');
  assert.deepEqual((await responseOf(pid, ok.rid)).flags, ['automation']);
  const replay = (await call('POST', `/api/s/${pid}/start`, { pow, fp }, false)).json;
  assert.ok(replay.needCheck, 'решение одноразовое');
  const fake = (await call('POST', `/api/s/${pid}/start`, { pow: { ...pow, sig: 'x' }, fp }, false)).json;
  assert.ok(fake.needCheck);
  // Второе прохождение с того же устройства — пометка
  const c2 = (await call('POST', `/api/s/${pid}/start`, {}, false)).json.challenge;
  let n2 = 0;
  while (createHash('sha256').update(`${c2.salt}${n2}`).digest()[0] !== 0) n2++;
  const again = (await call('POST', `/api/s/${pid}/start`, { pow: { ...c2, n: n2 }, fp }, false)).json;
  assert.deepEqual((await responseOf(pid, again.rid)).flags, ['device']);
  // «Не пускать»: завершённая анкета с этого устройства закрывает опрос
  await call('PUT', `/api/admin/projects/${pid}`, { settings: { deviceCheck: 'block' } });
  const fp2 = 'b'.repeat(32);
  const done = await run(pid, { start: { fp: fp2 } });
  assert.equal(done.status, 'completed');
  const blocked = (await call('POST', `/api/s/${pid}/start`, { fp: fp2 }, false)).json;
  assert.ok(blocked.closed);
});

test('panel links: signed redirects, entry verification, postbacks', async () => {
  const panel: Panel = {
    id: 'pn', idParam: 'uid', hashSecret: 's3cret', verifyEntry: true,
    redirectComplete: 'https://panel.example/done?uid={{param.uid}}',
    redirectQuality: 'https://panel.example/quality?uid={{param.uid}}',
    postbackUrl: `${hookUrl}/pb?uid={{param.uid}}&status={{status}}`,
  };
  const signed = signUrl(panel, 'https://x.example/s/abc?panel=pn&uid=7');
  assert.ok(verifyEntry(panel, signed));
  assert.ok(!verifyEntry(panel, signed.replace('uid=7', 'uid=8')));
  assert.ok(!verifyEntry({ ...panel, hashFormat: 'base64' }, signed));

  const pid = await launch(call, sid);
  assert.equal((await call('PUT', `/api/admin/projects/${pid}`, { panels: [panel] })).status, 200);
  const bad = (await call('POST', `/api/s/${pid}/start`, { params: { panel: 'pn', uid: '7' }, url: `https://x.example/s/${pid}?panel=pn&uid=7&hash=00` }, false)).json;
  assert.ok(bad.closed, 'неверная подпись');
  const entry = signUrl(panel, `https://x.example/s/${pid}?panel=pn&uid=7`);
  const done = await run(pid, { start: { params: { panel: 'pn', uid: '7' }, url: entry } });
  assert.equal(done.status, 'completed');
  assert.match(done.redirect, /^https:\/\/panel\.example\/done\?uid=7&hash=[0-9a-f]{64}$/);
  assert.ok(verifyEntry(panel, done.redirect), 'редирект подписан тем же секретом');
  await waitFor(() => hits.some((h) => h.includes('uid=7&status=complete&hash=')));
  await waitFor(async () => (await responseOf(pid, done.rid)).postback?.ok === true);
  // Брак командой — постбэк quality
  await call('POST', `/api/admin/projects/${pid}/responses/${done.rid}/reject`, { rejected: true });
  await waitFor(() => hits.some((h) => h.includes('status=quality')));
  // Панель не отвечает — ошибка сохраняется, видна в счётчиках
  await call('PUT', `/api/admin/projects/${pid}`, { panels: [{ ...panel, verifyEntry: undefined, postbackUrl: `${hookUrl}/fail?uid={{param.uid}}` }] });
  const failed = await run(pid, { start: { params: { panel: 'pn', uid: '9' } } });
  await waitFor(async () => (await responseOf(pid, failed.rid)).postback?.ok === false);
  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  assert.equal(info.panelCounts.find((p: { panel: string }) => p.panel === 'pn').postbackFailed, 1);
  assert.equal(hits.filter((h) => h.startsWith('/fail')).length, 3, 'три попытки');
});

test('dashboard: off by default, aggregates only, subgroup, new token', async () => {
  const pid = await launch(call, sid);
  await run(pid, { text: 'Секретный открытый ответ про доставку' });
  const on = await call('PUT', `/api/admin/projects/${pid}`, { dashboard: { enabled: true, hideQuestions: ['SD'] } });
  assert.equal(on.status, 200);
  const token = (await call('GET', `/api/admin/projects/${pid}`)).json.dashboard.token as string;
  assert.ok(token.length >= 20);
  const d = await call('GET', `/api/dash/${token}`, undefined, false);
  assert.equal(d.status, 200);
  assert.equal(d.json.counts.completed, 1);
  const ids = d.json.report.questions.map((q: { id: string }) => q.id);
  assert.deepEqual(ids, ['Q1', 'CS']);
  assert.ok(!JSON.stringify(d.json).includes('Секретный'), 'открытые ответы не попадают на дашборд');
  assert.deepEqual(d.json.filters.map((f: { id: string }) => f.id), ['Q1']);
  const sub = (await call('GET', `/api/dash/${token}?q=Q1&c=2`, undefined, false)).json;
  assert.equal(sub.report.total, 0);
  assert.match(sub.filter.label, /Пол: Ж/);
  await call('POST', `/api/admin/projects/${pid}/dashboard/token`);
  assert.equal((await call('GET', `/api/dash/${token}`, undefined, false)).status, 404);
  const token2 = (await call('GET', `/api/admin/projects/${pid}`)).json.dashboard.token;
  await call('PUT', `/api/admin/projects/${pid}`, { dashboard: { enabled: false } });
  assert.equal((await call('GET', `/api/dash/${token2}`, undefined, false)).status, 404);
  assert.equal((await call('GET', `/api/admin/projects/${pid}`)).json.dashboard.token, token2, 'токен сохраняется при выключении');
});
