// ИИ-коннектор: OAuth (регистрация, вход, согласие, PKCE, токены) и MCP-инструменты через настоящий клиент SDK
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-mcp-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');

let app: FastifyInstance;
let base = '';
before(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

const REDIRECT = 'https://claude.example/api/mcp/auth_callback';
const form = (o: Record<string, string>) => ({ body: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

/** Полный путь подключения: регистрация → вход → согласие → код → токены */
async function connect(login: string, password: string) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const params = {
    response_type: 'code', client_id, redirect_uri: REDIRECT, state: 'st4te', scope: 'surveys',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  };
  const loginPage = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /Вход в SurveyLAB/);

  const wrong = await fetch(`${base}/oauth/authorize`, { method: 'POST', ...form({ ...params, action: 'login', login, password: 'nope' }) });
  assert.equal(wrong.status, 401);
  const consent = await fetch(`${base}/oauth/authorize`, { method: 'POST', ...form({ ...params, action: 'login', login, password }) });
  const html = await consent.text();
  if (consent.status !== 200) return { client_id, denied: html };
  assert.match(html, /Разрешить доступ/);
  const cookie = String(consent.headers.get('set-cookie')).split(';')[0];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];

  // Подделанная форма не проходит
  const forged = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', ...form({ ...params, action: 'approve', csrf: 'x'.repeat(csrf.length) }), headers: { ...form({}).headers, cookie } });
  assert.equal(forged.status, 403);

  const approve = await fetch(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...params, action: 'approve', csrf }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
  assert.equal(approve.status, 302);
  const loc = new URL(approve.headers.get('location')!);
  assert.equal(`${loc.origin}${loc.pathname}`, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'st4te');
  const code = loc.searchParams.get('code')!;

  const badPkce = await fetch(`${base}/oauth/token`, { method: 'POST', ...form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: 'wrong' }) });
  assert.equal(badPkce.status, 400);
  // Код одноразовый — после неудачной попытки он уже сгорел; проходим ещё раз
  const approve2 = await fetch(`${base}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ ...params, action: 'approve', csrf }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
  const code2 = new URL(approve2.headers.get('location')!).searchParams.get('code')!;
  const tok = await fetch(`${base}/oauth/token`, { method: 'POST', ...form({ grant_type: 'authorization_code', code: code2, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const tokens = await tok.json();
  assert.equal(tokens.token_type, 'Bearer');
  const reuse = await fetch(`${base}/oauth/token`, { method: 'POST', ...form({ grant_type: 'authorization_code', code: code2, client_id, redirect_uri: REDIRECT, code_verifier: verifier }) });
  assert.equal(reuse.status, 400);
  return { client_id, tokens, cookie };
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
const textOf = (r: { content?: unknown }) => ((r.content as { type: string; text: string }[])[0]).text;

const SURVEY = {
  formatVersion: 2, title: 'От ИИ',
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Пьёте кофе?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
};

test('discovery and 401 without token', async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(meta.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate')!, /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const badReg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(badReg.status, 400);
});

test('OAuth flow, MCP tools, refresh rotation, revoke', async () => {
  const { client_id, tokens, cookie } = await connect('admin', 'secret');
  const client = await mcpClient(tokens.access_token);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['create_survey', 'get_format_guide', 'get_survey', 'list_surveys', 'update_survey', 'validate_survey']);
  assert.match(client.getInstructions() ?? '', /get_format_guide/);

  assert.match(textOf(await client.callTool({ name: 'get_format_guide', arguments: {} })), /formatVersion/);
  const bad = JSON.parse(textOf(await client.callTool({ name: 'validate_survey', arguments: { definition: { formatVersion: 2, title: 'x', blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'a', options: [] }] }] } } })));
  assert.equal(bad.ok, false);

  // Анкета строкой JSON — тоже принимается
  const created = await client.callTool({ name: 'create_survey', arguments: { definition: JSON.stringify(SURVEY) } });
  assert.ok(!created.isError, textOf(created));
  const c = JSON.parse(textOf(created));
  assert.equal(c.check.ok, true);
  assert.equal(c.editorUrl, `${base}/admin/s/${c.id}`);

  const list = JSON.parse(textOf(await client.callTool({ name: 'list_surveys', arguments: { query: 'от ии' } })));
  assert.equal(list.length, 1);
  const got = JSON.parse(textOf(await client.callTool({ name: 'get_survey', arguments: { id: c.id } })));
  const edited = { ...got.definition, title: 'От ИИ — правка' };
  const stale = await client.callTool({ name: 'update_survey', arguments: { id: c.id, updatedAt: '2000-01-01T00:00:00.000Z', definition: edited } });
  assert.equal(stale.isError, true);
  const upd = await client.callTool({ name: 'update_survey', arguments: { id: c.id, updatedAt: got.updatedAt, definition: edited } });
  assert.ok(!upd.isError, textOf(upd));
  const again = JSON.parse(textOf(await client.callTool({ name: 'get_survey', arguments: { id: c.id } })));
  assert.equal(again.definition.title, 'От ИИ — правка');
  assert.equal(again.publishedVersion, null);
  await client.close();

  // Токен обновления одноразовый
  const r1 = await fetch(`${base}/oauth/token`, { method: 'POST', ...form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id }) });
  assert.equal(r1.status, 200);
  const fresh = await r1.json();
  const r2 = await fetch(`${base}/oauth/token`, { method: 'POST', ...form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id }) });
  assert.equal(r2.status, 400);

  // Подключения видны в админке и отзываются
  const conns = await (await fetch(`${base}/api/admin/me/connections`, { headers: { cookie } })).json();
  assert.equal(conns.length, 1);
  assert.equal(conns[0].name, 'Claude');
  await fetch(`${base}/api/admin/me/connections/${client_id}`, { method: 'DELETE', headers: { cookie } });
  const after = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${fresh.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(after.status, 401);
});

test('viewer can read but not write; client role gets no connector', async () => {
  const { cookie } = await connect('admin', 'secret');
  const mk = (login: string, role: string) => fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ login, password: 'password1', role }),
  });
  await mk('viewer1', 'viewer');
  await mk('client1', 'client');

  const v = await connect('viewer1', 'password1');
  const client = await mcpClient(v.tokens.access_token);
  const res = await client.callTool({ name: 'create_survey', arguments: { definition: SURVEY } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /только на просмотр/);
  assert.ok(!(await client.callTool({ name: 'list_surveys', arguments: {} })).isError);
  await client.close();

  const c = await connect('client1', 'password1');
  assert.match(c.denied ?? '', /Нет доступа/);
});
