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
  /** Резервные копии базы: папка, интервал в часах (0 — выключено), сколько копий хранить */
  backupDir: resolve(process.env.BACKUP_DIR ?? resolve(dataDir, 'backups')),
  backupHours: Number(process.env.BACKUP_HOURS ?? 24),
  backupKeep: Math.max(1, Number(process.env.BACKUP_KEEP ?? 14)),
  /** Токен Telegram-бота для уведомлений (@BotFather) */
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  /** За прокси (nginx) — брать IP из X-Forwarded-For */
  trustProxy: process.env.TRUST_PROXY === '1',
  isProduction: process.env.NODE_ENV === 'production',
  /** Внешний адрес сервиса (https://surveys.example.ru) — для ИИ-коннектора; по умолчанию берётся из запроса */
  publicUrl: process.env.PUBLIC_URL ?? '',
  /** Почта для приглашений: SMTP-сервер (Яндекс 360, Mail.ru, Unisender Go, SendPulse, свой) */
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 465),
    /** TLS сразу (порт 465); 0 — STARTTLS (порт 587) */
    secure: (process.env.SMTP_SECURE ?? (process.env.SMTP_PORT === '587' ? '0' : '1')) !== '0',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    /** Отправитель: "Опросы <surveys@example.ru>"; по умолчанию SMTP_USER */
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    /** Писем в минуту — у почтовых сервисов есть лимиты */
    perMinute: Math.max(1, Number(process.env.MAIL_PER_MINUTE ?? 60)),
  },
};

if (!config.adminPassword) {
  console.warn('⚠ ADMIN_PASSWORD не задан — вход в админку невозможен. Укажите его в .env');
}
