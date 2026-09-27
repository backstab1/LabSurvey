// OAuth для ИИ-коннекторов (Claude, ChatGPT)
import type { Row } from '../sql.ts';
import { ci, newId, now, sql } from './connection.ts';

export interface OAuthClient { id: string; name: string; secretHash: string | null; redirectUris: string[]; createdAt: string }
export interface OAuthGrant { clientId: string; login: string; scope: string | null; expiresAt: string }

const toClient = (r: Row): OAuthClient => ({
  id: r.id as string, name: r.name as string, secretHash: (r.secret_hash as string) ?? null,
  redirectUris: JSON.parse(r.redirect_uris as string), createdAt: r.created_at as string,
});

/** Коды, токены и секреты хранятся только как хэши */
export const oauth = {
  async createClient(c: { name: string; secretHash: string | null; redirectUris: string[] }): Promise<OAuthClient> {
    const id = `sl_${newId(20)}`;
    await sql.run('INSERT INTO oauth_clients (id, name, secret_hash, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, c.name, c.secretHash, JSON.stringify(c.redirectUris), now()]);
    return (await this.client(id))!;
  },
  async client(id: string): Promise<OAuthClient | null> {
    const r = await sql.get('SELECT * FROM oauth_clients WHERE id = ?', [id]);
    return r ? toClient(r) : null;
  },
  async saveCode(codeHash: string, g: OAuthGrant & { redirectUri: string; challenge: string }): Promise<void> {
    await sql.run('DELETE FROM oauth_codes WHERE expires_at < ?', [now()]);
    await sql.run('INSERT INTO oauth_codes (code_hash, client_id, login, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [codeHash, g.clientId, g.login, g.redirectUri, g.challenge, g.scope, g.expiresAt]);
  },
  /** Код одноразовый: читается и удаляется одной командой */
  async takeCode(codeHash: string): Promise<(OAuthGrant & { redirectUri: string; challenge: string }) | null> {
    const r = await sql.get('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *', [codeHash]);
    if (!r) return null;
    if ((r.expires_at as string) < now()) return null;
    return {
      clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null,
      expiresAt: r.expires_at as string, redirectUri: r.redirect_uri as string, challenge: r.challenge as string,
    };
  },
  async saveToken(tokenHash: string, kind: 'access' | 'refresh', g: OAuthGrant): Promise<void> {
    await sql.run('INSERT INTO oauth_tokens (token_hash, kind, client_id, login, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tokenHash, kind, g.clientId, g.login, g.scope, g.expiresAt, now()]);
  },
  /** Действующий токен (просроченные удаляются) */
  async token(tokenHash: string, kind: 'access' | 'refresh'): Promise<OAuthGrant | null> {
    const r = await sql.get('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?', [tokenHash, kind]);
    if (!r) return null;
    if ((r.expires_at as string) < now()) {
      await sql.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [tokenHash]);
      return null;
    }
    if (kind === 'access') await sql.run('UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?', [now(), tokenHash]);
    return { clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null, expiresAt: r.expires_at as string };
  },
  async deleteToken(tokenHash: string): Promise<void> {
    await sql.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [tokenHash]);
  },
  /** Подключённые приложения пользователя: по клиенту — когда выдан доступ и когда им пользовались */
  async connections(login: string): Promise<{ clientId: string; name: string; since: string; lastUsedAt: string | null }[]> {
    const rows = await sql.all(`SELECT t.client_id, c.name, MIN(t.created_at) AS since, MAX(t.last_used_at) AS last_used
      FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE ${ci('t.login')} AND t.expires_at >= ?
      GROUP BY t.client_id, c.name ORDER BY since`, [login, now()]);
    return rows.map((r) => ({
      clientId: r.client_id as string, name: r.name as string, since: r.since as string, lastUsedAt: (r.last_used as string) ?? null,
    }));
  },
  /** Отозвать доступ приложения (или всех приложений, если clientId не задан) */
  async revoke(login: string, clientId?: string): Promise<number> {
    const res = clientId
      ? await sql.run(`DELETE FROM oauth_tokens WHERE ${ci('login')} AND client_id = ?`, [login, clientId])
      : await sql.run(`DELETE FROM oauth_tokens WHERE ${ci('login')}`, [login]);
    return res.changes;
  },
};
