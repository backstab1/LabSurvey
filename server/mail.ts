// Рассылка приглашений по e-mail: шаблон письма, SMTP и фоновая очередь.
// Письма стоят в очереди в базе (invitees.mail_pending) — после перезапуска сервера рассылка продолжается с того же места.
// Скорость ограничена (MAIL_PER_MINUTE): у почтовых сервисов есть лимиты, пачка писем разом попадает в спам.
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.ts';
import { mailings, type Invitee } from './db.ts';
import { INVITE_PARAM } from '../shared/types.ts';
import { fillMailTemplate as fillTemplate } from '../shared/mailTemplate.ts';

export interface MailMessage { to: string; subject: string; text: string; html: string }
type Sender = (m: MailMessage) => Promise<void>;

let testSender: Sender | null = null;
/** Для тестов: письма уходят в функцию вместо SMTP */
export function setMailSenderForTests(s: Sender | null): void { testSender = s; }

export const mailConfigured = (): boolean => !!testSender || !!(config.smtp.host && config.smtp.from);

let transport: Transporter | null = null;
function smtpSender(): Sender {
  transport ??= nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    pool: true, maxConnections: 1,
  });
  return async (m) => { await transport!.sendMail({ from: config.smtp.from, ...m }); };
}
const send: Sender = (m) => (testSender ?? smtpSender())(m);

// ---------- Шаблон ----------

export const inviteLink = (baseUrl: string, projectId: string, token: string) => `${baseUrl.replace(/\/+$/, '')}/s/${projectId}?${INVITE_PARAM}=${token}`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Текст письма → HTML: абзацы и переносы строк, **жирный**, ссылки кликабельны.
 * Строка, где только ссылка на опрос, становится кнопкой.
 */
export function bodyToHtml(text: string, link: string): string {
  const inline = (s: string) => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#3b7a06">${u}</a>`);
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((para) => {
    if (para.trim() === link) {
      return `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#3b7a06;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600">Пройти опрос</a></p>`
        + `<p style="font-size:13px;color:#7d8475;margin:-12px 0 16px">Если кнопка не работает, скопируйте ссылку: ${inline(link)}</p>`;
    }
    return `<p style="margin:0 0 14px">${para.split('\n').map(inline).join('<br>')}</p>`;
  });
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f1">`
    + `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;font:16px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c2017">`
    + paras.join('') + `</div></body></html>`;
}

export function renderMail(tpl: { subject: string; body: string }, p: Pick<Invitee, 'fields' | 'extId' | 'token'>, baseUrl: string, projectId: string) {
  const link = inviteLink(baseUrl, projectId, p.token);
  const text = fillTemplate(tpl.body, p, link);
  return { subject: fillTemplate(tpl.subject, p, link).replace(/[\r\n]+/g, ' ').trim(), text, html: bodyToHtml(text, link) };
}

/** Тестовое письмо на любой адрес — с данными первого человека из списка (или пустыми) */
export async function sendTest(to: string, tpl: { subject: string; body: string }, sample: Pick<Invitee, 'fields' | 'extId' | 'token'>, baseUrl: string, projectId: string): Promise<void> {
  const m = renderMail(tpl, sample, baseUrl, projectId);
  await send({ to, subject: `[Тест] ${m.subject}`, text: m.text, html: m.html });
}

// ---------- Очередь ----------

/** Ошибки подключения и входа: письмо не виновато — очередь ждёт и пробует снова */
const TRANSIENT = new Set(['EAUTH', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ECONNREFUSED', 'ECONNRESET']);

let running = false;
let wake: (() => void) | null = null;
let stopped = false;
/** Последняя ошибка подключения к почте — показывается в админке */
export let mailServerError: { message: string; at: string } | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const t = setTimeout(() => { wake = null; resolve(); }, ms);
  wake = () => { clearTimeout(t); wake = null; resolve(); };
});

/** Разбудить очередь (новая рассылка) */
export function kickMailer(): void {
  if (!running) startMailer();
  else wake?.();
}

export function startMailer(opts: { intervalMs?: number } = {}): void {
  if (running) return;
  running = true;
  stopped = false;
  const interval = opts.intervalMs ?? Math.ceil(60_000 / config.smtp.perMinute);
  void (async () => {
    while (!stopped) {
      if (!mailConfigured()) { await sleep(60_000); continue; }
      let next: Awaited<ReturnType<typeof mailings.nextPending>>;
      try { next = await mailings.nextPending(); } catch (e) { console.error('[mail]', e); await sleep(30_000); continue; }
      if (!next) { await sleep(30_000); continue; }
      const { mailing, invitee } = next;
      const to = invitee.fields[mailing.emailField]?.trim() ?? '';
      try {
        const m = renderMail(mailing, invitee, mailing.baseUrl, mailing.projectId);
        await send({ to, subject: m.subject, text: m.text, html: m.html });
        mailServerError = null;
        await mailings.markSent(mailing.id, invitee.id, null);
      } catch (e) {
        const err = e as { code?: string; responseCode?: number; message?: string };
        if (err.code && TRANSIENT.has(err.code)) {
          mailServerError = { message: err.message ?? err.code, at: new Date().toISOString() };
          console.error('[mail] почтовый сервер недоступен, пауза 5 минут:', err.message);
          await sleep(5 * 60_000);
          continue;
        }
        await mailings.markSent(mailing.id, invitee.id, err.message ?? 'Ошибка отправки');
      }
      await sleep(interval);
    }
    running = false;
  })();
}

export function stopMailer(): void {
  stopped = true;
  wake?.();
}
