// Персональные ссылки: список приглашённых проекта и рассылки приглашений по e-mail
import type { Param, Queryable, Row } from '../sql.ts';
import { chunks, marks, newId, now, sql } from './connection.ts';
import { isEmail } from '../../shared/mailTemplate.ts';

export { isEmail };
import type { ResponseStatus } from '../../shared/variables.ts';

export interface Invitee {
  id: number;
  projectId: string;
  token: string;
  /** ID из списка (табельный номер, ID клиента) */
  extId: string | null;
  /** Остальные столбцы списка: имя, e-mail, отдел… — становятся параметрами ответа */
  fields: Record<string, string>;
  responseId: string | null;
  openedAt: string | null;
  createdAt: string;
  /** Статус анкеты по ссылке (из ответа) */
  status: ResponseStatus | null;
  rejected: boolean;
  completedAt: string | null;
  /** Письмо ждёт отправки (в очереди рассылки) */
  mailPending: boolean;
  mailSentAt: string | null;
  mailCount: number;
  mailError: string | null;
}

const toInvitee = (r: Row): Invitee => ({
  id: r.id as number, projectId: r.project_id as string, token: r.token as string, extId: (r.ext_id as string) ?? null,
  fields: JSON.parse(r.fields as string), responseId: (r.response_id as string) ?? null, openedAt: (r.opened_at as string) ?? null,
  createdAt: r.created_at as string, status: (r.status as ResponseStatus) ?? null, rejected: r.rejected === 1,
  completedAt: (r.completed_at as string) ?? null,
  mailPending: r.mail_pending != null, mailSentAt: (r.mail_sent_at as string) ?? null, mailCount: (r.mail_count as number) ?? 0,
  mailError: (r.mail_error as string) ?? null,
});

const INVITEE_SELECT = `SELECT i.*, r.status, r.rejected, r.completed_at FROM invitees i LEFT JOIN responses r ON r.id = i.response_id`;

export const invitees = {
  async list(projectId: string): Promise<Invitee[]> {
    return (await sql.all(`${INVITEE_SELECT} WHERE i.project_id = ? ORDER BY i.id`, [projectId])).map(toInvitee);
  },
  async byToken(projectId: string, token: string): Promise<Invitee | null> {
    const r = await sql.get(`${INVITEE_SELECT} WHERE i.project_id = ? AND i.token = ?`, [projectId, token]);
    return r ? toInvitee(r) : null;
  },
  /** Добавить людей; ext_id не повторяется внутри проекта — повторы пропускаются */
  async add(projectId: string, people: { extId: string | null; fields: Record<string, string> }[]): Promise<{ added: number; skipped: number }> {
    return sql.tx(async (q) => {
      const existing = new Set((await q.all('SELECT ext_id FROM invitees WHERE project_id = ? AND ext_id IS NOT NULL', [projectId]))
        .map((r) => String(r.ext_id).toLowerCase()));
      const rows: Param[][] = [];
      let skipped = 0;
      const t = now();
      for (const p of people) {
        const key = p.extId?.toLowerCase();
        if (key && existing.has(key)) { skipped++; continue; }
        if (key) existing.add(key);
        rows.push([projectId, newId(16), p.extId, JSON.stringify(p.fields), t]);
      }
      // Вставка порциями: 20 000 человек — это 40 запросов, а не 20 000
      for (const part of chunks(rows, 200)) {
        await q.run(`INSERT INTO invitees (project_id, token, ext_id, fields, created_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`, part.flat());
      }
      return { added: rows.length, skipped };
    });
  },
  async attach(id: number, responseId: string): Promise<void> {
    await sql.run('UPDATE invitees SET response_id = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?', [responseId, now(), id]);
  },
  /** Удалить людей из списка (их ответы остаются) */
  async remove(projectId: string, ids: number[] | 'all'): Promise<number> {
    if (ids === 'all') return (await sql.run('DELETE FROM invitees WHERE project_id = ?', [projectId])).changes;
    let n = 0;
    for (const part of chunks(ids)) n += (await sql.run(`DELETE FROM invitees WHERE project_id = ? AND id IN (${marks(part.length)})`, [projectId, ...part])).changes;
    return n;
  },
  /** Новая ссылка взамен старой (старая перестаёт работать) */
  async reissue(projectId: string, id: number): Promise<void> {
    await sql.run('UPDATE invitees SET token = ? WHERE project_id = ? AND id = ?', [newId(16), projectId, id]);
  },
  async count(projectId: string): Promise<number> {
    return (await sql.get('SELECT COUNT(*) AS n FROM invitees WHERE project_id = ?', [projectId]))!.n as number;
  },
};

// ---- Рассылки ----

/** Кому: ещё не получали письмо / не завершили (напоминание) / все / выбранные */
export type MailAudience = 'not_sent' | 'not_completed' | 'all' | 'ids';

export interface Mailing {
  id: number;
  projectId: string;
  audience: MailAudience;
  subject: string;
  body: string;
  /** Столбец списка с адресом */
  emailField: string;
  /** Адрес сервиса для ссылок в письмах */
  baseUrl: string;
  createdBy: string | null;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  /** Сколько ещё в очереди */
  pending: number;
  finishedAt: string | null;
  cancelled: boolean;
}

