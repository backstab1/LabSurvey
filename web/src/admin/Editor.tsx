import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Builder } from './Builder.tsx';
import { JsonTab } from './JsonTab.tsx';
import { DataTab } from './DataTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { IssuesList, Menu, Toaster, toast } from './common.tsx';
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
type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Черновик сохранён',
  pending: 'Изменения…',
  saving: 'Сохранение…',
  error: 'Не сохранено — повторите',
};

export function Editor({ id }: { id: string }) {
  const [info, setInfo] = useState<SurveyInfo | null>(null);
  const [def, setDef] = useState<Survey | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(window.location.search).get('tab') as Tab) || 'builder');
  const [save, setSave] = useState<SaveState>('saved');
  const [showIssues, setShowIssues] = useState(false);
  const [focus, setFocus] = useState<{ where: string; n: number }>();
  const latest = useRef<Survey | null>(null);

  const reload = useCallback(async () => {
    const r = await api<SurveyInfo>('GET', `/api/admin/surveys/${id}`);
    setInfo(r);
    return r;
  }, [id]);
  useEffect(() => { reload().then((r) => { setDef(r.draft); latest.current = r.draft; }); }, [reload]);

  // Автосохранение черновика через секунду после последней правки
  const flush = useCallback(async () => {
    const d = latest.current;
    if (!d) return true;
    setSave('saving');
    try {
      await api('PUT', `/api/admin/surveys/${id}`, { definition: d });
      if (latest.current === d) setSave('saved');
      else setSave('pending');
      return true;
    } catch (e) {
      setSave('error');
      toast(e instanceof ApiError ? e.message : 'Ошибка сохранения');
      return false;
    }
  }, [id]);
  useEffect(() => {
    if (save !== 'pending') return;
    const t = setTimeout(flush, 800);
    return () => clearTimeout(t);
  }, [save, def, flush]);
  useEffect(() => {
    if (save === 'saved') return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [save]);

  const validation = useMemo(() => (def ? validateSurvey(def) : null), [def]);

  if (!info || !def || !validation) return <div className="container muted">Загрузка…</div>;

  const update = (next: Survey) => { setDef(next); latest.current = next; setSave('pending'); };
  const saveNow = async () => (save === 'saved' ? true : flush());

  const publish = async () => {
    if (!(await saveNow())) return;
    const hasData = Object.values(info.counts.real).some((n) => n > 0);
    if (hasData && !window.confirm('По анкете уже есть ответы. Опубликовать новую версию? Незавершённые респонденты продолжат по новой версии.')) return;
    try {
      const r = await api('POST', `/api/admin/surveys/${id}/publish`);
      await reload();
      toast(`Опубликовано (версия ${r.version})`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const preview = async () => {
    if (!(await saveNow())) return;
    window.open(`/s/${id}?preview=1&new=1`, '_blank');
  };

  const setStatus = async (status: 'active' | 'closed') => {
    await api('POST', `/api/admin/surveys/${id}/status`, { status });
    await reload();
  };

  const link = `${window.location.origin}/s/${id}`;
  const unpublished = !info.published || JSON.stringify(info.published) !== JSON.stringify(def);
  const changeTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const errs = validation.errors.length;
  const warns = validation.warnings.length;

  return (
    <div className="container editor">
      <div className="editor-head">
        <button className="icon-btn back" title="Все анкеты" onClick={() => navigate('/admin')}>←</button>
        <input className="title-input" value={def.title} placeholder="Название анкеты" aria-label="Название анкеты"
          onChange={(e) => update({ ...def, title: e.target.value })} />
        <span className={`badge ${info.status}`}>{STATUS_TEXT[info.status]}</span>
        <span className={`save-state ${save}`} onClick={save === 'error' ? () => flush() : undefined}>{SAVE_TEXT[save]}</span>
        <span className="grow" />
        <button className="btn btn-secondary" onClick={preview}>Предпросмотр</button>
        <button className="btn btn-primary" disabled={!validation.ok || !unpublished} onClick={publish}
          title={!validation.ok ? 'Сначала исправьте ошибки' : !unpublished ? 'Опубликованная версия совпадает с черновиком' : ''}>
          {!info.published ? 'Опубликовать' : unpublished ? 'Опубликовать изменения' : 'Опубликовано'}
        </button>
        <Menu className="btn btn-secondary menu-trigger" items={[
          { label: 'Скопировать ссылку на опрос', onClick: () => { navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } },
          info.status === 'active' && { label: 'Закрыть сбор ответов', onClick: () => setStatus('closed') },
          info.status === 'closed' && { label: 'Возобновить сбор', onClick: () => setStatus('active') },
          { label: 'Дублировать анкету', onClick: async () => { const r = await api('POST', `/api/admin/surveys/${id}/duplicate`); navigate(`/admin/s/${r.id}`); } },
          { label: 'Скачать JSON', onClick: () => { window.location.href = `/api/admin/surveys/${id}/export.json`; } },
          {
            label: 'Удалить анкету', danger: true, onClick: async () => {
              const n = Object.values(info.counts.real).reduce((a, b) => a + b, 0);
              if (!window.confirm(`Удалить анкету${n ? ` и ${n} ответов` : ''}? Это нельзя отменить.`)) return;
              await api('DELETE', `/api/admin/surveys/${id}`);
              navigate('/admin');
            },
          },
        ]} />
      </div>

      <div className="tabs-row">
        <div className="tabs">
          {([['builder', 'Конструктор'], ['json', 'JSON'], ['settings', 'Настройки'], ['data', 'Данные']] as [Tab, string][]).map(([t, label]) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => changeTab(t)}>{label}</button>
          ))}
        </div>
        {info.published && (
          <button className="link-chip" title="Скопировать ссылку" onClick={() => { navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }}>
            🔗 {link.replace(/^https?:\/\//, '')}
          </button>
        )}
        {(errs > 0 || warns > 0) && (
          <button className={`issues-chip${errs ? ' err' : ''}`} onClick={() => setShowIssues(!showIssues)}>
            {errs > 0 ? `Ошибок: ${errs}` : ''}{errs && warns ? ' · ' : ''}{warns > 0 ? `Предупреждений: ${warns}` : ''}
          </button>
        )}
      </div>
      {showIssues && (errs > 0 || warns > 0) && (
        <div className="issues-panel">
          {errs > 0 && <IssuesList issues={validation.errors} onPick={(where) => { changeTab('builder'); setFocus({ where, n: Date.now() }); }} />}
          {warns > 0 && <div className="warn-list"><IssuesList issues={validation.warnings} onPick={(where) => { changeTab('builder'); setFocus({ where, n: Date.now() }); }} /></div>}
        </div>
      )}

      {tab === 'builder' && <Builder def={def} onChange={update} issues={validation} focus={focus} />}
      {tab === 'json' && <JsonTab def={def} onChange={update} />}
      {tab === 'settings' && <SettingsTab def={def} onChange={update} />}
      {tab === 'data' && <DataTab info={info} reload={reload} />}
      <Toaster />
    </div>
  );
}
