import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Modal, toast } from './common.tsx';
import type { ProjectInfo } from './ProjectPage.tsx';
import { STATUS_LABELS, type ResponseStatus } from '../../../shared/variables.ts';
import { INVITE_PARAM } from '../../../shared/types.ts';
import { paramName, parseTable } from '../../../shared/tableImport.ts';

interface Invitee {
  id: number; token: string; extId: string | null; fields: Record<string, string>;
  responseId: string | null; openedAt: string | null; status: ResponseStatus | null; rejected: boolean; completedAt: string | null;
}

type State = 'none' | 'started' | ResponseStatus;
const stateOf = (p: Invitee): State => (!p.responseId ? 'none' : p.status === 'in_progress' || !p.status ? 'started' : p.status);
const STATE_LABELS: Record<State, string> = {
  none: 'Не открывал', started: 'Начал', in_progress: 'Начал', completed: 'Завершил', screened_out: 'Отсеян', terminated: 'Вышел досрочно', overquota: 'Сверх квоты',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');

const ID_HEADERS = /^(id|ид|код|номер|таб\.?\s*номер|табельный.*|external_?id|user_?id|uid|pid)$/i;

function ImportModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [idCol, setIdCol] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const table = useMemo(() => parseTable(text), [text]);
  const headers = table[0] ?? [];
  const names = useMemo(() => { const used = new Set<string>(); return headers.map((h) => paramName(h, used)); }, [headers.join('\u0000')]);
  const guessedId = headers.findIndex((h) => ID_HEADERS.test(h.trim()));
  const idIndex = idCol ?? (guessedId >= 0 ? guessedId : -1);
  const people = table.slice(1).map((r) => ({
    extId: idIndex >= 0 ? (r[idIndex] ?? '').trim() || null : null,
    fields: Object.fromEntries(names.map((n, i) => [n, (r[i] ?? '').trim()]).filter(([, v], i) => i !== idIndex && v)),
  }));

  return (
    <Modal onClose={onClose} title="Добавить людей" wide actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
      <button className="btn btn-primary" disabled={!people.length || busy} onClick={async () => {
        setBusy(true);
        setError('');
        try {
          const r = await api<{ added: number; skipped: number }>('POST', `/api/admin/projects/${projectId}/invitees`, { people });
          toast(`Добавлено: ${r.added}${r.skipped ? `, пропущено повторов: ${r.skipped}` : ''}`);
          onDone();
        } catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось добавить'); } finally { setBusy(false); }
      }}>{people.length ? `Добавить ${people.length}` : 'Добавить'}</button>
    </>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          Скопируйте таблицу из Excel вместе с заголовками и вставьте сюда — или выберите файл CSV. Каждая строка — человек, у него будет своя ссылка.
          Столбцы (имя, отдел, e-mail…) станут параметрами ответа: их можно подставить в текст (<code>{'{{param.name}}'}</code>), использовать в квотах и условиях, они попадут в выгрузку.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <label className="btn btn-secondary btn-sm">Выбрать CSV
            <input type="file" accept=".csv,.txt,.tsv,text/csv" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
              e.target.value = '';
            }} />
          </label>
          {table.length > 1 && <span className="muted small">Строк: {table.length - 1}, столбцов: {headers.length}</span>}
        </div>
        <textarea className="input mono" rows={8} value={text} placeholder={'ID\tИмя\tОтдел\n1024\tАнна\tПродажи\n1025\tИван\tIT'}
          onChange={(e) => { setText(e.target.value); setIdCol(null); }} />
        {headers.length > 0 && (
          <>
            <label className="field"><span>Столбец с ID человека</span>
              <select className="input" style={{ width: 'auto' }} value={idIndex} onChange={(e) => setIdCol(Number(e.target.value))}>
                <option value={-1}>нет ID — только ссылки</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `столбец ${i + 1}`}</option>)}
              </select>
              <span className="field-help">По ID не добавятся повторы; в выгрузке — переменная url_inv_id</span>
            </label>
            <div style={{ overflowX: 'auto' }}>
              <table className="table small">
                <thead><tr>{headers.map((h, i) => (
                  <th key={i}>{h}<div className="muted mono" style={{ fontWeight: 400 }}>{i === idIndex ? 'inv_id' : `param.${names[i]}`}</div></th>
                ))}</tr></thead>
                <tbody>
                  {table.slice(1, 6).map((r, k) => <tr key={k}>{headers.map((_, i) => <td key={i}>{r[i]}</td>)}</tr>)}
                </tbody>
              </table>
              {table.length > 6 && <p className="muted small">…и ещё {table.length - 6}</p>}
            </div>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </Modal>
  );
}

// ---------- Вкладка ----------

