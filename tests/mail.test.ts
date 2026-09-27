import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-mail-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');
const mail = await import('../server/mail.ts');

let app: FastifyInstance;
let cookie = '';
type Msg = { to: string; subject: string; text: string; html: string };
const outbox: Msg[] = [];
/** Адреса, на которые «почтовый сервер» отвечает ошибкой */
const reject = new Set<string>();
let serverDown = false;

before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  mail.setMailSenderForTests(async (m) => {
    if (serverDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (reject.has(m.to)) throw Object.assign(new Error('550 Mailbox not found'), { responseCode: 550 });
    outbox.push(m);
  });
});
after(async () => { mail.stopMailer(); mail.setMailSenderForTests(null); await app.close(); });

const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
  const res = await app.inject({ method, url, payload: body as object, headers: { cookie, host: 'surveys.test' } });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};

const survey: Survey = {
  formatVersion: 2, title: 'Сотрудники',
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Нравится?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
};

/** Дождаться, пока очередь опустеет */
async function drain(pid: string) {
  for (let i = 0; i < 200; i++) {
    const r = (await call('GET', `/api/admin/projects/${pid}/mailings`)).json as { list: { pending: number; sent: number; failed: number; finishedAt: string | null }[] };
    if (r.list.every((m) => m.pending === 0)) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('Очередь не опустела');
}

test('mail template: substitutions, html button, escaping', () => {
  const p = { fields: { name: 'Анна <b>', otdel: 'IT' }, extId: '1024', token: 'tok' };
  const m = mail.renderMail({ subject: 'Опрос для {{param.otdel}}\n', body: 'Привет, **{{param.name}}**!\n\n{{link}}\n\nID {{inv_id}}, {{param.nope}}.' }, p, 'https://s.ru/', 'P1');
  assert.equal(m.subject, 'Опрос для IT');
  assert.ok(m.text.includes('https://s.ru/s/P1?inv=tok'));
  assert.ok(m.text.includes('ID 1024, .'));
  assert.ok(m.html.includes('<b>Анна &lt;b&gt;</b>'), 'жирный и экранирование');
  assert.ok(m.html.includes('>Пройти опрос</a>'), 'строка со ссылкой — кнопка');
});

test('mailing: invite, skip bad addresses, reminder only to those who did not finish, errors per person', async () => {
  mail.startMailer({ intervalMs: 1 });
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(call, s.json.id);
  await call('POST', `/api/admin/projects/${pid}/invitees`, { people: [
    { extId: '1', fields: { name: 'Анна', email: 'anna@example.ru' } },
    { extId: '2', fields: { name: 'Иван', email: 'ivan@example.ru' } },
    { extId: '3', fields: { name: 'Без почты' } },
    { extId: '4', fields: { name: 'Кривой', email: 'not-an-email' } },
    { extId: '5', fields: { name: 'Нет ящика', email: 'gone@example.ru' } },
  ] });
  reject.add('gone@example.ru');
  const tpl = { subject: 'Опрос', body: 'Здравствуйте, {{param.name}}!\n\n{{link}}', emailField: 'email' };

  // Проверки шаблона
  assert.equal((await call('POST', `/api/admin/projects/${pid}/mailings`, { ...tpl, body: 'без ссылки', audience: 'not_sent' })).status, 400);
  assert.equal((await call('POST', `/api/admin/projects/${pid}/mailings`, { ...tpl, emailField: 'phone', audience: 'not_sent' })).status, 400);

  // Тестовое письмо — с данными первого человека
  const t = await call('POST', `/api/admin/projects/${pid}/mailings/test`, { ...tpl, to: 'me@example.ru' });
  assert.equal(t.status, 200);
  assert.equal(outbox.at(-1)!.subject, '[Тест] Опрос');
  assert.ok(outbox.at(-1)!.text.includes('Здравствуйте, Анна!'));
  outbox.length = 0;

  const first = await call('POST', `/api/admin/projects/${pid}/mailings`, { ...tpl, audience: 'not_sent' });
  assert.equal(first.status, 200);
  assert.equal(first.json.mailing.total, 3);
  assert.equal(first.json.noEmail, 2);
  const done = await drain(pid);
  assert.deepEqual(outbox.map((m) => m.to).sort(), ['anna@example.ru', 'ivan@example.ru']);
  const annaMail = outbox.find((m) => m.to === 'anna@example.ru')!;
  assert.match(annaMail.text, new RegExp(`http://surveys\\.test/s/${pid}\\?inv=\\w+`));
  const m1 = done.list[0];
  assert.deepEqual([m1.sent, m1.failed, !!m1.finishedAt], [2, 1, true]);

  let list = (await call('GET', `/api/admin/projects/${pid}/invitees`)).json as { extId: string; token: string; mailSentAt: string | null; mailCount: number; mailError: string | null }[];
  assert.ok(list.find((p) => p.extId === '1')!.mailSentAt);
  assert.match(list.find((p) => p.extId === '5')!.mailError!, /550/);

  // Повтор «кому ещё не отправляли» — только тот, у кого была ошибка (ящик починили)
  reject.clear();
  outbox.length = 0;
  const retry = await call('POST', `/api/admin/projects/${pid}/mailings`, { ...tpl, audience: 'not_sent' });
  assert.equal(retry.json.mailing.total, 1);
  await drain(pid);
  assert.deepEqual(outbox.map((m) => m.to), ['gone@example.ru']);

  // Анна прошла опрос — напоминание уходит только остальным
  const anna = list.find((p) => p.extId === '1')!;
  const st = (await call('POST', `/api/s/${pid}/start`, { params: { inv: anna.token } })).json;
  await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } });
  outbox.length = 0;
  const remind = await call('POST', `/api/admin/projects/${pid}/mailings`, { ...tpl, subject: 'Напоминание', audience: 'not_completed' });
  assert.equal(remind.json.mailing.total, 2);
  await drain(pid);
  assert.deepEqual(outbox.map((m) => m.to).sort(), ['gone@example.ru', 'ivan@example.ru']);
  list = (await call('GET', `/api/admin/projects/${pid}/invitees`)).json;
  assert.equal(list.find((p) => p.extId === '2')!.mailCount, 2);
});

test('mailing: server outage keeps the queue, cancel removes unsent letters', async () => {
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(call, s.json.id);
  await call('POST', `/api/admin/projects/${pid}/invitees`, { people: [
    { extId: 'a', fields: { email: 'a@example.ru' } }, { extId: 'b', fields: { email: 'b@example.ru' } },
  ] });
  serverDown = true;
  outbox.length = 0;
  const r = await call('POST', `/api/admin/projects/${pid}/mailings`, { subject: 'X', body: '{{link}}', emailField: 'email', audience: 'all' });
  await new Promise((res) => setTimeout(res, 50));
  const status = (await call('GET', `/api/admin/projects/${pid}/mailings`)).json;
  assert.equal(status.list[0].pending, 2, 'письма ждут, а не помечаются ошибкой');
  assert.match(status.serverError.message, /ECONNREFUSED/);
  // Остановить рассылку — очередь пуста, писем нет
  assert.equal((await call('POST', `/api/admin/projects/${pid}/mailings/${r.json.mailing.id}/cancel`)).status, 200);
  const after = (await call('GET', `/api/admin/projects/${pid}/mailings`)).json;
  assert.equal(after.list[0].pending, 0);
  assert.equal(after.list[0].cancelled, true);
  serverDown = false;
  assert.equal(outbox.length, 0);
});
