import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });

function sessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Секрет генерируется один раз и хранится рядом с базой, чтобы сессии переживали перезапуск
  const file = resolve(dataDir, '.session-secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'));
  return readFileSync(file, 'utf8').trim();
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbFile: resolve(dataDir, 'surveylab.db'),
  adminLogin: process.env.ADMIN_LOGIN ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionSecret: sessionSecret(),
  /** Часовой пояс для дат в выгрузках */
  timezone: process.env.EXPORT_TIMEZONE ?? 'Europe/Moscow',
  /** Путь к JSON-ключу сервисного аккаунта Google */
  googleCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  /** За прокси (nginx) — брать IP из X-Forwarded-For */
  trustProxy: process.env.TRUST_PROXY === '1',
  isProduction: process.env.NODE_ENV === 'production',
};

if (!config.adminPassword) {
  console.warn('⚠ ADMIN_PASSWORD не задан — вход в админку невозможен. Укажите его в .env');
}