export function InviteesTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const [list, setList] = useState<Invitee[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<'all' | State>('all');
  const [q, setQ] = useState('');
  const load = () => api<Invitee[]>('GET', `/api/admin/projects/${info.id}/invitees`).then(setList).catch((e) => toast((e as Error).message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [info.id]);

  const linkOf = (p: Invitee) => `${window.location.origin}/s/${info.id}?${INVITE_PARAM}=${p.token}`;
  const columns = useMemo(() => [...new Set((list ?? []).flatMap((p) => Object.keys(p.fields)))], [list]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of list ?? []) c[stateOf(p)] = (c[stateOf(p)] ?? 0) + 1;
    return c;
  }, [list]);
  const shown = (list ?? []).filter((p) => (filter === 'all' || stateOf(p) === filter)
    && (!q.trim() || `${p.extId ?? ''} ${Object.values(p.fields).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase())));

  const setInviteOnly = async (v: boolean) => {
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { settings: { ...info.settings, inviteOnly: v || undefined } });
      await reload();
      toast(v ? 'Общая ссылка отключена — только персональные' : 'Общая ссылка снова работает');
    } catch (e) { toast((e as Error).message); }
  };

  const downloadCsv = () => {
    const esc = (x: string) => (/[;"\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
    const head = ['id', ...columns, 'link', 'status', 'completed_at'];
    const rows = (list ?? []).map((p) => [p.extId ?? '', ...columns.map((c) => p.fields[c] ?? ''), linkOf(p), STATE_LABELS[stateOf(p)], p.completedAt ?? '']);
    const csv = '﻿' + [head, ...rows].map((r) => r.map((x) => esc(String(x))).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${info.title.slice(0, 60)} — ссылки.csv`;
    a.click();
  };

  const total = list?.length ?? 0;
  const done = counts.completed ?? 0;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Персональные ссылки</h2>
          {total > 0 && <button className="btn btn-secondary btn-sm" onClick={downloadCsv}>Скачать ссылки (CSV)</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>+ Добавить людей</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          У каждого человека из списка — своя ссылка: пройти по ней можно один раз, начатую анкету — продолжить с любого устройства.
          Разошлите ссылки сами (почтой, в мессенджере) — файл CSV подходит для рассылки слиянием.
        </p>
        {!readOnly && (
          <label className="check">
            <input type="checkbox" checked={!!info.settings.inviteOnly} onChange={(e) => setInviteOnly(e.target.checked)} />
            <span>Только по персональным ссылкам<small className="muted"> — общая ссылка проекта перестанет работать</small></span>
          </label>
        )}
        {total > 0 && (
          <div className="stats">
            <div className="card"><div className="stat">{total}</div><div className="stat-label">В списке</div></div>
            <div className="card"><div className="stat">{counts.none ?? 0}</div><div className="stat-label">Не открывали</div></div>
            <div className="card"><div className="stat">{counts.started ?? 0}</div><div className="stat-label">Начали</div></div>
            <div className="card">
              <div className="stat">{done}<span className="muted" style={{ fontSize: 16 }}> · {Math.round((done / total) * 100)}%</span></div>
              <div className="stat-label">Завершили</div>
            </div>
            {(counts.screened_out ?? 0) + (counts.overquota ?? 0) + (counts.terminated ?? 0) > 0 && (
              <div className="card"><div className="stat">{(counts.screened_out ?? 0) + (counts.overquota ?? 0) + (counts.terminated ?? 0)}</div><div className="stat-label">Отсеяны / вышли</div></div>
            )}
          </div>
        )}
      </div>

      {list === null ? <p className="muted">Загрузка…</p> : total === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Список пуст. Добавьте людей — вставкой из Excel или файлом CSV.</p></div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="row list-filters" style={{ padding: '12px 12px 0' }}>
            <input className="input" type="search" placeholder="Поиск по ID и столбцам…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={filter} aria-label="Статус" onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">все ({total})</option>
              {(['none', 'started', 'completed', 'screened_out', 'overquota', 'terminated'] as State[]).filter((s) => counts[s])
                .map((s) => <option key={s} value={s}>{STATE_LABELS[s]} ({counts[s]})</option>)}
            </select>
            <span className="grow" />
            {!readOnly && (
              <button className="btn-link small" style={{ color: 'var(--danger)' }} onClick={async () => {
                if (!window.confirm(`Удалить весь список (${total})? Ссылки перестанут работать, ответы останутся.`)) return;
                await api('POST', `/api/admin/projects/${info.id}/invitees/delete`, { all: true });
                load();
              }}>очистить список</button>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>ID</th>{columns.slice(0, 3).map((c) => <th key={c} className="mono">{c}</th>)}<th>Статус</th><th className="wide-only">Когда</th><th /></tr></thead>
              <tbody>
                {shown.slice(0, 500).map((p) => {
                  const st = stateOf(p);
                  return (
                    <tr key={p.id} className={p.rejected ? 'muted' : ''}>
                      <td className="mono small">{p.extId ?? <span className="muted">—</span>}</td>
                      {columns.slice(0, 3).map((c) => <td key={c}>{p.fields[c] ?? ''}</td>)}
                      <td><span className={`badge inv-${st}`}>{STATE_LABELS[st]}</span>{p.rejected && <span className="badge closed">брак</span>}</td>
                      <td className="wide-only muted small">{fmt(p.completedAt ?? p.openedAt)}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button className="btn-link small" onClick={() => { navigator.clipboard.writeText(linkOf(p)); toast('Ссылка скопирована'); }}>ссылка</button>
                        {!readOnly && (
                          <>
                            <button className="btn-link small" title="Старая ссылка перестанет работать" onClick={async () => {
                              if (!window.confirm('Выдать новую ссылку? Старая перестанет работать.')) return;
                              await api('POST', `/api/admin/projects/${info.id}/invitees/${p.id}/reissue`);
                              await load();
                              toast('Новая ссылка готова — скопируйте её');
                            }}>новая</button>
                            <button className="btn-link small" style={{ color: 'var(--danger)' }} onClick={async () => {
                              if (!window.confirm('Удалить человека из списка? Его ссылка перестанет работать, ответ останется.')) return;
                              await api('POST', `/api/admin/projects/${info.id}/invitees/delete`, { ids: [p.id] });
                              load();
                            }}>удалить</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length > 500 && <p className="muted small" style={{ padding: '0 12px' }}>Показаны первые 500 из {shown.length} — уточните поиск. В CSV — весь список.</p>}
          </div>
        </div>
      )}
      {adding && <ImportModal projectId={info.id} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); reload(); }} />}
    </div>
  );
}
