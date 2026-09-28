// Страница проекта: шапка, вкладки
import { useEffect, useState } from 'react';
import { api, useApi } from '../../api.ts';
import { canEdit, isClient, navigate, useMe } from '../AdminApp.tsx';
import { Menu, confirmLeave, copyText, toast } from '../common.tsx';
import { copyProject } from './ProjectList.tsx';
import { Overview } from './Overview.tsx';
import { PanelsTab } from './PanelsTab.tsx';
import { QuotasTab } from './QuotasTab.tsx';
import { CollectionSettings } from './CollectionSettings.tsx';
import { DataTab } from './DataTab.tsx';
import { ReportTab } from './ReportTab.tsx';
import { InviteesTab } from './InviteesTab.tsx';
import { TablesTab } from './TablesTab.tsx';
import { PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

export type Tab = 'overview' | 'panels' | 'invitees' | 'quotas' | 'data' | 'report' | 'tables' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Сводка'], ['panels', 'Панели'], ['invitees', 'Список'], ['quotas', 'Квоты'], ['data', 'Данные'], ['report', 'Отчёт'], ['tables', 'Таблицы'], ['settings', 'Настройки сбора'],
];
/** Заказчику — только результаты */
const CLIENT_TABS: Tab[] = ['overview', 'report', 'tables', 'data'];

export function ProjectPage({ id }: { id: string }) {
  const { data: info, error, reload } = useApi<ProjectInfo>(`/api/admin/projects/${id}`);
  const me = useMe();
  const client = isClient(me);
  const tabs = client ? TABS.filter(([t]) => CLIENT_TABS.includes(t)) : TABS;
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab;
    return tabs.some(([x]) => x === t) ? t : 'overview';
  });
  const [title, setTitle] = useState('');
  const readOnly = !canEdit(me);

  // Название в поле — с сервера при открытии и после сохранения
  const savedTitle = info?.title;
  useEffect(() => { if (savedTitle !== undefined) setTitle(savedTitle); }, [savedTitle]);

  const docTitle = info?.title;
  useEffect(() => {
    document.title = docTitle ? `${docTitle} – SurveyLAB` : 'SurveyLAB';
    return () => { document.title = 'SurveyLAB'; };
  }, [docTitle]);

  if (error) return <div className="container"><div className="error-box">{error}</div></div>;
  if (!info) return <div className="container muted">Загрузка…</div>;

  const link = `${window.location.origin}/s/${id}`;
  const changeTab = (t: Tab) => {
    if (t === tab || !confirmLeave()) return;
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  const saveTitle = async () => {
    if (title.trim() === info.title) return;
    if (!title.trim()) { setTitle(info.title); return; }
    try {
      await api('PUT', `/api/admin/projects/${id}`, { title: title.trim() });
      await reload();
    } catch (e) { toast((e as Error).message); setTitle(info.title); }
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
          { label: 'Скопировать ссылку для респондентов', onClick: () => copyText(link) },
          { label: 'Скопировать тестовую ссылку', onClick: () => copyText(`${link}?test=${info.testToken}`, 'Тестовая ссылка скопирована: черновик анкеты, ответы тестовые') },
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
              {t === 'invitees' && info.invitees > 0 && <span className="tab-count">{info.invitees}</span>}
            </button>
          ))}
        </div>
        {!client && (
          <button className="link-chip url" title="Скопировать ссылку" onClick={() => copyText(link)}>
            🔗 {link.replace(/^https?:\/\//, '')}
          </button>
        )}
      </div>

      {tab === 'overview' && <Overview info={info} readOnly={readOnly} client={client} setStatus={setStatus} reload={reload} onTab={changeTab} />}
      {tab === 'panels' && <PanelsTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'invitees' && <InviteesTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'quotas' && <QuotasTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'data' && <DataTab info={info} reload={reload} />}
      {tab === 'report' && <ReportTab info={info} readOnly={readOnly} client={client} reload={reload} />}
      {tab === 'tables' && <TablesTab info={info} readOnly={readOnly} reload={reload} />}
      {tab === 'settings' && <CollectionSettings info={info} readOnly={readOnly} reload={reload} />}
    </div>
  );
}
