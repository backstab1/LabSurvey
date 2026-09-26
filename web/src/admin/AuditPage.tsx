import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { navigate } from './AdminApp.tsx';
import { toast } from './common.tsx';

interface Entry {
  id: number; at: string; login: string | null; via: 'ui' | 'ai'; action: string;
  targetType: string | null; targetId: string | null; targetTitle: string | null; details: Record<string, unknown> | null; ip: string | null;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
const TYPE_LABELS: Record<string, string> = { survey: 'Анкета', project: 'Проект', user: 'Пользователь' };
const DETAIL_LABELS: Record<string, string> = {
  version: 'версия', role: 'роль', disabled: 'отключён', password: 'пароль', projects: 'проектов', statuses: 'статусы', test: 'тестовые',
  panel: 'панель', period: 'период', from: 'из', deleted: 'удалено', count: 'анкет', response: 'ответ', status: 'статус', app: 'приложение',
  survey: 'анкета', file: 'файл',
};

function detailsText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  return Object.entries(d).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${DETAIL_LABELS[k] ?? k}: ${v === true ? 'да' : v === false ? 'нет' : String(v)}`).join(' · ');
}

/** Журнал действий команды (только администратор) */
export function AuditPage() {
  const init = new URLSearchParams(window.location.search);
  const [f, setF] = useState({
    login: init.get('login') ?? '', via: init.get('via') ?? '', q: init.get('q') ?? '', from: '', to: '',
    targetType: init.get('targetType') ?? '', targetId: init.get('targetId') ?? '',
  });
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [logins, setLogins] = useState<string[]>([]);
  const [more, setMore] = useState(false);

  const query = (before?: number) => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    if (before) q.set('before', String(before));
    return api<{ entries: Entry[]; logins: string[] }>('GET', `/api/admin/audit?${q}`);
  };
  useEffect(() => {
    const t = setTimeout(() => {
      query().then((r) => { setEntries(r.entries); setLogins(r.logins); setMore(r.entries.length === 100); }).catch((e) => toast((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(f)]);

  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const open = (e: Entry) => {
    if (e.targetType === 'project' && e.targetId) navigate(`/admin/p/${e.targetId}`);
    else if (e.targetType === 'survey' && e.targetId) navigate(`/admin/s/${e.targetId}`);
  };

  return (
    <div className="container">
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 24 }}>Журнал действий</h1>
      </div>
      <div className="row list-filters" style={{ flexWrap: 'wrap' }}>
        <input className="input" type="search" placeholder="Поиск: действие, объект, логин…" value={f.q} onChange={(e) => set({ q: e.target.value })} />
        <select className="input" style={{ width: 'auto' }} value={f.login} aria-label="Пользователь" onChange={(e) => set({ login: e.target.value })}>
          <option value="">все пользователи</option>
          {logins.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={f.via} aria-label="Источник" onChange={(e) => set({ via: e.target.value })}>
          <option value="">интерфейс и ИИ</option>
          <option value="ui">только интерфейс</option>
          <option value="ai">только ИИ-коннектор</option>
        </select>
        <label className="row" style={{ gap: 6 }}><span className="muted small">с</span>
          <input className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="row" style={{ gap: 6 }}><span className="muted small">по</span>
          <input className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
      </div>
      {f.targetId && (
        <div className="row small" style={{ marginBottom: 10, gap: 8 }}>
          <span className="badge">{TYPE_LABELS[f.targetType] ?? f.targetType}: {entries?.find((e) => e.targetId === f.targetId)?.targetTitle ?? f.targetId}</span>
          <button className="btn-link" onClick={() => set({ targetType: '', targetId: '' })}>показать всё</button>
        </div>
      )}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {entries === null ? <p className="muted" style={{ padding: 20 }}>Загрузка…</p> : entries.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>Записей нет.</p>
        ) : (
          <table className="table audit-table">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th className="wide-only">Подробности</th><th className="wide-only">IP</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmt(e.at)}</td>
                  <td>
                    {e.login ? <button className="btn-link" style={{ padding: 0 }} onClick={() => set({ login: e.login! })}>{e.login}</button> : <span className="muted">—</span>}
                    {e.via === 'ai' && <span className="badge ai" title={`Через ИИ-коннектор${e.details?.app ? `: ${e.details.app}` : ''}`}>ИИ</span>}
                  </td>
                  <td>{e.action}</td>
                  <td>
                    {e.targetId ? (
                      <>
                        {(e.targetType === 'project' || e.targetType === 'survey')
                          ? <button className="btn-link" style={{ padding: 0, textAlign: 'left' }} onClick={() => open(e)}>{e.targetTitle || e.targetId}</button>
                          : <span>{e.targetTitle || e.targetId}</span>}
                        <div className="muted small">
                          {TYPE_LABELS[e.targetType ?? ''] ?? e.targetType}
                          {' · '}<button className="btn-link small" style={{ padding: 0 }} onClick={() => set({ targetType: e.targetType ?? '', targetId: e.targetId ?? '' })}>история</button>
                        </div>
                      </>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="wide-only muted small">{detailsText(e.details)}</td>
                  <td className="wide-only muted small mono">{e.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {more && entries && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn btn-secondary btn-sm" onClick={async () => {
            const r = await query(entries[entries.length - 1].id);
            setEntries([...entries, ...r.entries]);
            setMore(r.entries.length === 100);
          }}>Показать ещё</button>
        </div>
      )}
      <p className="muted small">Журнал хранится год. Автосохранения черновика склеиваются: одна запись на человека и анкету за полчаса.</p>
    </div>
  );
}
