import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Builder } from './Builder.tsx';
import { JsonTab } from './JsonTab.tsx';
import { DataTab } from './DataTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { IssuesList, Toaster, toast } from './common.tsx';
import { navigate } from './AdminApp.tsx';
import { STATUS_TEXT } from './SurveyList.tsx';
import { validateSurvey } from '../../../shared/validate.ts';
import type { Survey } from '../../../shared/types.ts';

export interface SurveyInfo {
  id: string;
  title: string;
  draft: Survey;
  published: Survey | null;
  version: number;
  status: 'draft' | 'active' | 'closed';
  sheets: any;
  counts: { real: Record<string, number>; test: number };
  sheetsAccount: { configured: boolean; email: string | null };
}

type Tab = 'builder' | 'json' | 'settings' | 'data';

export function Editor({ id }: { id: string }) {
  const [info, setInfo] = useState<SurveyInfo | null>(null);
  const [def, setDef] = useState<Survey | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get('tab') as Tab) || 'builder');
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    const r = await api<SurveyInfo>('GET', `/api/admin/surveys/${id}`);
    setInfo(r);
    return r;
  };
  useEffect(() => { reload().then((r) => setDef(r.draft)); /* eslint-disable-next-line */ }, [id]);

  // Предупреждение о несохранённых изменениях
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const validation = useMemo(() => (def ? validateSurvey(def) : null), [def]);

  if (!info || !def || !validation) return <div className="container muted">Загрузка…</div>;

  const update = (next: Survey) => { setDef(next); setDirty(true); };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await api('PUT', `/api/admin/surveys/${id}`, { definition: def });
      setDirty(false);
      await reload();
      toast(validation.ok ? 'Сохранено' : 'Черновик сохранён (есть ошибки — опубликовать нельзя)');
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Ошибка сохранения');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (dirty && !(await save())) return;
    const hasData = Object.values(info.counts.real).some((n) => n > 0);
    if (hasData && !window.confirm('По анкете уже есть ответы. Опубликовать новую версию? Незавершённые респонденты продолжат по новой версии.')) return;
    const r = await api('POST', `/api/admin/surveys/${id}/publish`);
    await reload();
    toast(`Опубликована версия ${r.version}`);
  };

  const preview = async () => {
    if (dirty && !(await save())) return;
    if (!validation.ok && !window.confirm('В анкете есть ошибки — предпросмотр может работать неверно. Продолжить?')) return;
    window.open(`/s/${id}?preview=1&new=1`, '_blank');
  };

  const setStatus = async (status: 'active' | 'closed') => {
    await api('POST', `/api/admin/surveys/${id}/status`, { status });
    await reload();
  };

  const link = `${window.location.origin}/s/${id}`;
  const unpublished = info.published ? JSON.stringify(info.published) !== JSON.stringify(def) : true;
  const changeTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };

  return (
    <div className="container">
      <div className="editor-head">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin')}>← Анкеты</button>
        <h1 className="grow">{def.title}</h1>
        <span className={`badge ${info.status}`}>{STATUS_TEXT[info.status]}{info.version ? ` · v${info.version}` : ''}</span>
        {unpublished && info.version > 0 && <span className="badge test">Есть неопубликованные изменения</span>}
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="link-box grow">
          <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{link}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }}>Копировать</button>
        </div>
        <button className="btn btn-secondary" onClick={preview}>Предпросмотр</button>
        <button className="btn btn-secondary" disabled={!dirty || saving} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>
        <button className="btn btn-primary" disabled={!validation.ok} onClick={publish}>Опубликовать</button>
        {info.status === 'active' && <button className="btn btn-danger" onClick={() => setStatus('closed')}>Закрыть сбор</button>}
        {info.status === 'closed' && <button className="btn btn-secondary" onClick={() => setStatus('active')}>Возобновить сбор</button>}
      </div>

      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <details className="card" open={validation.errors.length > 0} style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {validation.errors.length > 0 && <span style={{ color: 'var(--danger)' }}>Ошибок: {validation.errors.length}. </span>}
            {validation.warnings.length > 0 && <span style={{ color: 'var(--warn)' }}>Предупреждений: {validation.warnings.length}</span>}
          </summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {validation.errors.length > 0 && <div className="error-box"><IssuesList issues={validation.errors} /></div>}
            {validation.warnings.length > 0 && <div className="warn-box"><IssuesList issues={validation.warnings} /></div>}
          </div>
        </details>
      )}

      <div className="tabs">
        {([['builder', 'Конструктор'], ['json', 'JSON'], ['settings', 'Настройки, CSS и скрипты'], ['data', 'Данные']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => changeTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'builder' && <Builder def={def} onChange={update} issues={validation} />}
      {tab === 'json' && <JsonTab def={def} onChange={update} />}
      {tab === 'settings' && <SettingsTab def={def} onChange={update} />}
      {tab === 'data' && <DataTab info={info} reload={reload} />}
      <Toaster />
    </div>
  );
}
