import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { canEdit, isClient, navigate, useMe } from './AdminApp.tsx';
import { DataTab } from './DataTab.tsx';
import { ReportTab } from './ReportTab.tsx';
import { ConditionField } from './ConditionEditor.tsx';
import { Menu, Modal, compact, toast } from './common.tsx';
import { nextId } from '../../../shared/refactor.ts';
import { allQuestions } from '../../../shared/logic.ts';
import {
  PANEL_PARAM, PROJECT_STATUS_LABELS, type Panel, type ProjectSettings, type ProjectStatus, type Quota, type Survey,
} from '../../../shared/types.ts';

export interface ProjectInfo {
  id: string;
  title: string;
  status: ProjectStatus;
  settings: ProjectSettings;
  quotaDefs: Quota[];
  panels: Panel[];
  /** Счётчики настоящих анкет по панелям; panel = null — прямая ссылка */
  panelCounts: PanelCounts[];
  /** Прогресс квот по опубликованной версии */
  quotas: { id: string; title?: string; limit: number; count: number }[];
  survey: { id: string; title: string; version: number; published: boolean; unpublished: boolean };
  /** Анкета с настройками проекта */
  draft: Survey;
  published: Survey | null;
  sheets: any;
  notify: {
    webhookUrl?: string; telegramChatId?: string; everyN?: number; quotaFull?: boolean; limitReached?: boolean;
    lastError?: string | null; lastSentAt?: string;
  } | null;
  counts: { real: Record<string, number>; test: number; rejected: number };
  sheetsAccount: { configured: boolean; email: string | null };
  testToken: string;
  telegramConfigured: boolean;
  /** Динамика по дням (последние 60 дней с первой анкеты) */
  daily: DayStat[];
}

export interface DayStat { day: string; started: number; completed: number; screenedOut: number; overquota: number }

/** Копия проекта для новой волны: спрашивает название и открывает копию */
async function copyProject(id: string, title: string) {
  const name = window.prompt('Название копии. Скопируются анкета, настройки сбора, квоты и панели — без ответов, Google Sheets и уведомлений.', `${title} (копия)`);
  if (name === null) return;
  try {
    const r = await api<{ id: string }>('POST', `/api/admin/projects/${id}/copy`, { title: name });
    navigate(`/admin/p/${r.id}`);
    toast('Проект скопирован');
  } catch (e) { toast((e as Error).message); }
}

export interface PanelCounts { panel: string | null; statuses: Record<string, number>; rejected: number; medianSec: number | null }

/** Что значит статус проекта для респондентов */
export const STATUS_HINTS: Record<ProjectStatus, string> = {
  development: 'Проект готовится. Респонденты видят «Опрос ещё не начался», работает только тестовая ссылка.',
  collecting: 'Идёт сбор: ссылка открыта для респондентов, работают сроки, лимиты и квоты.',
  processing: 'Сбор остановлен: новые анкеты не принимаются, данные и отчёты доступны.',
  archive: 'Проект завершён и убран в архив. Сбор закрыт, данные сохранены.',
};

const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');

// ======================= Список проектов =======================

interface ProjectRow {
  id: string; title: string; status: ProjectStatus; surveyId: string; surveyTitle: string; counts: Record<string, number>;
  maxResponses: number | null; openFrom: string | null; closeAt: string | null; quotas: number; quotasFull: number; updatedAt: string;
}

export function ProjectList() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'active' | ProjectStatus>('active');
  const editable = canEdit(useMe());

  const load = () => api<ProjectRow[]>('GET', '/api/admin/projects').then(setRows);
  useEffect(() => { load(); }, []);

  const shown = (rows ?? []).filter((r) => (status === 'active' ? r.status !== 'archive' : r.status === status)
    && `${r.title} ${r.surveyTitle}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 24 }}>Проекты</h1>
        {editable && <button className="btn btn-primary" onClick={() => setNewOpen(true)}>+ Новый проект</button>}
      </div>
      {rows && rows.length > 0 && (
        <div className="row list-filters">
          <input className="input" type="search" placeholder="Поиск по проекту или анкете…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Все, кроме архива</option>
            {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => (
              <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]} ({rows.filter((r) => r.status === s).length})</option>
            ))}
          </select>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows === null ? <p className="muted" style={{ padding: 20 }}>Загрузка…</p> : rows.length === 0 ? (
          <div style={{ padding: 20 }}>
            <p className="muted" style={{ marginTop: 0 }}>Проектов пока нет. Проект — это запуск анкеты: статус сбора, сроки, квоты, данные и отчёты.</p>
            {editable && <button className="btn btn-primary" onClick={() => setNewOpen(true)}>Создать первый проект</button>}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Проект</th><th>Статус</th><th>Завершили</th><th className="wide-only">Квоты</th><th className="wide-only">Сроки</th><th /></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/p/${r.id}`)}>
                  <td><strong>{r.title}</strong><div className="muted" style={{ fontSize: 13 }}>/s/{r.id} · анкета «{r.surveyTitle}»</div></td>
                  <td><span className={`badge status-${r.status}`}>{PROJECT_STATUS_LABELS[r.status]}</span></td>
                  <td>{r.counts.completed ?? 0}{r.maxResponses ? <span className="muted"> / {r.maxResponses}</span> : null}</td>
                  <td className="wide-only">{r.quotas ? <>{r.quotasFull} из {r.quotas} набрано</> : <span className="muted">—</span>}</td>
                  <td className="wide-only muted small">
                    {r.openFrom || r.closeAt ? <>{r.openFrom ? `с ${fmtDate(r.openFrom)}` : ''} {r.closeAt ? `до ${fmtDate(r.closeAt)}` : ''}</> : '—'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()} style={{ width: 40 }}>
                    <Menu items={[
                      { label: 'Открыть', onClick: () => navigate(`/admin/p/${r.id}`) },
                      { label: 'Скопировать ссылку', onClick: () => { navigator.clipboard.writeText(`${window.location.origin}/s/${r.id}`); toast('Ссылка скопирована'); } },
                      editable && { label: 'Открыть анкету', onClick: () => navigate(`/admin/s/${r.surveyId}`) },
                      editable && { label: 'Копировать проект (новая волна)', onClick: () => copyProject(r.id, r.title) },
                    ]} />
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={6} className="muted">Ничего не найдено</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {newOpen && <NewProjectModal onClose={() => setNewOpen(false)} />}
    </div>
  );
}

