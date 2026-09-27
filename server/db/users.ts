// Пользователи админки и их роли
import type { Row } from '../sql.ts';
import { ci, enc, now, parseJson, sql, updateRow } from './connection.ts';

/**
 * admin — всё, включая пользователей и копии базы; editor — анкеты и данные; viewer — только просмотр и выгрузки;
 * client — заказчик: только свои проекты (сводка, отчёт, данные), без анкет и настроек
 */
export type Role = 'admin' | 'editor' | 'viewer' | 'client';

export interface UserRow {
  login: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Для заказчика: проекты, которые он видит */
  projects: string[];
}

const toUser = (r: Row): UserRow => ({
  login: r.login as string, role: r.role as Role, disabled: r.disabled === 1,
  createdAt: r.created_at as string, lastLoginAt: (r.last_login_at as string) ?? null,
  projects: parseJson(r.projects, []),
});

export const users = {
  async list(): Promise<UserRow[]> {
    return (await sql.all('SELECT * FROM users ORDER BY lower(login)')).map(toUser);
  },
  async get(login: string): Promise<(UserRow & { passwordHash: string }) | null> {
    const r = await sql.get(`SELECT * FROM users WHERE ${ci('login')}`, [login]);
    return r ? { ...toUser(r), passwordHash: r.password as string } : null;
  },
  async create(login: string, passwordHash: string, role: Role): Promise<void> {
    await sql.run('INSERT INTO users (login, password, role, created_at) VALUES (?, ?, ?, ?)', [login, passwordHash, role, now()]);
  },
  async update(login: string, patch: { passwordHash?: string; role?: Role; disabled?: boolean; projects?: string[] }): Promise<void> {
    await updateRow('users', ci('login'), login, patch, {
      projects: ['projects', enc.jsonOrNull], passwordHash: 'password', role: 'role', disabled: ['disabled', enc.bool],
    });
  },
  async touch(login: string): Promise<void> {
    await sql.run(`UPDATE users SET last_login_at = ? WHERE ${ci('login')}`, [now(), login]);
  },
  async remove(login: string): Promise<void> {
    await sql.run(`DELETE FROM users WHERE ${ci('login')}`, [login]);
  },
};
