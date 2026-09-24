import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { navigate } from './AdminApp.tsx';
import { IssuesList, Menu, Modal } from './common.tsx';
import type { Issue } from '../../../shared/validate.ts';

interface Row {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'closed';
  version: number;
  archived: boolean;
  updatedAt: string;
  counts: Record<string, number>;
}

export const STATUS_TEXT = { draft: 'Черновик', active: 'Идёт сбор', closed: 'Закрыт' } as const;

export function SurveyList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Row['status'] | 'archived'>('all');

  const load = () => api<Row[]>('GET', '/api/admin/surveys').then(setRows);
  useEffect(() => { load(); }, []);

  const createBlank = async () => {
    const r = await api('POST', '/api/admin/surveys', {});
    navigate(`/admin/s/${r.id}`);
  };

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 24 }}>Анкеты</h1>
        <button className="btn btn-secondary" onClick={() => setImportOpen(true)}>Импорт JSON</button>
        <button className="btn btn-primary" onClick={createBlank}>+ Новая анкета</button>
      </div>
      {rows && (rows.length > 3 || rows.some((r) => r.archived)) && (
        <div className="row list-filters">
          <input className="input" type="search" placeholder="Поиск по названию…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Все статусы</option>
            <option value="active">Идёт сбор</option>
            <option value="draft">Черновики</option>
            <option value="closed">Закрытые</option>
            <option value="archived">Архив ({rows.filter((r) => r.archived).length})</option>
          </select>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows === null ? <p className="muted" style={{ padding: 20 }}>Загрузка…</p> : rows.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>Анкет пока нет. Создайте новую или импортируйте JSON.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Название</th><th>Статус</th><th>Завершили</th><th>Начали</th><th>Изменена</th><th /></tr>
            </thead>
            <tbody>
              {rows.filter((r) => (status === 'archived' ? r.archived : !r.archived && (status === 'all' || r.status === status))
                && r.title.toLowerCase().includes(query.trim().toLowerCase())).map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/s/${r.id}`)}>
                  <td><strong>{r.title}</strong><div className="muted" style={{ fontSize: 13 }}>/s/{r.id}{r.version ? ` · версия ${r.version}` : ''}</div></td>
                  <td>{r.archived ? <span className="badge">В архиве</span> : <span className={`badge ${r.status}`}>{STATUS_TEXT[r.status]}</span>}</td>
                  <td>{r.counts.completed ?? 0}</td>
                  <td>{Object.values(r.counts).reduce((a, b) => a + b, 0)}</td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ width: 40 }}>
                    <Menu items={[
                      { label: 'Открыть', onClick: () => navigate(`/admin/s/${r.id}`) },
                      { label: 'Предпросмотр', onClick: () => window.open(`/s/${r.id}?preview=1&new=1`, '_blank') },
                      { label: 'Дублировать', onClick: async () => { await api('POST', `/api/admin/surveys/${r.id}/duplicate`); load(); } },
                      { label: r.archived ? 'Вернуть из архива' : 'В архив', onClick: async () => { await api('POST', `/api/admin/surveys/${r.id}/archive`, { archived: !r.archived }); load(); } },
                      {
                        label: 'Удалить', danger: true, onClick: async () => {
                          const n = Object.values(r.counts).reduce((a, b) => a + b, 0);
                          if (!window.confirm(`Удалить «${r.title}»${n ? ` и ${n} ответов` : ''}? Это нельзя отменить.`)) return;
                          await api('DELETE', `/api/admin/surveys/${r.id}`);
                          load();
                        },
                      },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]);

  const submit = async () => {
    setError(''); setIssues([]);
    let def: unknown;
    try { def = JSON.parse(text); } catch (e) { return setError(`JSON не читается: ${(e as Error).message}`); }
    try {
      const r = await api('POST', '/api/admin/surveys', { definition: def });
      navigate(`/admin/s/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.data?.errors) setIssues(e.data.errors);
      else setError((e as Error).message);
    }
  };

  return (
    <Modal onClose={onClose} title="Импорт анкеты из JSON">
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Вставьте JSON или выберите файл. Формат — вкладка JSON → «Скопировать инструкцию для ИИ».</p>
        <input type="file" accept=".json,application/json" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }} />
        <textarea className="json-editor" style={{ minHeight: 300 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"formatVersion": 2, "title": "...", "blocks": [...]}' />
        {error && <div className="error-box">{error}</div>}
        {issues.length > 0 && <div className="error-box"><IssuesList issues={issues} /></div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={submit}>Импортировать</button>
        </div>
      </div>
    </Modal>
  );
}