interface SurveyOption { id: string; title: string; version: number; archived: boolean; unpublished: boolean }

export function NewProjectModal({ onClose, surveyId }: { onClose: () => void; surveyId?: string }) {
  const [list, setList] = useState<SurveyOption[] | null>(null);
  const [form, setForm] = useState({ title: '', surveyId: surveyId ?? '' });
  const [error, setError] = useState('');
  useEffect(() => { api<SurveyOption[]>('GET', '/api/admin/surveys').then((l) => setList(l.filter((s) => !s.archived))); }, []);
  const picked = list?.find((s) => s.id === form.surveyId);
  return (
    <Modal onClose={onClose} title="Новый проект">
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/api/admin/projects', form);
          navigate(`/admin/p/${r.id}`);
        } catch (err) { setError((err as Error).message); }
      }}>
        <label className="field"><span>Анкета</span>
          <select className="input" value={form.surveyId} autoFocus onChange={(e) => setForm({ ...form, surveyId: e.target.value })}>
            <option value="">— выберите анкету —</option>
            {list?.map((s) => <option key={s.id} value={s.id}>{s.title}{s.version ? ` · версия ${s.version}` : ' · не опубликована'}</option>)}
          </select>
          {picked && !picked.version && <span className="field-help">Анкету нужно опубликовать до начала сбора — сейчас можно тестировать черновик.</span>}
        </label>
        <label className="field"><span>Название проекта</span>
          <input className="input" value={form.title} placeholder={picked ? picked.title : 'Например: Кофейни — волна 1, панель А'}
            onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!form.surveyId}>Создать проект</button>
        </div>
      </form>
    </Modal>
  );
}

// ======================= Страница проекта =======================

type Tab = 'overview' | 'panels' | 'quotas' | 'data' | 'report' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Сводка'], ['panels', 'Панели'], ['quotas', 'Квоты'], ['data', 'Данные'], ['report', 'Отчёт'], ['settings', 'Настройки сбора'],
];
/** Заказчику — только результаты */
const CLIENT_TABS: Tab[] = ['overview', 'report', 'data'];

