import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';
import { users, type Role } from './db.ts';

export interface SessionUser {
  login: string;
  role: Role;
  /** Главный администратор из .env (ADMIN_LOGIN / ADMIN_PASSWORD) */
  builtIn: boolean;
  /** Для заказчика: доступные проекты */
  projects?: string[];
}

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`;
}

function verifyHash(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(password, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const isBuiltInLogin = (login: string) => !!config.adminPassword && login.toLowerCase() === config.adminLogin.toLowerCase();

/** Проверка логина и пароля: главный администратор из .env или пользователь из базы */
export async function authenticate(login: string, password: string): Promise<SessionUser | null> {
  if (checkPassword(login, password)) return { login: config.adminLogin, role: 'admin', builtIn: true };
  if (isBuiltInLogin(login)) return null;
  const u = await users.get(login);
  if (!u || u.disabled || !verifyHash(password, u.passwordHash)) return null;
  await users.touch(u.login);
  return { login: u.login, role: u.role, builtIn: false, ...(u.role === 'client' ? { projects: u.projects } : {}) };
}

/** Пароль пользователя из базы (для смены пароля) */
export async function checkUserPassword(login: string, password: string): Promise<boolean> {
  const u = await users.get(login);
  return !!u && verifyHash(password, u.passwordHash);
}

const COOKIE = 'sl_admin';
const TTL_DAYS = 14;

export function checkPassword(login: string, password: string): boolean {
  if (!config.adminPassword) return false;
  const a = Buffer.from(`${login}\u0000${password}`);
  const b = Buffer.from(`${config.adminLogin}\u0000${config.adminPassword}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Защита от перебора пароля: не больше 10 неудачных попыток за 15 минут с одного IP
const FAIL_WINDOW = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map<string, number[]>();

export function loginBlocked(ip: string): boolean {
  const recent = (fails.get(ip) ?? []).filter((t) => Date.now() - t < FAIL_WINDOW);
  fails.set(ip, recent);
  return recent.length >= MAX_FAILS;
}

export function loginFailed(ip: string): void {
  if (fails.size > 10_000) fails.clear();
  fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
}

export function setSession(reply: FastifyReply, login: string): void {
  const expires = Date.now() + TTL_DAYS * 86400_000;
  reply.setCookie(COOKIE, `${login}|${expires}`, {
    path: '/', httpOnly: true, sameSite: 'lax', signed: true, secure: config.isProduction && process.env.COOKIE_SECURE !== '0',
    maxAge: TTL_DAYS * 86400,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

function sessionLogin(req: FastifyRequest): string | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const res = req.unsignCookie(raw);
  if (!res.valid || !res.value) return null;
  const [login, exp] = res.value.split('|');
  if (Number(exp) < Date.now()) return null;
  return login;
}

/** Текущий пользователь; отключённый или удалённый пользователь сразу теряет доступ */
export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const login = sessionLogin(req);
  if (!login) return null;
  if (isBuiltInLogin(login)) return { login: config.adminLogin, role: 'admin', builtIn: true };
  const u = await users.get(login);
  return u && !u.disabled ? { login: u.login, role: u.role, builtIn: false, ...(u.role === 'client' ? { projects: u.projects } : {}) } : null;
}

/** Ключ тестовой ссылки анкеты: открывает предпросмотр черновика без входа в админку */
export function testToken(surveyId: string): string {
  return createHmac('sha256', config.sessionSecret).update(`test:${surveyId}`).digest('base64url').slice(0, 16);
}

export function checkTestToken(surveyId: string, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(testToken(surveyId));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Любой вошедший; наблюдатель может только читать (GET) */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await currentUser(req);
  if (!user) return reply.code(401).send({ error: 'Требуется вход' });
  req.user = user;
  if (user.role === 'client' && !clientAllowed(req.method, req.url, user.projects ?? [])) {
    return reply.code(403).send({ error: 'Недостаточно прав: этот раздел недоступен' });
  }
  if (user.role === 'viewer' && req.method !== 'GET' && !req.url.startsWith('/api/admin/me/')) {
    return reply.code(403).send({ error: 'Недостаточно прав: у вас доступ только на просмотр' });
  }
}

/** Заказчик: смена своего пароля, список и чтение своих проектов — сводка, отчёт, данные, выгрузки */
export function clientAllowed(method: string, url: string, projects: string[]): boolean {
  const path = url.split('?')[0];
  if (method === 'POST') return path === '/api/admin/me/password';
  if (method !== 'GET') return false;
  if (path === '/api/admin/projects') return true;
  const m = path.match(/^\/api\/admin\/projects\/([\w-]+)(?:\/(report|crosstab(?:\.xlsx)?|responses(?:\/[\w-]+)?|export\.\w+))?$/);
  return !!m && projects.includes(m[1]);
}

/** Только администратор (пользователи, резервные копии) */
export async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'Только для администратора' });
}
