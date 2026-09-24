import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { toast } from './common.tsx';
import type { SurveyInfo } from './Editor.tsx';
import { STATUS_LABELS, type ResponseStatus } from '../../../shared/variables.ts';

const EXPORT_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'terminated', 'in_progress'];

interface RespRow {
  id: string; status: ResponseStatus; isTest: boolean; startedAt: string; completedAt: string | null;
  durationSec: number | null; answered: number; params: Record<string, string>;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function DataTab({ info, reload }: { info: SurveyInfo; reload: () => Promise<unknown> }) {
  const [statuses, setStatuses] = useState<ResponseStatus[]>(['completed']);
  const [recent, setRecent] = useState<RespRow[] | null>(null);
  const total = Object.values(info.counts.real).reduce((a, b) => a + b, 0);

  useEffect(() => { api<RespRow[]>('GET', `/api/admin/surveys/${info.id}/responses`).then(setRecent); }, [info.id, info.counts]);

  const exportUrl = (format: string, test = false) =>
    `/api/admin/surveys/${info.id}/export.${format}?statuses=${statuses.join(',')}${test ? '&test=1' : ''}`;

  return (
    <div className="stack">
      <div className="stats">
        <div className="card"><div className="stat">{info.counts.real.completed ?? 0}</div><div className="stat-label">Завершили</div></div>
        <div className="card"><div className="stat">{info.counts.real.screened_out ?? 0}</div><div className="stat-label">Отсеяны</div></div>
        <div className="card"><div className="stat">{info.counts.real.terminated ?? 0}</div><div className="stat-label">Досрочно</div></div>
        <div className="card"><div className="stat">{info.counts.real.in_progress ?? 0}</div><div className="stat-label">В процессе / бросили</div></div>
        <div className="card"><div className="stat">{total}</div><div className="stat-label">Всего начали</div></div>
      </div>

      <div className="card stack">
        <h2>Выгрузка</h2>
        <div className="row">
          {EXPORT_STATUSES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={statuses.includes(s)}
                onChange={(e) => setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s))} />
              {STATUS_LABELS[s]}
            </label>
          ))}
        </div>
        <div className="row">
          <a className="btn btn-primary" href={exportUrl('xlsx')}>Excel (.xlsx)</a>
          <a className="btn btn-primary" href={exportUrl('sav')}>SPSS (.sav)</a>
          <a className="btn btn-secondary" href={`/api/admin/surveys/${info.id}/export.json`}>Анкета (.json)</a>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Excel содержит листы «Коды», «Метки» и «Кодбук». Время — по часовому поясу сервера выгрузки (по умолчанию Москва).
        </p>
      </div>

      <SheetsCard info={info} reload={reload} />

      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Тестовые ответы (предпросмотр): {info.counts.test}</h2>
          <a className="btn btn-secondary btn-sm" href={`/api/admin/surveys/${info.id}/export.xlsx?statuses=${EXPORT_STATUSES.join(',')}&test=1`}>Excel с тестовыми</a>
          <button className="btn btn-danger btn-sm" disabled={!info.counts.test} onClick={async () => {
            if (!window.confirm('Удалить все тестовые ответы?')) return;
            const r = await api('DELETE', `/api/admin/surveys/${info.id}/test-responses`);
            toast(`Удалено: ${r.deleted}`);
            await reload();
          }}>Удалить тестовые</button>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <h2>Последние ответы</h2>
        {!recent ? <p className="muted">Загрузка…</p> : recent.length === 0 ? <p className="muted">Ответов пока нет</p> : (
          <table className="table">
            <thead><tr><th>ID</th><th>Статус</th><th>Начало</th><th>Окончание</th><th>Время</th><th>Ответов</th><th>Параметры</th></tr></thead>
            <tbody>
              {recent.slice(0, 50).map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{r.id}</td>
                  <td>{STATUS_LABELS[r.status]} {r.isTest && <span className="badge test">тест</span>}</td>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{fmt(r.completedAt)}</td>
                  <td>{r.durationSec !== null ? `${Math.floor(r.durationSec / 60)}:${String(r.durationSec % 60).padStart(2, '0')}` : '—'}</td>
                  <td>{r.answered}</td>
                  <td className="muted" style={{ fontSize: 13 }}>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SheetsCard({ info, reload }: { info: SurveyInfo; reload: () => Promise<unknown> }) {
  const cfg = info.sheets;
  const [form, setForm] = useState({
    spreadsheetId: cfg?.spreadsheetId ?? '',
    sheetName: cfg?.sheetName ?? 'Ответы',
    auto: cfg?.auto ?? true,
    values: cfg?.values ?? 'labels',
    statuses: (cfg?.statuses ?? ['completed']) as ResponseStatus[],
  });
  const [busy, setBusy] = useState(false);

  if (!info.sheetsAccount.configured) {
    return (
      <div className="card stack">
        <h2>Google Sheets</h2>
        <div className="warn-box">
          Не настроен сервисный аккаунт Google. Укажите путь к JSON-ключу в <code>GOOGLE_APPLICATION_CREDENTIALS</code> (файл .env) и перезапустите сервер.
          Инструкция — в README.
        </div>
      </div>
    );
  }

  const save = async () => {
    await api('PUT', `/api/admin/surveys/${info.id}/sheets`, form);
    await reload();
    toast('Настройки Google Sheets сохранены');
  };

  return (
    <div className="card stack">
      <h2>Google Sheets</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Откройте таблицу на редактирование для <code>{info.sheetsAccount.email}</code>, затем вставьте ссылку на неё.
      </p>
      <div className="grid2">
        <label className="field"><span>Ссылка на таблицу или её ID</span>
          <input className="input" value={form.spreadsheetId} placeholder="https://docs.google.com/spreadsheets/d/…"
            onChange={(e) => setForm({ ...form, spreadsheetId: e.target.value })} />
        </label>
        <label className="field"><span>Лист</span>
          <input className="input" value={form.sheetName} onChange={(e) => setForm({ ...form, sheetName: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} />Дописывать каждого нового респондента</label>
        <select className="input" style={{ width: 'auto' }} value={form.values} onChange={(e) => setForm({ ...form, values: e.target.value })}>
          <option value="labels">Тексты ответов</option>
          <option value="codes">Коды ответов</option>
        </select>
      </div>
      <div className="row">
        {EXPORT_STATUSES.filter((s) => s !== 'in_progress').map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={form.statuses.includes(s)}
              onChange={(e) => setForm({ ...form, statuses: e.target.checked ? [...form.statuses, s] : form.statuses.filter((x) => x !== s) })} />
            {STATUS_LABELS[s]}
          </label>
        ))}
      </div>
      {cfg?.lastError && <div className="error-box">Последняя ошибка: {cfg.lastError}</div>}
      {cfg?.lastSyncAt && !cfg.lastError && <div className="ok-box">Последняя синхронизация: {fmt(cfg.lastSyncAt)}</div>}
      <div className="row">
        <button className="btn btn-secondary" onClick={save}>Сохранить</button>
        <button className="btn btn-primary" disabled={!cfg?.spreadsheetId || busy} onClick={async () => {
          setBusy(true);
          try {
            const r = await api('POST', `/api/admin/surveys/${info.id}/sheets/sync`);
            toast(`Выгружено строк: ${r.rows}`);
          } catch (e) {
            toast((e as Error).message);
          } finally {
            setBusy(false);
            await reload();
          }
        }}>{busy ? 'Выгрузка…' : 'Полная синхронизация'}</button>
      </div>
    </div>
  );
}
