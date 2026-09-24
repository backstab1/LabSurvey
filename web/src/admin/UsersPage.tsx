import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Modal, toast } from './common.tsx';

export type Role = 'admin' | 'editor' | 'viewer';

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};

const ROLE_HINTS: Record<Role, string> = {
  admin: 'всё, включая пользователей и резервные копии',
  editor: 'создаёт и публикует анкеты, работает с данными',
  viewer: 'только смотрит анкеты, отчёты и делает выгрузки',
};

interface UserRow { login: string; role: Role; disabled: boolean; createdAt: string; lastLoginAt: string | null }

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Управление доступом команды (только для администратора) */
export function UsersPage({ me }: { me: string }) {
  const [list, setList] = useState<UserRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api<UserRow[]>('GET', '/api/admin/users').then(setList).catch((e) => toast((e as Error).message));
  useEffect(() => { load(); }, []);

  const update = async (login: string, patch: Partial<{ role: Role; disabled: boolean; password: string }>) => {
    try {
      await api('PUT', `/api/admin/users/${encodeURIComponent(login)}`, patch);
      await load();
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 24 }}>Пользователи</h1>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Пользователь</button>
      </div>
      <p className="muted small">
        Главный администратор задаётся в .env (ADMIN_LOGIN / ADMIN_PASSWORD) и здесь не показывается.
        Роли: {(Object.keys(ROLE_LABELS) as Role[]).map((r) => `${ROLE_LABELS[r].toLowerCase()} — ${ROLE_HINTS[r]}`).join('; ')}.
      </p>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!list ? <p className="muted" style={{ padding: 20 }}>Загрузка…</p> : list.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>Пока только главный администратор. Добавьте коллег.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Логин</th><th>Роль</th><th>Последний вход</th><th /></tr></thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.login} className={u.disabled ? 'muted' : ''}>
                  <td><strong>{u.login}</strong>{u.disabled && <span className="badge" style={{ marginLeft: 8 }}>отключён</span>}</td>
                  <td>
                    <select className="input" style={{ width: 'auto', minHeight: 34 }} value={u.role} disabled={u.login === me}
                      onChange={(e) => update(u.login, { role: e.target.value as Role })}>
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td className="muted">{fmt(u.lastLoginAt)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-link" onClick={() => {
                      const password = window.prompt(`Новый пароль для ${u.login} (не короче 8 символов)`);
                      if (password) update(u.login, { password }).then(() => toast('Пароль изменён'));
                    }}>сменить пароль</button>
                    {u.login !== me && (
                      <>
                        <button className="btn-link" onClick={() => update(u.login, { disabled: !u.disabled })}>{u.disabled ? 'включить' : 'отключить'}</button>
                        <button className="btn-link" style={{ color: 'var(--danger)' }} onClick={async () => {
                          if (!window.confirm(`Удалить пользователя ${u.login}?`)) return;
                          await api('DELETE', `/api/admin/users/${encodeURIComponent(u.login)}`);
                          load();
                        }}>удалить</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddUser onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </div>
  );
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ login: '', password: '', role: 'editor' as Role });
  const [error, setError] = useState('');
  return (
    <Modal onClose={onClose} title="Новый пользователь">
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/admin/users', form); onDone(); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="field"><span>Логин</span>
          <input className="input" autoFocus autoComplete="off" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
        </label>
        <label className="field"><span>Пароль (не короче 8 символов)</span>
          <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label className="field"><span>Роль</span>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]} — {ROLE_HINTS[r]}</option>)}
          </select>
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!form.login || form.password.length < 8}>Создать</button>
        </div>
      </form>
    </Modal>
  );
}

/** Смена своего пароля */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ current: '', next: '' });
  const [error, setError] = useState('');
  return (
    <Modal onClose={onClose} title="Сменить пароль">
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/admin/me/password', form); toast('Пароль изменён'); onClose(); } catch (err) { setError((err as Error).message); }
      }}>
        <label className="field"><span>Текущий пароль</span>
          <input className="input" type="password" autoComplete="current-password" autoFocus value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </label>
        <label className="field"><span>Новый пароль (не короче 8 символов)</span>
          <input className="input" type="password" autoComplete="new-password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!form.current || form.next.length < 8}>Сменить</button>
        </div>
      </form>
    </Modal>
  );
}