export function ProjectPage({ id }: { id: string }) {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState('');
  const me = useMe();
  const client = isClient(me);
  const tabs = client ? TABS.filter(([t]) => CLIENT_TABS.includes(t)) : TABS;
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab;
    return tabs.some(([x]) => x === t) ? t : 'overview';
  });
  const [title, setTitle] = useState('');
  const readOnly = !canEdit(me);

  const reload = useCallback(async () => {
    try {
      const r = await api<ProjectInfo>('GET', `/api/admin/projects/${id}`);
      setInfo(r);
      return r;
    } catch (e) { setError((e as Error).message); return null; }
  }, [id]);
  useEffect(() => { reload().then((r) => r && setTitle(r.title)); }, [reload]);

  if (error) return <div className="container"><div className="error-box">{error}</div></div>;
  if (!info) return <div className="container muted">Загрузка…</div>;

  const link = `${window.location.origin}/s/${id}`;
  const changeTab = (t: Tab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const saveTitle = async () => {
    if (title.trim() === info.title) return;
    if (!title.trim()) { setTitle(info.title); return; }
    await api('PUT', `/api/admin/projects/${id}`, { title });
    await reload();
  };
  const setStatus = async (status: ProjectStatus) => {
    try {
      await api('POST', `/api/admin/projects/${id}/status`, { status });
      await reload();
      toast(`Статус: ${PROJECT_STATUS_LABELS[status]}`);
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="container editor">
      <div className="editor-head">
        <button className="icon-btn back" title="Все проекты" onClick={() => navigate('/admin')}>←</button>
        <input className="title-input" value={title} placeholder="Название проекта" aria-label="Название проекта" readOnly={readOnly}
          onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <span className={`badge status-${info.status}`}>{PROJECT_STATUS_LABELS[info.status]}</span>
        <span className="grow" />
        {!client && <Menu className="btn btn-secondary menu-trigger" items={[
          { label: 'Скопировать ссылку для респондентов', onClick: () => { navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } },
          { label: 'Скопировать тестовую ссылку', onClick: () => { navigator.clipboard.writeText(`${link}?test=${info.testToken}`); toast('Тестовая ссылка скопирована: черновик анкеты, ответы тестовые'); } },
          { label: 'Открыть анкету в конструкторе', onClick: () => navigate(`/admin/s/${info.survey.id}`) },
          !readOnly && { label: 'Копировать проект (новая волна)', onClick: () => copyProject(id, info.title) },
          me.role === 'admin' && { label: 'История действий', onClick: () => navigate(`/admin/audit?targetType=project&targetId=${id}`) },
          !readOnly && {
            label: 'Удалить проект', danger: true, onClick: async () => {
              const n = Object.values(info.counts.real).reduce((a, b) => a + b, 0) + info.counts.test + info.counts.rejected;
              if (!window.confirm(`Удалить проект «${info.title}»${n ? ` и все его ответы (${n})` : ''}? Анкета останется. Это нельзя отменить.`)) return;
              await api('DELETE', `/api/admin/projects/${id}`);
              navigate('/admin');
            },
          },
        ]} />}
      </div>

      <div className="tabs-row">
        <div className="tabs">
          {tabs.map(([t, label]) => (
            <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => changeTab(t)}>
              {label}{t === 'quotas' && info.quotaDefs.length > 0 && <span className="tab-count">{info.quotaDefs.length}</span>}
              {t === 'panels' && info.panels.length > 0 && <span className="tab-count">{info.panels.length}</span>}
            </button>
          ))}
        </div>
        {!client && (
          <button className="link-chip url" title="Скопировать ссылку" onClick={() => { navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }}>
            🔗 {link.replace(/^https?:\/\//, '')}
          </button>
        )}
      </div>

      {tab === 'overview' && <Overview info={info} readOnly={readOnly} client={client} setStatus={setStatus} reload={reload} onTab={changeTab} />}
      {tab === 'panels' && <PanelsTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'quotas' && <QuotasTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'data' && <DataTab info={info} reload={reload} />}
      {tab === 'report' && <ReportTab info={info} />}
      {tab === 'settings' && <CollectionSettings info={info} readOnly={readOnly} reload={reload} />}
    </div>
  );
}

// ---------- Сводка ----------

function Overview({ info, readOnly, client, setStatus, reload, onTab }: {
  info: ProjectInfo; readOnly: boolean; client: boolean; setStatus: (s: ProjectStatus) => void; reload: () => Promise<unknown>; onTab: (t: Tab) => void;
}) {
  const [surveys, setSurveys] = useState<SurveyOption[] | null>(null);
  const st = info.settings;
  const done = info.counts.real.completed ?? 0;
  const started = Object.values(info.counts.real).reduce((a, b) => a + b, 0);
  const limitPct = st.maxResponses ? Math.min(100, Math.round((done / st.maxResponses) * 100)) : 0;
  const now = Date.now();
  const timing = st.openFrom && now < Date.parse(st.openFrom) ? `Сбор откроется ${fmtDate(st.openFrom)}`
    : st.closeAt && now >= Date.parse(st.closeAt) ? `Срок сбора истёк ${fmtDate(st.closeAt)}`
      : st.maxResponses && done >= st.maxResponses ? 'Лимит анкет набран — новые респонденты не попадут в опрос' : '';

  const actions: ReactNode[] = [];
  if (!readOnly) {
    if (info.status === 'development') {
      actions.push(<button key="go" className="btn btn-primary" disabled={!info.survey.published} onClick={() => setStatus('collecting')}
        title={info.survey.published ? '' : 'Сначала опубликуйте анкету'}>Начать сбор данных</button>);
    }
    if (info.status === 'collecting') actions.push(<button key="stop" className="btn btn-secondary" onClick={() => setStatus('processing')}>Остановить сбор</button>);
    if (info.status === 'processing') {
      actions.push(<button key="resume" className="btn btn-primary" onClick={() => setStatus('collecting')}>Возобновить сбор</button>);
      actions.push(<button key="arch" className="btn btn-secondary" onClick={() => setStatus('archive')}>В архив</button>);
    }
    if (info.status === 'archive') actions.push(<button key="unarch" className="btn btn-secondary" onClick={() => setStatus('processing')}>Вернуть из архива</button>);
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ alignItems: 'center' }}>
          <h2 className="grow" style={{ margin: 0 }}>Статус: {PROJECT_STATUS_LABELS[info.status]}</h2>
          {!readOnly && (
            <select className="input" style={{ width: 'auto' }} value={info.status} aria-label="Статус проекта"
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}
            </select>
          )}
        </div>
        <p className="muted" style={{ margin: 0 }}>{STATUS_HINTS[info.status]}</p>
        {info.status === 'collecting' && timing && <div className="warn-box">{timing}</div>}
        {info.status === 'development' && !info.survey.published && (
          <div className="warn-box">Анкета ещё не опубликована — начать сбор нельзя. <button className="btn-link" onClick={() => navigate(`/admin/s/${info.survey.id}`)}>Открыть анкету</button></div>
        )}
        {actions.length > 0 && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        <div className="muted small">
          {st.openFrom || st.closeAt
            ? <>Сроки: {st.openFrom ? `с ${fmtDate(st.openFrom)}` : 'без даты начала'} {st.closeAt ? `до ${fmtDate(st.closeAt)}` : 'без даты окончания'}</>
            : 'Сроки не заданы'}
          {!client && <> · <button className="btn-link" style={{ padding: 0 }} onClick={() => onTab('settings')}>настроить</button></>}
        </div>
      </div>

      <div className="stats">
        <div className="card">
          <div className="stat">{done}{st.maxResponses ? <span className="muted" style={{ fontSize: 16 }}> / {st.maxResponses}</span> : null}</div>
          <div className="stat-label">Завершили</div>
          {st.maxResponses ? <div className="quota-bar" style={{ marginTop: 6 }}><div style={{ width: `${limitPct}%` }} className={done >= st.maxResponses ? 'full' : ''} /></div> : null}
        </div>
        <div className="card"><div className="stat">{info.counts.real.screened_out ?? 0}</div><div className="stat-label">Отсеяны</div></div>
        <div className="card"><div className="stat">{info.counts.real.overquota ?? 0}</div><div className="stat-label">Сверх квоты</div></div>
        <div className="card"><div className="stat">{info.counts.real.in_progress ?? 0}</div><div className="stat-label">В процессе / бросили</div></div>
        <div className="card"><div className="stat">{started}</div><div className="stat-label">Всего начали</div></div>
        <div className="card">
          <div className="stat">{pct(done, started)}</div>
          <div className="stat-label" title="Завершили / начали">Конверсия</div>
        </div>
        <div className="card">
          <div className="stat">{fmtDuration(medianAll(info.panelCounts))}</div>
          <div className="stat-label" title="Медиана длительности завершённых анкет">Медиана времени</div>
        </div>
      </div>

      {(info.panels.length > 0 || info.panelCounts.some((c) => c.panel !== null)) && (
        <div className="card stack">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>Источники</h2>{!client && <button className="btn-link" onClick={() => onTab('panels')}>панели</button>}</div>
          <SourcesTable info={info} />
        </div>
      )}

      {info.daily.length > 1 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>По дням</h2>
          <DailyChart days={info.daily} />
        </div>
      )}

      {info.quotas.length > 0 && (
        <div className="card stack">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>Квоты</h2>{!client && <button className="btn-link" onClick={() => onTab('quotas')}>изменить</button>}</div>
          <QuotaProgress quotas={info.quotas} />
        </div>
      )}

      {!client && <div className="card stack">
        <h2 style={{ margin: 0 }}>Анкета</h2>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <strong>{info.survey.title}</strong>
          <span className="muted small">{info.survey.published ? `опубликована версия ${info.survey.version}` : 'не опубликована'}</span>
          {info.survey.published && info.survey.unpublished && <span className="badge test">есть неопубликованные правки</span>}
          <span className="grow" />
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/admin/s/${info.survey.id}`)}>Открыть в конструкторе</button>
          <button className="btn btn-secondary btn-sm" onClick={() => window.open(`/s/${info.id}?test=${info.testToken}&new=1`, '_blank')}>Пройти тестово</button>
        </div>
        {!readOnly && (
          info.status === 'collecting'
            ? <p className="muted small" style={{ margin: 0 }}>Во время сбора анкету проекта менять нельзя. Новые версии анкеты подхватываются после публикации.</p>
            : surveys === null
              ? <button className="btn-link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => api<SurveyOption[]>('GET', '/api/admin/surveys').then((l) => setSurveys(l.filter((s) => !s.archived || s.id === info.survey.id)))}>Выбрать другую анкету</button>
              : (
                <label className="field"><span>Анкета проекта</span>
                  <select className="input" value={info.survey.id} onChange={async (e) => {
                    const hasData = Object.values(info.counts.real).some((n) => n > 0);
                    if (hasData && !window.confirm('В проекте уже есть ответы по текущей анкете. Сменить анкету? Старые ответы останутся, но выгрузка и отчёт будут строиться по новой анкете.')) return;
                    try {
                      await api('PUT', `/api/admin/projects/${info.id}`, { surveyId: e.target.value });
                      await reload();
                      setSurveys(null);
                    } catch (err) { toast((err as Error).message); }
                  }}>
                    {surveys.map((s) => <option key={s.id} value={s.id}>{s.title}{s.version ? ` · версия ${s.version}` : ' · не опубликована'}</option>)}
                  </select>
                </label>
              )
        )}
      </div>}
    </div>
  );
}

/** Столбики по дням: завершили (основной цвет) поверх начавших (светлый); подробности — при наведении */
function DailyChart({ days }: { days: DayStat[] }) {
  const max = Math.max(1, ...days.map((d) => d.started));
  const total = days.reduce((a, d) => a + d.completed, 0);
  const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const every = Math.ceil(days.length / 10);
  return (
    <div className="daily">
      <div className="daily-bars" role="img" aria-label={`Завершили за ${days.length} дн.: ${total}`}>
        {days.map((d) => (
          <div key={d.day} className="daily-col"
            title={`${fmtDay(d.day)}: начали ${d.started}, завершили ${d.completed}${d.screenedOut ? `, отсеяны ${d.screenedOut}` : ''}${d.overquota ? `, сверх квоты ${d.overquota}` : ''}`}>
            <div className="daily-started" style={{ height: `${(d.started / max) * 100}%` }} />
            <div className="daily-done" style={{ height: `${(Math.min(d.completed, max) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="daily-axis">
        {days.map((d, i) => <span key={d.day}>{i % every === 0 || i === days.length - 1 ? fmtDay(d.day) : ''}</span>)}
      </div>
      <div className="row small muted" style={{ gap: 14 }}>
        <span><i className="daily-key done" /> завершили</span>
        <span><i className="daily-key started" /> начали</span>
        <span className="grow" />
        <span>Всего завершили: {total}</span>
      </div>
    </div>
  );
}

function QuotaProgress({ quotas }: { quotas: ProjectInfo['quotas'] }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {quotas.map((q) => {
        const pct = q.limit ? Math.min(100, Math.round((q.count / q.limit) * 100)) : 100;
        return (
          <div key={q.id} className="quota-line">
            <span className="quota-name">{q.title || q.id}</span>
            <div className="quota-bar"><div style={{ width: `${pct}%` }} className={q.count >= q.limit ? 'full' : ''} /></div>
            <span className="small">{q.count} / {q.limit}{q.count >= q.limit ? ' ✓' : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Процент a от b: «42%» или «—» */
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const fmtDuration = (sec: number | null) => (sec === null ? '—' : sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин${sec % 60 ? ` ${sec % 60} с` : ''}`);
/** Медиана по всем источникам — приближённо: медианы источников, взвешенные по числу завершённых */
function medianAll(list: PanelCounts[]): number | null {
  const withTime = list.filter((c) => c.medianSec !== null && (c.statuses.completed ?? 0) > 0);
  if (!withTime.length) return null;
  const n = withTime.reduce((a, c) => a + (c.statuses.completed ?? 0), 0);
  return Math.round(withTime.reduce((a, c) => a + c.medianSec! * (c.statuses.completed ?? 0), 0) / n);
}

/** Воронка по источникам: панели проекта, неизвестные коды и прямая ссылка */
function SourcesTable({ info }: { info: ProjectInfo }) {
  const byCode = new Map(info.panelCounts.map((c) => [c.panel, c]));
  const rows: { key: string; name: ReactNode; c: PanelCounts | undefined; limit?: number; closed?: boolean }[] = [
    ...info.panels.map((p) => ({
      key: p.id, name: <>{p.title || p.id} <span className="muted mono small">{p.id}</span></>, c: byCode.get(p.id), limit: p.limit, closed: p.closed,
    })),
    ...info.panelCounts.filter((c) => c.panel !== null && !info.panels.some((p) => p.id === c.panel))
      .map((c) => ({ key: `?${c.panel}`, name: <>{c.panel} <span className="muted small">— нет такой панели</span></>, c })),
  ];
  const direct = byCode.get(null);
  if (direct || info.panels.length === 0) rows.push({ key: '-', name: <span className="muted">Прямая ссылка (без панели)</span>, c: direct });
  const n = (c: PanelCounts | undefined, st: string) => c?.statuses[st] ?? 0;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table sources">
        <thead>
          <tr>
            <th>Источник</th><th>Начали</th><th>Завершили</th><th>Отсеяны</th><th>Сверх квоты</th><th title="В процессе и завершили досрочно">Бросили</th>
            <th title="Завершили / начали">Конверсия</th><th title="Завершили / (завершили + отсеяны)">Инцидентность</th><th title="Медиана длительности завершённых">Время</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, c, limit, closed }) => {
            const started = Object.values(c?.statuses ?? {}).reduce((a, b) => a + b, 0);
            const done = n(c, 'completed');
            return (
              <tr key={key}>
                <td>{name}{closed && <span className="badge status-processing" style={{ marginLeft: 6 }}>стоп</span>}</td>
                <td>{started}</td>
                <td>{done}{limit ? <span className="muted"> / {limit}</span> : null}</td>
                <td>{n(c, 'screened_out')}</td>
                <td>{n(c, 'overquota')}</td>
                <td>{n(c, 'in_progress') + n(c, 'terminated')}</td>
                <td>{pct(done, started)}</td>
                <td>{pct(done, done + n(c, 'screened_out'))}</td>
                <td>{fmtDuration(c?.medianSec ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Панели ----------

const PANEL_REDIRECTS: [keyof Panel, string, string][] = [
  ['redirectComplete', 'Завершил', 'complete'], ['redirectScreenout', 'Отсеян', 'screenout'],
  ['redirectOverquota', 'Сверх квоты', 'overquota'], ['redirectEarlyFinish', 'Вышел досрочно', 'terminate'],
];

/** Ссылка для панели: код панели и ID респондента в виде макроса панели */
export function panelLink(projectId: string, p: Panel): string {
  let url = `${window.location.origin}/s/${projectId}?${PANEL_PARAM}=${encodeURIComponent(p.id)}`;
  if (p.idParam) url += `&${p.idParam}=${p.idMacro || '{ID}'}`;
  return url;
}

function PanelsTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const [panels, setPanels] = useState<Panel[]>(info.panels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(panels) !== JSON.stringify(info.panels);
  const setAt = (i: number, patch: Partial<Panel>) => setPanels(panels.map((p, k) => (k === i ? compact({ ...p, ...patch }) : p)));
  const add = () => {
    const used = new Set(panels.map((p) => p.id));
    let n = panels.length + 1;
    while (used.has(`panel${n}`)) n++;
    setPanels([...panels, { id: `panel${n}`, idParam: 'uid' }]);
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { panels });
      await reload();
      toast('Панели сохранены');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };
  const counts = new Map(info.panelCounts.map((c) => [c.panel, c]));

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Панели</h2>
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={add}>+ Панель</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Панель — источник респондентов: панель-подрядчик, рассылка, соцсеть. У каждой своя ссылка (<code>?panel=код</code>), свой лимит
          и свои адреса возврата по статусам — они важнее редиректов из анкеты. Код панели попадает в данные как <code>url_panel</code>,
          в квотах его можно проверить условием <code>param.panel = "код"</code>.
        </p>
        {error && <div className="error-box">{error}</div>}
        {panels.length === 0 && <p className="muted" style={{ margin: 0 }}>Панелей нет — все приходят по общей ссылке проекта.</p>}
        {panels.map((p, i) => {
          const c = counts.get(p.id);
          const done = c?.statuses.completed ?? 0;
          const started = Object.values(c?.statuses ?? {}).reduce((a, b) => a + b, 0);
          const saved = info.panels.some((x) => x.id === p.id);
          const link = panelLink(info.id, p);
          const redirects = PANEL_REDIRECTS.filter(([k]) => p[k]).length;
          const idRef = `{{param.${p.idParam || 'uid'}}}`;
          return (
            <div key={i} className="quota panel">
              <fieldset className="plain stack" disabled={readOnly} style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input mono" style={{ width: 120 }} value={p.id} title="Код панели в ссылке" aria-label="Код панели"
                    onChange={(e) => setAt(i, { id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
                  <input className="input grow" placeholder="Название, например «Панель А» или «Рассылка по базе»" value={p.title ?? ''} aria-label="Название панели"
                    onChange={(e) => setAt(i, { title: e.target.value || undefined })} />
                  <label className="row" style={{ gap: 6 }} title="Лимит завершённых анкет с панели"><span className="muted small">лимит</span>
                    <input className="input mini" type="number" min={1} placeholder="—" value={p.limit ?? ''} aria-label="Лимит панели"
                      onChange={(e) => setAt(i, { limit: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
                  </label>
                  <label className="check" title="Приём остановлен: новые респонденты с этой панели видят «Опрос закрыт»">
                    <input type="checkbox" checked={!!p.closed} onChange={(e) => setAt(i, { closed: e.target.checked || undefined })} />
                    <span className="small">стоп</span>
                  </label>
                  {!readOnly && (
                    <button className="icon-btn" title="Удалить панель" onClick={() => {
                      if (started && !window.confirm(`С панели «${p.title || p.id}» уже есть анкеты (${started}). Удалить панель? Анкеты останутся в данных.`)) return;
                      setPanels(panels.filter((_, k) => k !== i));
                    }}>✕</button>
                  )}
                </div>
                <div className="grid2">
                  <label className="field"><span>Параметр с ID респондента</span>
                    <input className="input mono" placeholder="не передаётся" value={p.idParam ?? ''}
                      onChange={(e) => setAt(i, { idParam: e.target.value.trim() || undefined })} />
                    <span className="field-help">Один ответ на ID; без ID ссылка не откроется</span>
                  </label>
                  <label className="field"><span>Макрос панели для ID</span>
                    <input className="input mono" placeholder="{ID}" value={p.idMacro ?? ''} disabled={!p.idParam}
                      onChange={(e) => setAt(i, { idMacro: e.target.value.trim() || undefined })} />
                    <span className="field-help">Как панель подставляет ID: [%RID%], {'{uid}'}, ##ID## — попадёт в ссылку</span>
                  </label>
                </div>
              </fieldset>
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono grow" readOnly value={link} aria-label="Ссылка для панели" onFocus={(e) => e.target.select()} />
                <button className="btn btn-secondary btn-sm" disabled={!saved || dirty} title={!saved || dirty ? 'Сначала сохраните панели' : ''}
                  onClick={() => { navigator.clipboard.writeText(link); toast('Ссылка для панели скопирована'); }}>Копировать</button>
              </div>
              <details className="js-details" open={!saved}>
                <summary>Редиректы по статусам{redirects ? ` (${redirects} из 4)` : ' — не заданы, действуют редиректы анкеты'}</summary>
                <fieldset className="plain grid2" disabled={readOnly} style={{ marginTop: 6 }}>
                  {PANEL_REDIRECTS.map(([k, label, slug]) => (
                    <label key={k} className="field"><span>{label}</span>
                      <input className="input mono" placeholder={`https://panel.example/${slug}?id=${idRef}`}
                        value={(p[k] as string) ?? ''} onChange={(e) => setAt(i, { [k]: e.target.value.trim() || undefined })} />
                    </label>
                  ))}
                  <span className="field-help" style={{ gridColumn: '1 / -1' }}>
                    Подстановки: <code>{idRef}</code> — ID респондента у панели, <code>{'{{resp_id}}'}</code> — ID анкеты, <code>{'{{Q1}}'}</code> — ответ на вопрос.
                  </span>
                </fieldset>
              </details>
              {saved && (
                <div className="muted small">
                  Начали {started} · завершили {done}{p.limit ? ` из ${p.limit}` : ''} · отсеяны {c?.statuses.screened_out ?? 0}
                  {' '}· сверх квоты {c?.statuses.overquota ?? 0} · конверсия {pct(done, started)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Квоты ----------

function QuotasTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const [quotas, setQuotas] = useState<Quota[]>(info.quotaDefs);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(quotas) !== JSON.stringify(info.quotaDefs);
  const def = info.published ?? info.draft;
  const setAt = (i: number, patch: Partial<Quota>) => setQuotas(quotas.map((q, k) => (k === i ? compact({ ...q, ...patch }) : q)));
  const add = () => {
    const first = allQuestions(def).find((q) => q.type !== 'info');
    if (!first) return toast('В анкете пока нет вопросов');
    setQuotas([...quotas, { id: nextId(quotas.map((q) => q.id), 'QT'), if: { q: first.id, op: 'answered' }, limit: 100 }]);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { quotas });
      await reload();
      toast('Квоты сохранены');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Квоты</h2>
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={add}>+ Квота</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Счётчик считает завершённые анкеты, подходящие под условие. Когда набрано нужное число, следующие подходящие респонденты
          заканчивают опрос со статусом «Сверх квоты» (сообщение и переход задаются в анкете → Настройки → Завершение). Проверка — после
          каждого ответа, поэтому квотные вопросы ставьте в начало анкеты. Условие может использовать и параметр ссылки: <code>param.src = "vk"</code>.
        </p>
        {quotas.length === 0 && <p className="muted" style={{ margin: 0 }}>Квот нет — принимаются все, кто прошёл анкету.</p>}
        {quotas.map((q, i) => {
          const p = info.quotas.find((x) => x.id === q.id);
          const pct = p && q.limit ? Math.min(100, Math.round((p.count / q.limit) * 100)) : 0;
          return (
            <div key={i} className="quota">
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono" style={{ width: 90 }} value={q.id} title="ID квоты" readOnly={readOnly}
                  onChange={(e) => setAt(i, { id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
                <input className="input grow" placeholder="Название, например «Мужчины 18–34»" value={q.title ?? ''} readOnly={readOnly}
                  onChange={(e) => setAt(i, { title: e.target.value || undefined })} />
                <label className="row" style={{ gap: 6 }}><span className="muted small">нужно</span>
                  <input className="input mini" type="number" min={0} value={q.limit} readOnly={readOnly}
                    onChange={(e) => setAt(i, { limit: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                </label>
                {!readOnly && <button className="icon-btn" title="Удалить квоту" onClick={() => setQuotas(quotas.filter((_, k) => k !== i))}>✕</button>}
              </div>
              <ConditionField def={def} value={q.if} placeholder="условие, например S1 = 1 and S2 in (1, 2)"
                onChange={(c) => c && setAt(i, { if: c })} />
              {p && (
                <div className="quota-progress" title="По опубликованной версии анкеты">
                  <div className="quota-bar"><div style={{ width: `${pct}%` }} className={p.count >= q.limit ? 'full' : ''} /></div>
                  <span className="small">{p.count} из {q.limit}{p.count >= q.limit ? ' — набрана' : ''}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Настройки сбора ----------

/** ISO-время ⇄ значение поля datetime-local (в часовом поясе браузера) */
const toLocal = (iso?: string) => {
  if (!iso || isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);
const posInt = (v: string) => (v ? Math.max(1, Math.round(Number(v))) : undefined);

function CollectionSettings({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const [st, setSt] = useState<ProjectSettings>(info.settings);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(compact(st)) !== JSON.stringify(compact(info.settings));
  const set = (patch: Partial<ProjectSettings>) => setSt(compact({ ...st, ...patch }));
  const done = info.counts.real.completed ?? 0;
  const testLink = `${window.location.origin}/s/${info.id}?test=${info.testToken}`;
  const save = async () => {
    setBusy(true);
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { settings: st });
      await reload();
      toast('Настройки сбора сохранены');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack settings-tab">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Сроки и лимит</h2>
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Действуют, пока проект в статусе «Сбор данных». До начала и после окончания респонденты видят сообщение «Когда опрос закрыт» из анкеты.</p>
        <fieldset className="plain" disabled={readOnly}>
          <div className="grid2">
            <label className="field"><span>Начало сбора</span>
              <input className="input" type="datetime-local" value={toLocal(st.openFrom)} onChange={(e) => set({ openFrom: fromLocal(e.target.value) })} />
            </label>
            <label className="field"><span>Окончание сбора</span>
              <input className="input" type="datetime-local" value={toLocal(st.closeAt)} onChange={(e) => set({ closeAt: fromLocal(e.target.value) })} />
            </label>
            <label className="field"><span>Лимит завершённых анкет</span>
              <input className="input" type="number" min={1} placeholder="без лимита" value={st.maxResponses ?? ''} onChange={(e) => set({ maxResponses: posInt(e.target.value) })} />
              {st.maxResponses ? <span className="field-help">Сейчас завершено: {done} из {st.maxResponses}</span> : null}
            </label>
          </div>
        </fieldset>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Доступ и защита</h2>
        <fieldset className="plain stack" disabled={readOnly}>
          <div className="grid2">
            <label className="field"><span>Пароль на опрос</span>
              <input className="input" placeholder="без пароля" value={st.password ?? ''} onChange={(e) => set({ password: e.target.value || undefined })} />
              <span className="field-help">Респондент вводит его перед началом</span>
            </label>
            <label className="field"><span>Один ответ на параметр ссылки</span>
              <input className="input mono" placeholder="например, pid" value={st.uniqueParam ?? ''} onChange={(e) => set({ uniqueParam: e.target.value.trim() || undefined })} />
              <span className="field-help">Для панелей: ?pid=… Повторно по тому же pid не пустит, начатую анкету продолжит; без параметра опрос не откроется</span>
            </label>
            <label className="field"><span>Новых анкет с одного IP за час</span>
              <input className="input" type="number" min={1} placeholder="без ограничения" value={st.maxStartsPerIpHour ?? ''} onChange={(e) => set({ maxStartsPerIpHour: posInt(e.target.value) })} />
              <span className="field-help">Осторожно с опросами сотрудников: из одного офиса часто один IP</span>
            </label>
            <label className="field"><span>«Спидеры»: быстрее, чем за N секунд</span>
              <input className="input" type="number" min={1} placeholder="не отмечать" value={st.minDurationSec ?? ''} onChange={(e) => set({ minDurationSec: posInt(e.target.value) })} />
              <span className="field-help">Такие анкеты помечаются в «Данных» и переменной speeder в выгрузке</span>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!st.allowRetake} onChange={(e) => set({ allowRetake: e.target.checked || undefined })} />
            <span>Разрешить пройти опрос повторно<small className="muted"> — на финальном экране появится кнопка «Пройти ещё раз»</small></span>
          </label>
        </fieldset>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Ссылки</h2>
        <div className="field">
          <span>Ссылка для респондентов</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={`${window.location.origin}/s/${info.id}`} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/s/${info.id}`); toast('Ссылка скопирована'); }}>Копировать</button>
          </div>
        </div>
        <div className="field">
          <span>Тестовая ссылка — черновик анкеты без входа в админку, ответы помечаются как тестовые</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={testLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(testLink); toast('Тестовая ссылка скопирована'); }}>Копировать</button>
          </div>
        </div>
        <EmbedCode id={info.id} />
      </div>
    </div>
  );
}

/** Код для вставки опроса на сайт: iframe подстраивает высоту под содержимое */
function EmbedCode({ id }: { id: string }) {
  const url = `${window.location.origin}/s/${id}`;
  const code = `<iframe id="surveylab-${id}" src="${url}" style="width:100%;border:0;min-height:480px" title="Опрос"></iframe>
<script>addEventListener('message',function(e){if(e.data&&e.data.type==='surveylab:height'){var f=document.getElementById('surveylab-${id}');if(f&&e.source===f.contentWindow)f.style.height=e.data.height+'px';}});</script>`;
  return (
    <details className="field embed-code">
      <summary>Код для вставки на сайт</summary>
      <textarea className="input mono" rows={4} readOnly value={code} onFocus={(e) => e.target.select()} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(code); toast('Код скопирован'); }}>Копировать код</button>
        <span className="muted small">Параметры ссылки (?pid=…, utm) можно добавить к адресу в src.</span>
      </div>
    </details>
  );
}
