import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { SurveyList } from './SurveyList.tsx';
import { Editor } from './Editor.tsx';

export function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function AdminApp() {
  const [login, setLogin] = useState<string | null | undefined>(undefined);
  const path = usePath();

  useEffect(() => {
    api('GET', '/api/admin/me').then((r) => setLogin(r.login)).catch(() => setLogin(null));
  }, []);

  if (login === undefined) return null;
  if (!login) return <Login onDone={setLogin} />;

  const editorMatch = path.match(/^\/admin\/s\/([\w-]+)/);
  return (
    <div className="admin">
      <header className="topbar">
        <a className="logo" href="/admin" onClick={(e) => { e.preventDefault(); navigate('/admin'); }}>Survey<span>LAB</span></a>
        <div className="spacer" />
        <span className="muted">{login}</span>
        <button className="btn btn-secondary btn-sm" onClick={async () => { await api('POST', '/api/admin/logout'); setLogin(null); }}>Выйти</button>
      </header>
      {editorMatch ? <Editor key={editorMatch[1]} id={editorMatch[1]} /> : <SurveyList />}
    </div>
  );
}

function Login({ onDone }: { onDone: (login: string) => void }) {
  const [form, setForm] = useState({ login: 'admin', password: '' });
  const [error, setError] = useState('');
  return (
    <form className="card login stack" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/admin/login', form);
        onDone(r.login);
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      <h2>Survey<span style={{ color: 'var(--accent)' }}>LAB</span></h2>
      <label className="field"><span>Логин</span>
        <input className="input" autoComplete="username" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
      </label>
      <label className="field"><span>Пароль</span>
        <input className="input" type="password" autoComplete="current-password" autoFocus value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary">Войти</button>
    </form>
  );
}
