import './admin.css';
import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ChangePassword, ROLE_LABELS, UsersPage, type Role } from './UsersPage.tsx';
import { Menu, Toaster } from './common.tsx';
import { SurveyList } from './SurveyList.tsx';
import { ProjectList, ProjectPage } from './ProjectPage.tsx';
import { Editor } from './Editor.tsx';
import { PrintView } from './PrintView.tsx';
import { ConnectorDialog } from './ConnectorDialog.tsx';
import { AuditPage } from './AuditPage.tsx';

export interface Me { login: string; role: Role; builtIn: boolean }

const MeContext = createContext<Me>({ login: '', role: 'viewer', builtIn: false });
/** Текущий пользователь админки */
export const useMe = () => useContext(MeContext);
export const canEdit = (me: Me) => me.role !== 'viewer' && me.role !== 'client';
/** Заказчик: видит только свои проекты — сводку, отчёт и данные */
export const isClient = (me: Me) => me.role === 'client';

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
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [pwOpen, setPwOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const path = usePath();

  useEffect(() => {
    api('GET', '/api/admin/me').then((r) => setMe(r.login ? r : null)).catch(() => setMe(null));
  }, []);

  if (me === undefined) return null;
  if (!me) return <Login onDone={setMe} />;

  const printMatch = path.match(/^\/admin\/s\/([\w-]+)\/print/);
  if (printMatch) return <MeContext.Provider value={me}><PrintView id={printMatch[1]} /></MeContext.Provider>;
  const editorMatch = path.match(/^\/admin\/s\/([\w-]+)/);
  const projectMatch = path.match(/^\/admin\/p\/([\w-]+)/);
  const section = editorMatch || path.startsWith('/admin/surveys') ? 'surveys' : 'projects';
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  return (
    <MeContext.Provider value={me}>
      <div className="admin">
        <header className="topbar">
          <a className="logo" href="/admin" onClick={go('/admin')}><img src="/surveylab-logo.svg" alt="SurveyLAB" /></a>
          <nav className="top-nav">
            <a href="/admin" className={section === 'projects' ? 'active' : ''} onClick={go('/admin')}>Проекты</a>
            {!isClient(me) && <a href="/admin/surveys" className={section === 'surveys' ? 'active' : ''} onClick={go('/admin/surveys')}>Анкеты</a>}
          </nav>
          <div className="spacer" />
          <Menu className="btn btn-secondary btn-sm user-menu" label={<>{me.login} <span className="muted">· {ROLE_LABELS[me.role]}</span></>} title="Учётная запись" items={[
            me.role === 'admin' && { label: 'Пользователи', onClick: () => navigate('/admin/users') },
            me.role === 'admin' && { label: 'Журнал действий', onClick: () => navigate('/admin/audit') },
            !isClient(me) && { label: 'ИИ-коннектор (Claude, ChatGPT)', onClick: () => setAiOpen(true) },
            !me.builtIn && { label: 'Сменить пароль', onClick: () => setPwOpen(true) },
            { label: 'Выйти', onClick: async () => { await api('POST', '/api/admin/logout'); setMe(null); } },
          ]} />
        </header>
        {path.startsWith('/admin/users') && me.role === 'admin'
          ? <UsersPage me={me.login} />
          : path.startsWith('/admin/audit') && me.role === 'admin' ? <AuditPage key={window.location.search} />
          : isClient(me) ? (projectMatch ? <ProjectPage key={projectMatch[1]} id={projectMatch[1]} /> : <ProjectList />)
          : editorMatch ? <Editor key={editorMatch[1]} id={editorMatch[1]} />
            : projectMatch ? <ProjectPage key={projectMatch[1]} id={projectMatch[1]} />
              : path.startsWith('/admin/surveys') ? <SurveyList /> : <ProjectList />}
        {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
        {aiOpen && <ConnectorDialog onClose={() => setAiOpen(false)} />}
        <Toaster />
      </div>
    </MeContext.Provider>
  );
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [form, setForm] = useState({ login: '', password: '' });
  const [error, setError] = useState('');
  return (
    <form className="card login stack" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/admin/login', form);
        onDone(r);
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      <h2 className="login-logo"><img src="/surveylab-logo.svg" alt="SurveyLAB" /></h2>
      <label className="field"><span>Логин</span>
        <input className="input" autoComplete="username" autoFocus value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
      </label>
      <label className="field"><span>Пароль</span>
        <input className="input" type="password" autoComplete="current-password" value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn btn-primary">Войти</button>
    </form>
  );
}
