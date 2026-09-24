import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { navigate } from './AdminApp.tsx';
import { IssuesList } from './common.tsx';
import type { Issue } from '../../../shared/validate.ts';

interface Row {
  id: string;
  title: string;
  status: 'draft' | 'active' | 'closed';
  version: number;
  updatedAt: string;
  counts: Record<string, number>;
}

export const STATUS_TEXT = { draft: 'Черновик', active: 'Идёт сбор', closed: 'Закрыт' } as const;

export function SurveyList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => { api<Row[]>('GET', '/api/admin/surveys').then(setRows); }, []);

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
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows === null ? <p className="muted" style={{ padding: 20 }}>Загрузка…</p> : rows.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>Анкет пока нет. Создайте новую или импортируйте JSON.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Название</th><th>Статус</th><th>Завершили</th><th>Всего начали</th><th>Изменена</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/s/${r.id}`)}>
                  <td><strong>{r.title}</strong><div className="muted" style={{ fontSize: 13 }}>/s/{r.id}{r.version ? ` · версия ${r.version}` : ''}</div></td>
                  <td><span className={`badge ${r.status}`}>{STATUS_TEXT[r.status]}</span></td>
                  <td>{r.counts.completed ?? 0}</td>
                  <td>{Object.values(r.counts).reduce((a, b) => a + b, 0)}</td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stack" onClick={(e) => e.stopPropagation()}>
        <h2>Импорт анкеты из JSON</h2>
        <p className="muted" style={{ margin: 0 }}>Вставьте JSON или выберите файл. Формат описан в docs/survey-format.md.</p>
        <input type="file" accept=".json,application/json" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }} />
        <textarea className="json-editor" style={{ minHeight: 300 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"formatVersion": 1, "title": "...", "pages": [...]}' />
        {error && <div className="error-box">{error}</div>}
        {issues.length > 0 && <div className="error-box"><IssuesList issues={issues} /></div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={submit}>Импортировать</button>
        </div>
      </div>
    </div>
  );
}
