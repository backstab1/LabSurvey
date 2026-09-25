import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { canEdit, navigate, useMe } from './AdminApp.tsx';
import { TEMPLATES, type Template } from './templates.ts';
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
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const me = useMe();
  const editable = canEdit(me);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Row['status'] | 'archived'>('all');

  const load = () => api<Row[]>('GET', '/api/admin/surveys').then(setRows);
  useEffect(() => { load(); }, []);

  const createFrom = async (t: Template) => {
    const r = await api('POST', '/api/admin/surveys', t.survey ? { definition: t.survey } : {});
    navigate(`/admin/s/${r.id}`);
  };

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 24 }}>Анкеты</h1>
        {me.role === 'admin' && <button className="btn btn-secondary" onClick={() => setBackupsOpen(true)}>Резервные копии</button>}
        {editable && <button className="btn btn-secondary" onClick={() => setImportOpen(true)}>Импорт JSON</button>}
        {editable && <button className="btn btn-primary" onClick={() => setNewOpen(true)}>+ Новая анкета</button>}
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
              <tr><th>Название</th><th>Статус</th><th>Завершили</th><th className="wide-only">Начали</th><th className="wide-only">Изменена</th><th /></tr>
            </thead>
            <tbody>
              {rows.filter((r) => (status === 'archived' ? r.archived : !r.archived && (status === 'all' || r.status === status))
                && r.title.toLowerCase().includes(query.trim().toLowerCase())).map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/s/${r.id}`)}>
                  <td><strong>{r.title}</strong><div className="muted" style={{ fontSize: 13 }}>/s/{r.id}{r.version ? ` · версия ${r.version}` : ''}</div></td>
                  <td>{r.archived ? <span className="badge">В архиве</span> : <span className={`badge ${r.status}`}>{STATUS_TEXT[r.status]}</span>}</td>
                  <td>{r.counts.completed ?? 0}</td>
                  <td className="wide-only">{Object.values(r.counts).reduce((a, b) => a + b, 0)}</td>
                  <td className="muted wide-only">{new Date(r.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ width: 40 }}>
                    <Menu items={[
                      { label: 'Открыть', onClick: () => navigate(`/admin/s/${r.id}`) },
                      { label: 'Предпросмотр', onClick: () => window.open(`/s/${r.id}?preview=1&new=1`, '_blank') },
                      editable && { label: 'Дублировать', onClick: async () => { await api('POST', `/api/admin/surveys/${r.id}/duplicate`); load(); } },
                      editable && { label: r.archived ? 'Вернуть из архива' : 'В архив', onClick: async () => { await api('POST', `/api/admin/surveys/${r.id}/archive`, { archived: !r.archived }); load(); } },
                      editable && {
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
      {backupsOpen && <BackupsModal onClose={() => setBackupsOpen(false)} />}
      {newOpen && (
        <Modal onClose={() => setNewOpen(false)} title="Новая анкета">
          <div className="template-grid">
            {TEMPLATES.map((t) => (
              <button key={t.id} className="template-card" onClick={() => createFrom(t)}>
                <strong>{t.title}</strong>
                <span className="muted small">{t.description}</span>
              </button>
            ))}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Есть анкета в Word или PDF? Кнопка «Импорт JSON» и инструкция для ИИ на вкладке JSON.</p>
        </Modal>
      )}
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

interface Backups { list: { name: string; size: number; createdAt: string }[]; everyHours: number; keep: number }

/** Копии базы: делаются по расписанию на сервере, здесь — список, скачать, сделать сейчас */
function BackupsModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Backups | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<Backups>('GET', '/api/admin/backups').then(setData);
  useEffect(() => { load(); }, []);
  const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.ceil(b / 1024)} КБ`);
  return (
    <Modal onClose={onClose} title="Резервные копии базы">
      <div className="stack">
        {data && (
          <p className="muted small" style={{ margin: 0 }}>
            {data.everyHours > 0
              ? `Копия делается автоматически каждые ${data.everyHours} ч, хранятся последние ${data.keep}.`
              : 'Автоматические копии выключены (BACKUP_HOURS=0 в .env).'}
            {' '}Копия — полный файл базы SQLite: все анкеты и ответы. Для восстановления остановите сервис и замените им data/surveylab.db.
          </p>
        )}
        {!data ? <p className="muted">Загрузка…</p> : data.list.length === 0 ? <p className="muted">Копий пока нет.</p> : (
          <table className="table">
            <tbody>
              {data.list.map((b) => (
                <tr key={b.name}>
                  <td className="mono small">{b.name}</td>
                  <td className="muted">{new Date(b.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="muted">{size(b.size)}</td>
                  <td style={{ textAlign: 'right' }}><a className="btn-link" href={`/api/admin/backups/${b.name}`}>Скачать</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api('POST', '/api/admin/backups'); await load(); } finally { setBusy(false); }
          }}>Сделать копию сейчас</button>
        </div>
      </div>
    </Modal>
  );
}