const toMailing = (r: Row): Mailing => ({
  id: r.id as number, projectId: r.project_id as string, audience: r.audience as MailAudience, subject: r.subject as string,
  body: r.body as string, emailField: r.email_field as string, baseUrl: r.base_url as string, createdBy: (r.created_by as string) ?? null,
  createdAt: r.created_at as string, total: r.total as number, sent: r.sent as number, failed: r.failed as number,
  pending: (r.pending as number) ?? 0, finishedAt: (r.finished_at as string) ?? null, cancelled: r.cancelled === 1,
});

const MAILING_SELECT = 'SELECT m.*, (SELECT COUNT(*) FROM invitees i WHERE i.mail_pending = m.id) AS pending FROM mailings m';

async function getMailing(q: Queryable, id: number): Promise<Mailing | null> {
  const r = await q.get(`${MAILING_SELECT} WHERE m.id = ?`, [id]);
  return r ? toMailing(r) : null;
}

export const mailings = {
  /**
   * Создать рассылку и поставить письма в очередь. Люди без адреса и те, кому письмо уже стоит в очереди, пропускаются.
   * Возвращает рассылку и сколько людей пропущено из-за пустого или неверного адреса.
   */
  async create(m: Pick<Mailing, 'projectId' | 'audience' | 'subject' | 'body' | 'emailField' | 'baseUrl' | 'createdBy'>, ids?: number[]): Promise<{ mailing: Mailing; noEmail: number }> {
    const where = {
      not_sent: 'i.mail_sent_at IS NULL',
      not_completed: "(r.status IS NULL OR r.status = 'in_progress')",
      all: '1 = 1',
      ids: '1 = 1',
    }[m.audience];
    return sql.tx(async (q) => {
      const rows = await q.all(`${INVITEE_SELECT} WHERE i.project_id = ? AND i.mail_pending IS NULL AND ${where}`, [m.projectId]);
      const idSet = m.audience === 'ids' ? new Set(ids ?? []) : null;
      const chosen = rows.map(toInvitee).filter((p) => !idSet || idSet.has(p.id));
      const withEmail = chosen.filter((p) => isEmail(p.fields[m.emailField]));
      const ins = await q.get(`INSERT INTO mailings (project_id, audience, subject, body, email_field, base_url, created_by, created_at, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [m.projectId, m.audience, m.subject, m.body, m.emailField, m.baseUrl, m.createdBy, now(), withEmail.length]);
      const id = ins!.id as number;
      for (const part of chunks(withEmail.map((p) => p.id))) {
        await q.run(`UPDATE invitees SET mail_pending = ? WHERE id IN (${marks(part.length)})`, [id, ...part]);
      }
      if (!withEmail.length) await q.run('UPDATE mailings SET finished_at = ? WHERE id = ?', [now(), id]);
      return { mailing: (await getMailing(q, id))!, noEmail: chosen.length - withEmail.length };
    });
  },
  async get(id: number): Promise<Mailing | null> {
    return getMailing(sql, id);
  },
  async list(projectId: string): Promise<Mailing[]> {
    return (await sql.all(`${MAILING_SELECT} WHERE m.project_id = ? ORDER BY m.id DESC LIMIT 50`, [projectId])).map(toMailing);
  },
  /** Следующее письмо из очереди (сначала более ранние рассылки) */
  async nextPending(): Promise<{ mailing: Mailing; invitee: Invitee } | null> {
    for (;;) {
      const r = await sql.get(`${INVITEE_SELECT} WHERE i.mail_pending IS NOT NULL ORDER BY i.mail_pending, i.id LIMIT 1`);
      if (!r) return null;
      const mailing = await this.get(r.mail_pending as number);
      if (mailing) return { mailing, invitee: toInvitee(r) };
      await sql.run('UPDATE invitees SET mail_pending = NULL WHERE id = ?', [r.id as number]);
    }
  },
  /** Итог отправки одного письма: error — текст ошибки или null */
  async markSent(mailingId: number, inviteeId: number, error: string | null): Promise<void> {
    await sql.tx(async (q) => {
      // Письмо могли убрать из очереди (рассылку остановили) — тогда не считаем
      const still = await q.get('SELECT 1 AS x FROM invitees WHERE id = ? AND mail_pending = ?', [inviteeId, mailingId]);
      if (error) {
        await q.run('UPDATE invitees SET mail_pending = NULL, mail_error = ? WHERE id = ?', [error.slice(0, 300), inviteeId]);
        if (still) await q.run('UPDATE mailings SET failed = failed + 1 WHERE id = ?', [mailingId]);
      } else {
        await q.run('UPDATE invitees SET mail_pending = NULL, mail_error = NULL, mail_sent_at = ?, mail_count = mail_count + 1 WHERE id = ?', [now(), inviteeId]);
        await q.run('UPDATE mailings SET sent = sent + 1 WHERE id = ?', [mailingId]);
      }
      await q.run(`UPDATE mailings SET finished_at = ? WHERE id = ? AND finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invitees WHERE mail_pending = ?)`, [now(), mailingId, mailingId]);
    });
  },
  /** Остановить рассылку: неотправленные письма убираются из очереди */
  async cancel(projectId: string, id: number): Promise<boolean> {
    return sql.tx(async (q) => {
      const n = (await q.run('UPDATE mailings SET cancelled = 1, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND project_id = ? AND finished_at IS NULL',
        [now(), id, projectId])).changes;
      if (n > 0) await q.run('UPDATE invitees SET mail_pending = NULL WHERE mail_pending = ?', [id]);
      return n > 0;
    });
  },
};
