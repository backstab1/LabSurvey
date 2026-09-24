import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';

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

export function isAdmin(req: FastifyRequest): string | null {
  const raw = req.cookies[COOKIE];
  if (!raw) return null;
  const res = req.unsignCookie(raw);
  if (!res.valid || !res.value) return null;
  const [login, exp] = res.value.split('|');
  if (Number(exp) < Date.now()) return null;
  return login;
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

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAdmin(req)) {
    await reply.code(401).send({ error: 'Требуется вход' });
  }
}
