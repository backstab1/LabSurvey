import { timingSafeEqual } from 'node:crypto';
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

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isAdmin(req)) {
    await reply.code(401).send({ error: 'Требуется вход' });
  }
}
