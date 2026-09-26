// OAuth 2.1 для ИИ-коннекторов (Claude, ChatGPT): регистрация приложения (RFC 7591), вход и согласие пользователя,
// код с PKCE (S256), токены доступа и обновления. Приложение действует от имени пользователя SurveyLAB и с его ролью.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, currentUser, loginBlocked, loginFailed, setSession, isBuiltInLogin, type SessionUser } from './auth.ts';
import { config } from './config.ts';
import { oauth, users } from './db.ts';
import { auditAi } from './audit.ts';

export const SCOPE = 'surveys';
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;

/** Адрес сервиса снаружи: PUBLIC_URL или из запроса (за прокси — с TRUST_PROXY=1) */
export function baseUrl(req: FastifyRequest): string {
  return (config.publicUrl || `${req.protocol}://${req.host}`).replace(/\/+$/, '');
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const later = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

/** Пользователь по логину из токена: отключённый, удалённый или заказчик доступа не получает */
export async function userByLogin(login: string): Promise<SessionUser | null> {
  if (isBuiltInLogin(login)) return { login: config.adminLogin, role: 'admin', builtIn: true };
  const u = await users.get(login);
  if (!u || u.disabled || u.role === 'client') return null;
  return { login: u.login, role: u.role, builtIn: false };
}

/** Токен доступа из заголовка Authorization → пользователь */
export async function bearerUser(req: FastifyRequest): Promise<{ user: SessionUser; clientId: string } | null> {
  const m = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const g = await oauth.token(sha(m[1]), 'access');
  if (!g) return null;
  const user = await userByLogin(g.login);
  return user ? { user, clientId: g.clientId } : null;
}

/** Адрес возврата: https или http на localhost (для отладки) */
function redirectOk(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

// Регистраций с одного IP — не больше 20 в час
const registrations = new Map<string, number[]>();
function tooManyRegistrations(ip: string): boolean {
  const recent = (registrations.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
  if (registrations.size > 10_000) registrations.clear();
  registrations.set(ip, [...recent, Date.now()]);
  return recent.length >= 20;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Подпись формы согласия: без неё нельзя подсунуть пользователю чужую форму */
const csrfFor = (login: string, p: AuthParams) =>
  createHmac('sha256', config.sessionSecret).update(`consent:${login}:${p.client_id}:${p.redirect_uri}:${p.code_challenge}`).digest('base64url');

interface AuthParams {
  response_type: string; client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string;
  state?: string; scope?: string;
}
const PARAM_KEYS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope'] as const;
const pickParams = (src: Record<string, unknown>) =>
  Object.fromEntries(PARAM_KEYS.filter((k) => typeof src[k] === 'string').map((k) => [k, src[k] as string])) as unknown as AuthParams;

const ROLE_WORDS: Record<string, string> = { admin: 'администратор', editor: 'редактор', viewer: 'наблюдатель' };

function page(reply: FastifyReply, title: string, body: string, status = 200) {
  reply.code(status).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
    .header('X-Frame-Options', 'DENY');
  return reply.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — SurveyLAB</title><style>
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f5f7;color:#1c2330;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px;max-width:440px;width:calc(100% - 32px);box-sizing:border-box}
h1{font-size:20px;margin:0 0 14px}.logo{font-weight:700;margin-bottom:18px}.logo span{color:#2f6fed}
p,li{font-size:15px;line-height:1.5}.muted{color:#6b7380;font-size:14px}ul{padding-left:20px;margin:8px 0}
label{display:block;font-size:14px;margin:12px 0 4px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cfd4db;border-radius:8px;font-size:15px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;font-size:15px;cursor:pointer;border:1px solid #cfd4db;background:#fff}
button.primary{background:#2f6fed;border-color:#2f6fed;color:#fff}.err{background:#fdecec;color:#b42318;padding:9px 11px;border-radius:8px;font-size:14px}
code{background:#f0f2f5;padding:1px 5px;border-radius:4px}</style></head>
<body><div class="box"><div class="logo">Survey<span>LAB</span></div>${body}</div></body></html>`);
}

const hidden = (p: AuthParams) => PARAM_KEYS.filter((k) => p[k] !== undefined)
  .map((k) => `<input type="hidden" name="${k}" value="${esc(String(p[k]))}">`).join('');

export async function oauthRoutes(app: FastifyInstance) {
  // Формы и токен-эндпоинт присылают application/x-www-form-urlencoded
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  const resourceMeta = async (req: FastifyRequest) => ({
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: [baseUrl(req)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'SurveyLAB',
  });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  app.get('/.well-known/oauth-authorization-server', async (req) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
    };
  });

  // ---- Регистрация приложения ----
  app.post<{ Body: Record<string, unknown> }>('/oauth/register', async (req, reply) => {
    if (tooManyRegistrations(req.ip)) return reply.code(429).send({ error: 'slow_down', error_description: 'Слишком много регистраций' });
    const b = req.body ?? {};
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris: https-адреса (или http://localhost)' });
    }
    const method = typeof b.token_endpoint_auth_method === 'string' ? b.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: 'token_endpoint_auth_method не поддерживается' });
    }
    const secret = method === 'none' ? null : token();
    const name = (typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim() : 'ИИ-приложение').slice(0, 100);
    const c = await oauth.createClient({ name, secretHash: secret ? sha(secret) : null, redirectUris: uris as string[] });
    return reply.code(201).send({
      client_id: c.id, client_id_issued_at: Math.floor(Date.parse(c.createdAt) / 1000), client_name: c.name,
      redirect_uris: c.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: method, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    });
  });

  // ---- Вход и согласие ----

  /** Проверка параметров запроса авторизации; ошибка — текстом (на адрес возврата не отправляем, пока он не проверен) */
  async function checkRequest(p: AuthParams) {
    const client = p.client_id ? await oauth.client(p.client_id) : null;
    if (!client) return { error: 'Приложение не зарегистрировано. Подключите коннектор заново.' };
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) return { error: 'Адрес возврата не совпадает с зарегистрированным.' };
    if (p.response_type !== 'code') return { error: 'Поддерживается только response_type=code.' };
    if (!p.code_challenge || p.code_challenge_method !== 'S256') return { error: 'Нужен PKCE (code_challenge_method=S256).' };
    return { client };
  }

  function consentPage(reply: FastifyReply, p: AuthParams, clientName: string, user: SessionUser) {
    const host = new URL(p.redirect_uri).host;
    const canWrite = user.role !== 'viewer';
    return page(reply, 'Доступ для ИИ', `
<h1>Разрешить доступ?</h1>
<p><strong>${esc(clientName)}</strong> <span class="muted">(${esc(host)})</span> просит доступ к SurveyLAB от вашего имени:
<strong>${esc(user.login)}</strong>, ${esc(ROLE_WORDS[user.role] ?? user.role)}.</p>
<p>Приложение сможет:</p><ul>
<li>смотреть список анкет и их содержимое;</li>
${canWrite ? '<li>создавать анкеты и менять их черновики.</li>' : '<li>проверять анкеты (менять не сможет — у вас доступ только на просмотр).</li>'}
</ul>
<p class="muted">Публиковать анкеты, запускать сбор и видеть ответы респондентов приложение не может. Доступ можно отозвать в SurveyLAB: меню пользователя → «ИИ-коннектор».</p>
<form method="post" action="/oauth/authorize">${hidden(p)}<input type="hidden" name="csrf" value="${csrfFor(user.login, p)}">
<div class="row"><button name="action" value="deny">Отказать</button><button class="primary" name="action" value="approve">Разрешить</button></div></form>`);
  }

  function loginPage(reply: FastifyReply, p: AuthParams, clientName: string, error?: string) {
    return page(reply, 'Вход', `
<h1>Вход в SurveyLAB</h1>
<p class="muted">Чтобы подключить <strong>${esc(clientName)}</strong>, войдите под своей учётной записью SurveyLAB.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/authorize">${hidden(p)}<input type="hidden" name="action" value="login">
<label for="login">Логин</label><input id="login" type="text" name="login" autocomplete="username" autofocus>
<label for="password">Пароль</label><input id="password" type="password" name="password" autocomplete="current-password">
<div class="row"><button class="primary">Войти</button></div></form>`, error ? 401 : 200);
  }

  const denied = (reply: FastifyReply, text: string) => page(reply, 'Нет доступа', `<h1>Нет доступа</h1><p>${esc(text)}</p>`, 403);

  app.get<{ Querystring: Record<string, unknown> }>('/oauth/authorize', async (req, reply) => {
    const p = pickParams(req.query ?? {});
    const chk = await checkRequest(p);
    if (!chk.client) return page(reply, 'Ошибка', `<h1>Не получилось подключить</h1><p>${esc(chk.error!)}</p>`, 400);
    const session = await currentUser(req);
    const user = session ? await userByLogin(session.login) : null;
    if (session && !user) return denied(reply, 'Вашей учётной записи ИИ-коннектор недоступен.');
    return user ? consentPage(reply, p, chk.client.name, user) : loginPage(reply, p, chk.client.name);
  });

  app.post<{ Body: Record<string, unknown> }>('/oauth/authorize', async (req, reply) => {
    const b = req.body ?? {};
    const p = pickParams(b);
    const chk = await checkRequest(p);
    if (!chk.client) return page(reply, 'Ошибка', `<h1>Не получилось подключить</h1><p>${esc(chk.error!)}</p>`, 400);
    const back = (params: Record<string, string>) => {
      const u = new URL(p.redirect_uri);
      for (const [k, v] of Object.entries({ ...params, ...(p.state ? { state: p.state } : {}) })) u.searchParams.set(k, v);
      return reply.redirect(u.toString(), 302);
    };

    if (b.action === 'login') {
      if (loginBlocked(req.ip)) return loginPage(reply, p, chk.client.name, 'Слишком много неудачных попыток. Подождите 15 минут.');
      const u = await authenticate(String(b.login ?? '').trim(), String(b.password ?? ''));
      if (!u) {
        loginFailed(req.ip);
        return loginPage(reply, p, chk.client.name, 'Неверный логин или пароль');
      }
      setSession(reply, u.login);
      const user = await userByLogin(u.login);
      return user ? consentPage(reply, p, chk.client.name, user) : denied(reply, 'Вашей учётной записи ИИ-коннектор недоступен.');
    }

    const session = await currentUser(req);
    const user = session ? await userByLogin(session.login) : null;
    if (!user) return loginPage(reply, p, chk.client.name, 'Сессия истекла — войдите ещё раз');
    const csrf = Buffer.from(String(b.csrf ?? ''));
    const want = Buffer.from(csrfFor(user.login, p));
    if (csrf.length !== want.length || !timingSafeEqual(csrf, want)) return denied(reply, 'Форма устарела. Начните подключение заново.');
    if (b.action !== 'approve') return back({ error: 'access_denied', error_description: 'Пользователь отказал в доступе' });

    await auditAi({ login: user.login, app: chk.client.name, action: 'Подключил ИИ-приложение', ip: req.ip ?? null });
    const code = token();
    await oauth.saveCode(sha(code), {
      clientId: chk.client.id, login: user.login, scope: SCOPE, expiresAt: later(CODE_TTL), redirectUri: p.redirect_uri, challenge: p.code_challenge,
    });
    return back({ code });
  });

  // ---- Токены ----

  /** Приложение: client_id из тела или Basic-заголовка; секрет — если он выдавался */
  async function clientOf(req: FastifyRequest<{ Body: Record<string, unknown> }>) {
    let id = typeof req.body?.client_id === 'string' ? req.body.client_id : '';
    let secret = typeof req.body?.client_secret === 'string' ? req.body.client_secret : '';
    const basic = String(req.headers.authorization ?? '').match(/^Basic\s+(\S+)$/i);
    if (basic) {
      const [u, s] = Buffer.from(basic[1], 'base64').toString().split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(s ?? '');
    }
    const c = id ? await oauth.client(id) : null;
    if (!c) return null;
    if (c.secretHash && sha(secret) !== c.secretHash) return null;
    return c;
  }

  async function issue(clientId: string, login: string, scope: string | null) {
    const access = token();
    const refresh = token();
    await oauth.saveToken(sha(access), 'access', { clientId, login, scope, expiresAt: later(ACCESS_TTL) });
    await oauth.saveToken(sha(refresh), 'refresh', { clientId, login, scope, expiresAt: later(REFRESH_TTL) });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scope ?? SCOPE };
  }

  app.post<{ Body: Record<string, unknown> }>('/oauth/token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const fail = (error: string, description: string, status = 400) => reply.code(status).send({ error, error_description: description });
    const client = await clientOf(req);
    if (!client) return fail('invalid_client', 'Приложение не найдено или неверный секрет', 401);
    const b = req.body ?? {};

    if (b.grant_type === 'authorization_code') {
      const g = typeof b.code === 'string' ? await oauth.takeCode(sha(b.code)) : null;
      if (!g || g.clientId !== client.id) return fail('invalid_grant', 'Код недействителен или истёк');
      if (b.redirect_uri !== undefined && b.redirect_uri !== g.redirectUri) return fail('invalid_grant', 'redirect_uri не совпадает');
      const verifier = typeof b.code_verifier === 'string' ? b.code_verifier : '';
      if (createHash('sha256').update(verifier).digest('base64url') !== g.challenge) return fail('invalid_grant', 'PKCE: code_verifier не подходит');
      if (!(await userByLogin(g.login))) return fail('invalid_grant', 'Пользователь недоступен');
      return issue(client.id, g.login, g.scope);
    }

    if (b.grant_type === 'refresh_token') {
      const hash = typeof b.refresh_token === 'string' ? sha(b.refresh_token) : '';
      const g = hash ? await oauth.token(hash, 'refresh') : null;
      if (!g || g.clientId !== client.id) return fail('invalid_grant', 'Токен обновления недействителен');
      // Токен обновления одноразовый: выдаём новую пару
      await oauth.deleteToken(hash);
      if (!(await userByLogin(g.login))) return fail('invalid_grant', 'Пользователь недоступен');
      return issue(client.id, g.login, g.scope);
    }
    return fail('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
  });

  app.post<{ Body: Record<string, unknown> }>('/oauth/revoke', async (req, reply) => {
    const client = await clientOf(req);
    if (!client) return reply.code(401).send({ error: 'invalid_client' });
    if (typeof req.body?.token === 'string') await oauth.deleteToken(sha(req.body.token));
    return reply.code(200).send({});
  });
}
