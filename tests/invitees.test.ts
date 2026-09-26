import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paramName, parseTable } from '../shared/tableImport.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-invitees-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
const { launch } = await import('./helpers.ts');

let app: FastifyInstance;
let cookie = '';
before(async () => {
  app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
after(() => app.close());

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, auth = true) => {
  const res = await app.inject({ method, url, payload: body as object, headers: auth ? { cookie } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : res.body };
};

const survey: Survey = {
  formatVersion: 2, title: 'Сотрудники',
  blocks: [{ id: 'B1', questions: [
    { id: 'Q1', type: 'single', text: '{{param.name}}, вам нравится работа?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] },
    { id: 'Q2', type: 'text', text: 'Почему?', required: false },
  ] }],
};

test('table import: delimiters, quotes, header translit', () => {
  assert.deepEqual(parseTable('ID\tИмя\n1\tАнна\n\n2\t"Иван ""Ваня"""\n'), [['ID', 'Имя'], ['1', 'Анна'], ['2', 'Иван "Ваня"']]);
  assert.deepEqual(parseTable('﻿id;name\r\n7;"Петров; П."'), [['id', 'name'], ['7', 'Петров; П.']]);
  assert.deepEqual(parseTable('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  const used = new Set<string>();
  assert.deepEqual(['Отдел', 'E-mail', 'Отдел', '2 фамилия', 'test'].map((h) => paramName(h, used)), ['otdel', 'e-mail', 'otdel2', 'familiya', 'test_']);
});

test('personal links: one response per person, fields become params, invite-only, reissue', async () => {
  const s = await call('POST', '/api/admin/surveys', { definition: survey });
  await call('POST', `/api/admin/surveys/${s.json.id}/publish`);
  const pid = await launch(call, s.json.id);

  assert.equal((await call('POST', `/api/admin/projects/${pid}/invitees`, { people: [{ fields: { 'Имя': 'x' } }] })).status, 400);
  const add = await call('POST', `/api/admin/projects/${pid}/invitees`, { people: [
    { extId: '1024', fields: { name: 'Анна', otdel: 'Продажи' } },
    { extId: '1025', fields: { name: 'Иван', otdel: 'IT' } },
    { extId: '1024', fields: { name: 'Повтор' } },
  ] });
  assert.deepEqual(add.json, { added: 2, skipped: 1 });
  let list = (await call('GET', `/api/admin/projects/${pid}/invitees`)).json as { id: number; token: string; extId: string; status: string | null }[];
  const anna = list.find((p) => p.extId === '1024')!;

  // Ссылка работает, поля списка — параметры ответа (важнее параметров в адресе)
  const st = (await call('POST', `/api/s/${pid}/start`, { params: { inv: anna.token, name: 'Хакер' } }, false)).json;
  assert.equal(st.page, 'Q1');
  assert.equal(st.params.name, 'Анна');
  assert.equal(st.params.inv_id, '1024');
  assert.equal(st.params.inv, undefined);
  // С другого устройства (без rid) — та же анкета
  const again = (await call('POST', `/api/s/${pid}/start`, { params: { inv: anna.token } }, false)).json;
  assert.equal(again.rid, st.rid);
  await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'Q1', answers: { Q1: { v: 1 } } }, false);
  await call('POST', `/api/s/${pid}/submit`, { rid: st.rid, page: 'Q2', answers: {} }, false);
  const done = (await call('POST', `/api/s/${pid}/start`, { params: { inv: anna.token } }, false)).json;
  assert.match(done.message, /уже прошли/);

  assert.equal((await call('POST', `/api/s/${pid}/start`, { params: { inv: 'nope' } }, false)).json.closed, true);

  // Только по персональным ссылкам
  const info = (await call('GET', `/api/admin/projects/${pid}`)).json;
  assert.equal(info.invitees, 2);
  await call('PUT', `/api/admin/projects/${pid}`, { settings: { ...info.settings, inviteOnly: true } });
  assert.match((await call('POST', `/api/s/${pid}/start`, { params: {} }, false)).json.message, /персональной ссылке/);

  // Новая ссылка — старая не работает
  const ivan = list.find((p) => p.extId === '1025')!;
  await call('POST', `/api/admin/projects/${pid}/invitees/${ivan.id}/reissue`);
  assert.equal((await call('POST', `/api/s/${pid}/start`, { params: { inv: ivan.token } }, false)).json.closed, true);
  list = (await call('GET', `/api/admin/projects/${pid}/invitees`)).json;
  const fresh = list.find((p) => p.extId === '1025')!;
  assert.equal((await call('POST', `/api/s/${pid}/start`, { params: { inv: fresh.token } }, false)).json.page, 'Q1');

  assert.equal(list.find((p) => p.extId === '1024')!.status, 'completed');
  const csv = (await call('GET', `/api/admin/projects/${pid}/export.csv`)).json as string;
  const head = csv.replace(/^﻿/, '').split('\r\n')[0].split(';');
  assert.ok(head.includes('url_inv_id') && head.includes('url_name') && head.includes('url_otdel'));

  assert.deepEqual((await call('POST', `/api/admin/projects/${pid}/invitees/delete`, { all: true })).json, { deleted: 2 });
});
