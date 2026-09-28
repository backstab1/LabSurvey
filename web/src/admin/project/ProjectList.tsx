// Список проектов, создание и копирование проекта
import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { canEdit, navigate, useMe } from '../AdminApp.tsx';
import { Menu, Modal, copyText, toast } from '../common.tsx';
import { fmtDate } from './format.ts';
import { PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../../shared/types.ts';
import type { ProjectListItem, SurveyListItem } from '../../../../shared/api.ts';

export /** Копия проекта для новой волны: спрашивает название и открывает копию */
async function copyProject(id: string, title: string) {
  const name = window.prompt('Название копии. Скопируются анкета, настройки сбора, квоты и панели – без ответов, Google Sheets и уведомлений.', `${title} (копия)`);
  if (name === null) return;
  try {
    const r = await api<{ id: string }>('POST', `/api/admin/projects/${id}/copy`, { title: name });
    navigate(`/admin/p/${r.id}`);
    toast('Проект скопирован');
  } catch (e) { toast((e as Error).message); }
}

export function ProjectList() {
  const { data: rows } = useApi<ProjectListItem[]>('/api/admin/projects');
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'active' | ProjectStatus>('active');
  const editable = canEdit(useMe());

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
            <p className="muted" style={{ marginTop: 0 }}>Проектов пока нет. Проект – это запуск анкеты: статус сбора, сроки, квоты, данные и отчёты.</p>
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
                  <td className="wide-only">{r.quotas ? <>{r.quotasFull} из {r.quotas} набрано</> : <span className="muted">–</span>}</td>
                  <td className="wide-only muted small">
                    {r.openFrom || r.closeAt ? <>{r.openFrom ? `с ${fmtDate(r.openFrom)}` : ''} {r.closeAt ? `до ${fmtDate(r.closeAt)}` : ''}</> : '–'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()} style={{ width: 40 }}>
                    <Menu items={[
                      { label: 'Открыть', onClick: () => navigate(`/admin/p/${r.id}`) },
                      { label: 'Скопировать ссылку', onClick: () => copyText(`${window.location.origin}/s/${r.id}`) },
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

export function NewProjectModal({ onClose, surveyId }: { onClose: () => void; surveyId?: string }) {
  const list = useApi<SurveyListItem[]>('/api/admin/surveys').data?.filter((s) => !s.archived);
  const [form, setForm] = useState({ title: '', surveyId: surveyId ?? '' });
  const [error, setError] = useState('');
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
            <option value="">– выберите анкету –</option>
            {list?.map((s) => <option key={s.id} value={s.id}>{s.title}{s.version ? ` · версия ${s.version}` : ' · не опубликована'}</option>)}
          </select>
          {picked && !picked.version && <span className="field-help">Анкету нужно опубликовать до начала сбора – сейчас можно тестировать черновик.</span>}
        </label>
        <label className="field"><span>Название проекта</span>
          <input className="input" value={form.title} placeholder={picked ? picked.title : 'Например: Кофейни – волна 1, панель А'}
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
