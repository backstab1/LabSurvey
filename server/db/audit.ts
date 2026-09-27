// Журнал действий команды
import type { Param } from '../sql.ts';
import { LIKE, ci, isSame, now, sql } from './connection.ts';

export interface AuditEntry {
  id: number;
  at: string;
  login: string | null;
  /** ui — интерфейс, ai — ИИ-коннектор (details.app — приложение) */
  via: 'ui' | 'ai';
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetTitle: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

/** Сколько дней хранить журнал */
const AUDIT_KEEP_DAYS = 365;
let auditPrunedAt = 0;

export const audit = {
  /**
   * Записать действие. coalesceMin — если то же действие того же человека над тем же объектом было недавно,
   * обновляется время прежней записи (автосохранение черновика не засоряет журнал).
   */
  async add(e: Omit<AuditEntry, 'id' | 'at'>, coalesceMin = 0): Promise<void> {
    const t = now();
    if (coalesceMin > 0) {
      const since = new Date(Date.now() - coalesceMin * 60_000).toISOString();
      const prev = await sql.get(`SELECT id FROM audit WHERE login ${isSame} AND via = ? AND action = ? AND target_type ${isSame} AND target_id ${isSame} AND at >= ?
        ORDER BY id DESC LIMIT 1`, [e.login, e.via, e.action, e.targetType, e.targetId, since]);
      if (prev) {
        await sql.run('UPDATE audit SET at = ?, target_title = COALESCE(?, target_title) WHERE id = ?', [t, e.targetTitle, prev.id as number]);
        return;
      }
    }
    await sql.run(`INSERT INTO audit (at, login, via, action, target_type, target_id, target_title, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      t, e.login, e.via, e.action, e.targetType, e.targetId, e.targetTitle, e.details ? JSON.stringify(e.details) : null, e.ip,
    ]);
    if (Date.now() - auditPrunedAt > 86400_000) {
      auditPrunedAt = Date.now();
      await sql.run('DELETE FROM audit WHERE at < ?', [new Date(Date.now() - AUDIT_KEEP_DAYS * 86400_000).toISOString()]);
    }
  },

  /** Записи от новых к старым; фильтры необязательны */
  async list(f: { login?: string; targetType?: string; targetId?: string; via?: string; q?: string; from?: string; to?: string; before?: number; limit?: number } = {}):
    Promise<AuditEntry[]> {
    const where: string[] = [];
    const vals: Param[] = [];
    if (f.login) { where.push(ci('login')); vals.push(f.login); }
    if (f.targetType) { where.push('target_type = ?'); vals.push(f.targetType); }
    if (f.targetId) { where.push('target_id = ?'); vals.push(f.targetId); }
    if (f.via) { where.push('via = ?'); vals.push(f.via); }
    if (f.from) { where.push('at >= ?'); vals.push(f.from); }
    if (f.to) { where.push('at < ?'); vals.push(f.to); }
    if (f.before) { where.push('id < ?'); vals.push(f.before); }
    if (f.q) {
      where.push(`(action ${LIKE} ? OR target_title ${LIKE} ? OR target_id ${LIKE} ? OR login ${LIKE} ?)`);
      const like = `%${f.q.replace(/[%_]/g, '')}%`;
      vals.push(like, like, like, like);
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = await sql.all(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, vals);
    return rows.map((r) => ({
      id: r.id as number, at: r.at as string, login: (r.login as string) ?? null, via: r.via as 'ui' | 'ai', action: r.action as string,
      targetType: (r.target_type as string) ?? null, targetId: (r.target_id as string) ?? null, targetTitle: (r.target_title as string) ?? null,
      details: r.details ? JSON.parse(r.details as string) : null, ip: (r.ip as string) ?? null,
    }));
  },

  /** Логины, встречающиеся в журнале (для фильтра) */
  async logins(): Promise<string[]> {
    return (await sql.all('SELECT DISTINCT login FROM audit WHERE login IS NOT NULL ORDER BY login')).map((r) => r.login as string);
  },
};
