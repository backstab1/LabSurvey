import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Modal, toast } from './common.tsx';
import { rich } from '../runner/rich.tsx';
import { allQuestions, answerText, pipe } from '../../../shared/logic.ts';
import type { Answers, Survey } from '../../../shared/types.ts';
import type { SurveyInfo } from './Editor.tsx';
import { STATUS_LABELS, type ResponseStatus } from '../../../shared/variables.ts';

const EXPORT_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'overquota', 'terminated', 'in_progress'];

interface RespRow {
  id: string; status: ResponseStatus; isTest: boolean; rejected: boolean; startedAt: string; completedAt: string | null;
  durationSec: number | null; answered: number; params: Record<string, string>;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function DataTab({ info, reload }: { info: SurveyInfo; reload: () => Promise<unknown> }) {
  const [statuses, setStatuses] = useState<ResponseStatus[]>(['completed']);
  const [recent, setRecent] = useState<RespRow[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [showTest, setShowTest] = useState(true);
  const [simCount, setSimCount] = useState(20);
  const [simBusy, setSimBusy] = useState(false);
  const refresh = async () => {
    setRecent(await api<RespRow[]>('GET', `/api/admin/surveys/${info.id}/responses`));
    await reload();
  };
  const total = Object.values(info.counts.real).reduce((a, b) => a + b, 0);
  const minDur = (info.published ?? info.draft).settings?.minDurationSec;

  useEffect(() => { api<RespRow[]>('GET', `/api/admin/surveys/${info.id}/responses`).then(setRecent); }, [info.id, info.counts]);

  const [opts, setOpts] = useState({ from: '', to: '', timings: false, rejected: false });
  const exportUrl = (format: string, test = false) => {
    const q = new URLSearchParams({ statuses: statuses.join(',') });
    if (test) q.set('test', '1');
    if (opts.from) q.set('from', opts.from);
    if (opts.to) q.set('to', opts.to);
    if (opts.timings) q.set('timings', '1');
    if (opts.rejected) q.set('rejected', '1');
    return `/api/admin/surveys/${info.id}/export.${format}?${q}`;
  };

  return (
    <div className="stack">
      <div className="stats">
        <div className="card"><div className="stat">{info.counts.real.completed ?? 0}</div><div className="stat-label">Завершили</div></div>
        <div className="card"><div className="stat">{info.counts.real.screened_out ?? 0}</div><div className="stat-label">Отсеяны</div></div>
        {(info.counts.real.overquota ?? 0) > 0 && <div className="card"><div className="stat">{info.counts.real.overquota}</div><div className="stat-label">Сверх квоты</div></div>}
        <div className="card"><div className="stat">{info.counts.real.terminated ?? 0}</div><div className="stat-label">Досрочно</div></div>
        <div className="card"><div className="stat">{info.counts.real.in_progress ?? 0}</div><div className="stat-label">В процессе / бросили</div></div>
        {info.counts.rejected > 0 && <div className="card"><div className="stat">{info.counts.rejected}</div><div className="stat-label">Брак</div></div>}
        <div className="card"><div className="stat">{total}</div><div className="stat-label">Всего начали</div></div>
      </div>

      {info.quotas.length > 0 && (
        <div className="card stack">
          <h2>Квоты</h2>
          <table className="table">
            <tbody>
              {info.quotas.map((q) => (
                <tr key={q.id}>
                  <td style={{ width: '40%' }}><strong>{q.title || q.id}</strong> <span className="muted small mono">{q.id}</span></td>
                  <td>
                    <div className="quota-bar"><div style={{ width: `${q.limit ? Math.min(100, (q.count / q.limit) * 100) : 100}%` }} className={q.count >= q.limit ? 'full' : ''} /></div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{q.count} из {q.limit}{q.count >= q.limit ? ' ✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        <div className="row export-opts">
          <label className="row" style={{ gap: 6 }}><span className="muted small">начало с</span>
            <input className="input" type="date" value={opts.from} onChange={(e) => setOpts({ ...opts, from: e.target.value })} /></label>
          <label className="row" style={{ gap: 6 }}><span className="muted small">по</span>
            <input className="input" type="date" value={opts.to} onChange={(e) => setOpts({ ...opts, to: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={opts.timings} onChange={(e) => setOpts({ ...opts, timings: e.target.checked })} />Время на каждом вопросе (t_Q1…)</label>
          {info.counts.rejected > 0 && (
            <label className="check"><input type="checkbox" checked={opts.rejected} onChange={(e) => setOpts({ ...opts, rejected: e.target.checked })} />Включая брак</label>
          )}
        </div>
        <div className="row">
          <a className="btn btn-primary" href={exportUrl('xlsx')}>Excel (.xlsx)</a>
          <a className="btn btn-primary" href={exportUrl('sav')}>SPSS (.sav)</a>
          <a className="btn btn-secondary" href={exportUrl('csv')}>CSV</a>
          <a className="btn btn-secondary" href={`/api/admin/surveys/${info.id}/export.json`}>Анкета (.json)</a>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Excel содержит листы «Коды», «Метки» и «Кодбук». Время — по часовому поясу сервера выгрузки (по умолчанию Москва).
        </p>
      </div>


      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>Последние ответы</h2>
          <label className="check small"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />показывать тестовые</label>
        </div>
        {!recent ? <p className="muted">Загрузка…</p> : recent.length === 0 ? <p className="muted">Ответов пока нет</p> : (
          <table className="table">
            <thead><tr><th>ID</th><th>Статус</th><th>Начало</th><th>Окончание</th><th>Время</th><th>Ответов</th><th>Параметры</th></tr></thead>
            <tbody>
              {recent.filter((r) => showTest || !r.isTest).slice(0, 100).map((r) => (
                <tr key={r.id} className={`clickable${r.rejected ? ' muted' : ''}`} onClick={() => setViewing(r.id)} title="Открыть ответ">
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{r.id}</td>
                  <td>{STATUS_LABELS[r.status]} {r.isTest && <span className="badge test">тест</span>}{r.rejected && <span className="badge closed">брак</span>}</td>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{fmt(r.completedAt)}</td>
                  <td>
                    {r.durationSec !== null ? `${Math.floor(r.durationSec / 60)}:${String(r.durationSec % 60).padStart(2, '0')}` : '—'}
                    {minDur && r.status === 'completed' && r.durationSec !== null && r.durationSec < minDur
                      ? <span className="badge test" style={{ marginLeft: 6 }} title={`Быстрее ${minDur} сек`}>спидер</span> : null}
                  </td>
                  <td>{r.answered}</td>
                  <td className="muted" style={{ fontSize: 13 }}>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Тестовые ответы: {info.counts.test}</h2>
          <span className="row" style={{ gap: 6 }}>
            <input className="input mini" type="number" min={1} max={500} value={simCount} title="Сколько анкет заполнить"
              onChange={(e) => setSimCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
            <button className="btn btn-secondary btn-sm" disabled={simBusy} title="Боты пройдут черновик по логике со случайными ответами" onClick={async () => {
              setSimBusy(true);
              try {
                const r = await api('POST', `/api/admin/surveys/${info.id}/simulate`, { count: simCount });
                toast(`Заполнено: ${r.count} (завершили ${r.stats.completed ?? 0}, отсеяно ${r.stats.screened_out ?? 0}${r.stats.overquota ? `, сверх квоты ${r.stats.overquota}` : ''})`);
                await refresh();
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setSimBusy(false);
              }
            }}>{simBusy ? 'Заполнение…' : 'Заполнить тестовыми'}</button>
          </span>
          <a className="btn btn-secondary btn-sm" href={`/api/admin/surveys/${info.id}/export.xlsx?statuses=${EXPORT_STATUSES.join(',')}&test=1`}>Excel с тестовыми</a>
          <button className="btn btn-danger btn-sm" disabled={!info.counts.test} onClick={async () => {
            if (!window.confirm('Удалить все тестовые ответы?')) return;
            const r = await api('DELETE', `/api/admin/surveys/${info.id}/test-responses`);
            toast(`Удалено: ${r.deleted}`);
            await refresh();
          }}>Удалить тестовые</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Тестовые ответы появляются из предпросмотра и тестового заполнения. В обычные выгрузки и Google Sheets они не попадают.
        </p>
      </div>

      <div className="integrations">
        <details className="card integration" open={!!info.sheets || undefined}>
          <summary><h2>Google Sheets</h2><span className="muted small">{info.sheets ? 'подключено' : 'автоматическая запись ответов в таблицу'}</span></summary>
          <SheetsCard info={info} reload={reload} />
        </details>
        <details className="card integration" open={!!info.notify || undefined}>
          <summary><h2>Уведомления</h2><span className="muted small">{info.notify ? 'настроены' : 'вебхук и Telegram'}</span></summary>
          <NotifyCard info={info} reload={reload} />
        </details>
      </div>
      {viewing && <ResponseModal surveyId={info.id} rid={viewing} onClose={() => setViewing(null)} onDeleted={() => { setViewing(null); refresh(); }} onChanged={refresh} />}
    </div>
  );
}

/** Просмотр одного ответа: вопросы, которые видел респондент, и его ответы */
function ResponseModal({ surveyId, rid, onClose, onDeleted, onChanged }: {
  surveyId: string; rid: string; onClose: () => void; onDeleted: () => void; onChanged: () => void;
}) {
  const [data, setData] = useState<{ response: RespRow & { answers: Answers; history: string[]; timings?: Record<string, number> }; survey: Survey } | null>(null);
  const load = () => api('GET', `/api/admin/surveys/${surveyId}/responses/${rid}`).then(setData);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [surveyId, rid]);
  if (!data) return <Modal onClose={onClose} title="Ответ">Загрузка…</Modal>;
  const { response: r, survey } = data;
  const ctx = { survey, answers: r.answers, params: r.params, seed: r.id };
  const qs = allQuestions(survey).filter((q) => q.type !== 'info' && r.answers[q.id] !== undefined);
  return (
    <Modal onClose={onClose} title={<>Ответ <span className="mono muted" style={{ fontWeight: 400, fontSize: 14 }}>{r.id}</span></>}
      actions={<>
        <button className="btn btn-secondary btn-sm" title="Бракованная анкета не считается в квотах, лимите, отчёте и выгрузке (выгрузить можно отдельно)"
          onClick={async () => {
            await api('POST', `/api/admin/surveys/${surveyId}/responses/${rid}/reject`, { rejected: !r.rejected });
            await load();
            onChanged();
            toast(r.rejected ? 'Брак снят' : 'Анкета помечена как брак');
          }}>{r.rejected ? 'Снять брак' : 'Забраковать'}</button>
        <button className="btn btn-danger btn-sm" onClick={async () => {
          if (!window.confirm('Удалить этот ответ? Это нельзя отменить.')) return;
          await api('DELETE', `/api/admin/surveys/${surveyId}/responses/${rid}`);
          onDeleted();
        }}>Удалить</button>
        <button className="btn btn-primary btn-sm" onClick={onClose}>Закрыть</button>
      </>}>
      <div className="stack">
        <div className="row small muted">
          <span>{STATUS_LABELS[r.status]}{r.isTest ? ' · тест' : ''}</span>
          <span>Начало: {fmt(r.startedAt)}</span>
          <span>Окончание: {fmt(r.completedAt)}</span>
          {r.durationSec !== null && <span>Время: {Math.floor(r.durationSec / 60)} мин {r.durationSec % 60} с</span>}
          {Object.entries(r.params).map(([k, v]) => <span key={k} className="mono">{k}={v}</span>)}
        </div>
        {qs.length === 0 ? <p className="muted">Ответов нет</p> : (
          <table className="table answers-table">
            <tbody>
              {qs.map((q) => (
                <tr key={q.id}>
                  <td className="mono" style={{ width: 70, verticalAlign: 'top' }}>{q.id}</td>
                  <td style={{ verticalAlign: 'top' }}>
                    <div className="muted small">{rich(pipe(q.text, ctx))}</div>
                    <div>{answerText(ctx, q) || '—'}</div>
                  </td>
                  <td className="muted small" style={{ width: 60, textAlign: 'right', verticalAlign: 'top' }} title="Время на вопросе">
                    {r.timings?.[q.id] !== undefined ? `${r.timings[q.id]} с` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
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

/** Уведомления: вебхук (JSON) и Telegram — о завершённых анкетах, набранных квотах и лимите */
function NotifyCard({ info, reload }: { info: SurveyInfo; reload: () => Promise<unknown> }) {
  const cfg = info.notify;
  const [form, setForm] = useState({
    webhookUrl: cfg?.webhookUrl ?? '', telegramChatId: cfg?.telegramChatId ?? '',
    everyN: cfg?.everyN ?? 0, quotaFull: cfg?.quotaFull ?? true, limitReached: cfg?.limitReached ?? true,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    try {
      await api('PUT', `/api/admin/surveys/${info.id}/notify`, form);
      await reload();
      toast('Уведомления сохранены');
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  };
  return (
    <div className="card stack">
      <h2>Уведомления</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Сообщения о ходе сбора. Вебхук получает JSON (для завершённых анкет — с ответами); в Telegram приходит короткий текст.
      </p>
      <div className="grid2">
        <label className="field"><span>Вебхук (POST JSON)</span>
          <input className="input mono" placeholder="https://…" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
        </label>
        <label className="field"><span>Чат Telegram</span>
          <input className="input mono" placeholder="-1001234567890 или @channel" value={form.telegramChatId}
            disabled={!info.telegramConfigured} onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })} />
          <span className="field-help">
            {info.telegramConfigured
              ? 'Добавьте бота в чат или канал; ID чата покажет, например, @userinfobot'
              : 'Чтобы включить, задайте TELEGRAM_BOT_TOKEN в .env и перезапустите сервер'}
          </span>
        </label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="check">
          <input type="checkbox" checked={form.everyN > 0} onChange={(e) => setForm({ ...form, everyN: e.target.checked ? 1 : 0 })} />
          Завершённые анкеты: каждая
        </label>
        {form.everyN > 0 && (
          <label className="row" style={{ gap: 6 }}><span className="muted small">или каждая N-я:</span>
            <input className="input mini" type="number" min={1} value={form.everyN} onChange={(e) => setForm({ ...form, everyN: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
        )}
        <label className="check"><input type="checkbox" checked={form.quotaFull} onChange={(e) => setForm({ ...form, quotaFull: e.target.checked })} />Квота набрана</label>
        <label className="check"><input type="checkbox" checked={form.limitReached} onChange={(e) => setForm({ ...form, limitReached: e.target.checked })} />Лимит анкет набран</label>
      </div>
      {cfg?.lastError && <div className="error-box">Последняя ошибка: {cfg.lastError}</div>}
      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Сохранить</button>
        <button className="btn btn-secondary btn-sm" disabled={busy || (!form.webhookUrl && !form.telegramChatId)} onClick={async () => {
          setBusy(true);
          try {
            if (!(await save())) return;
            await api('POST', `/api/admin/surveys/${info.id}/notify/test`);
            toast('Тестовое уведомление отправлено');
          } catch (e) {
            toast((e as Error).message);
          } finally {
            setBusy(false);
            await reload();
          }
        }}>Отправить тест</button>
        {cfg?.lastSentAt && <span className="muted small">последнее: {fmt(cfg.lastSentAt)}</span>}
      </div>
    </div>
  );
}
