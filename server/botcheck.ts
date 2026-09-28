// Невидимая проверка браузера перед стартом опроса: сервер выдаёт подписанную задачу, браузер подбирает число n,
// при котором SHA-256(salt + n) начинается с bits нулевых бит. Человеку незаметно (доли секунды), а массовый запуск
// анкет скриптом без браузера становится дорогим. Решение одноразовое и действует 10 минут.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import type { BotChallenge, BotSolution } from '../shared/api.ts';

const TTL_MS = 10 * 60_000;
const used = new Map<string, number>();

const sign = (scope: string, c: Omit<BotChallenge, 'sig'>) =>
  createHmac('sha256', config.sessionSecret).update(`botcheck:${scope}:${c.salt}:${c.bits}:${c.exp}`).digest('base64url');

export function botChallenge(scope: string): BotChallenge {
  const c = { salt: randomBytes(12).toString('hex'), bits: config.botCheckBits, exp: Date.now() + TTL_MS };
  return { ...c, sig: sign(scope, c) };
}

/** Число нулевых бит в начале хеша */
export function leadingZeroBits(buf: Buffer): number {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export function verifyBotSolution(scope: string, s: BotSolution | undefined): boolean {
  if (!s || typeof s.salt !== 'string' || typeof s.sig !== 'string' || !Number.isInteger(s.n) || !Number.isInteger(s.exp) || !Number.isInteger(s.bits)) return false;
  if (s.exp < Date.now() || s.bits < config.botCheckBits) return false;
  const want = Buffer.from(sign(scope, s));
  const got = Buffer.from(s.sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  if (used.has(s.salt)) return false;
  if (leadingZeroBits(createHash('sha256').update(`${s.salt}${s.n}`).digest()) < s.bits) return false;
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  used.set(s.salt, s.exp);
  return true;
}
