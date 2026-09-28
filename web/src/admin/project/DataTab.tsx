import { useEffect, useState } from 'react';
import { api, useApi } from '../../api.ts';
import { toast } from '../common.tsx';
import { canEdit, isClient, useMe } from '../AdminApp.tsx';
import { allQuestions } from '../../../../shared/logic.ts';
import { STATUS_LABELS, flagLabel, type ResponseStatus } from '../../../../shared/variables.ts';
import type { ProjectInfo, ResponseListItem } from '../../../../shared/api.ts';
import { ResponseModal } from './ResponseModal.tsx';
import { SheetsCard, NotifyCard } from './Integrations.tsx';
import { EXPORT_STATUSES, fmtDate } from './format.ts';



export function DataTab({ info, reload }: { info: ProjectInfo; reload: () => Promise<unknown> }) {
  const [statuses, setStatuses] = useState<ResponseStatus[]>(['completed']);
  const { data: recent, reload: reloadRecent } = useApi<ResponseListItem[]>(`/api/admin/projects/${info.id}/responses`, [info.counts]);
  const [viewing, setViewing] = useState<string | null>(null);
  const me = useMe();
  const editable = canEdit(me);
  const client = isClient(me);
  const [showTest, setShowTest] = useState(!client);
  const [simCount, setSimCount] = useState(20);
  const [simBusy, setSimBusy] = useState(false);
  const refresh = async () => {
    await reloadRecent();
    await reload();
  };
  const total = Object.values(info.counts.real).reduce((a, b) => a + b, 0);
  const minDur = (info.published ?? info.draft).settings?.minDurationSec;

  // При открытии вкладки — свежие счётчики (редактор мог быть открыт давно)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, []);

  const [opts, setOpts] = useState({ from: '', to: '', timings: false, rejected: false, panel: '' });
  /** Панели для фильтра: из проекта и те, что встречаются в ответах */
  const panelCodes = [...new Set([...info.panels.map((p) => p.id), ...info.panelCounts.map((c) => c.panel).filter((x): x is string => !!x)])];
  const panelTitle = (code: string) => info.panels.find((p) => p.id === code)?.title || code;
  const matchPanel = (r: ResponseListItem) => !opts.panel || (opts.panel === '-' ? !r.params.panel : r.params.panel === opts.panel);
  const shownRecent = (recent ?? []).filter((r) => (showTest || !r.isTest) && matchPanel(r));
  const exportUrl = (format: string, test = false) => {
    const q = new URLSearchParams({ statuses: statuses.join(',') });
    if (test) q.set('test', '1');
    if (opts.from) q.set('from', opts.from);
    if (opts.to) q.set('to', opts.to);
    if (opts.timings) q.set('timings', '1');
    if (opts.rejected) q.set('rejected', '1');
    if (opts.panel) q.set('panel', opts.panel);
    return `/api/admin/projects/${info.id}/export.${format}?${q}`;
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
        {info.counts.suspect > 0 && (
          <div className="card">
            <div className="stat">{info.counts.suspect}</div>
            <div className="stat-label">Подозрительные</div>
            {editable && (
              <button className="btn-link small" style={{ padding: 0, marginTop: 4 }} onClick={async () => {
                if (!window.confirm(`Забраковать подозрительные анкеты (${info.counts.suspect})? Они перестанут считаться в квотах, лимите, отчёте и выгрузке. Брак можно снять по одной.`)) return;
                const r = await api('POST', `/api/admin/projects/${info.id}/reject-suspect`);
                toast(`Забраковано: ${r.rejected}`);
                await refresh();
              }}>забраковать все</button>
            )}
          </div>
        )}
        <div className="card"><div className="stat">{total}</div><div className="stat-label">Всего начали</div></div>
      </div>

      {info.quotas.length > 0 && (
        <div className="card stack">
          <h2>Квоты</h2>
          <table className="table">
            <tbody>
              {info.quotas.map((q) => (
                <tr key={q.id}>
                  <td style={{ width: '40%', paddingLeft: 8 + q.depth * 18 }}>{q.depth > 0 && <span className="muted">└ </span>}{q.depth ? q.title || q.id : <strong>{q.title || q.id}</strong>} <span className="muted small mono">{q.id}</span></td>
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
          {panelCodes.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={opts.panel} aria-label="Панель" onChange={(e) => setOpts({ ...opts, panel: e.target.value })}>
              <option value="">все панели</option>
              {panelCodes.map((c) => <option key={c} value={c}>{panelTitle(c)}</option>)}
              <option value="-">без панели</option>
            </select>
          )}
          <label className="check"><input type="checkbox" checked={opts.timings} onChange={(e) => setOpts({ ...opts, timings: e.target.checked })} />Время на каждом вопросе (t_Q1…)</label>
          {info.counts.rejected > 0 && (
            <label className="check"><input type="checkbox" checked={opts.rejected} onChange={(e) => setOpts({ ...opts, rejected: e.target.checked })} />Включая брак</label>
          )}
        </div>
        {!statuses.length && <div className="warn-box">Отметьте хотя бы один статус – иначе выгружать нечего.</div>}
        <div className={`row${statuses.length ? '' : ' links-disabled'}`}>
          <a className="btn btn-primary" href={exportUrl('xlsx')}>Excel (.xlsx)</a>
          <a className="btn btn-primary" href={exportUrl('sav')}>SPSS (.sav)</a>
          <a className="btn btn-secondary" href={exportUrl('csv')}>CSV</a>
          {!client && <a className="btn btn-secondary" href={`/api/admin/surveys/${info.survey.id}/export.json`}>Анкета (.json)</a>}
          {allQuestions(info.published ?? info.draft).filter((q) => q.type === 'maxdiff' || q.type === 'conjoint').map((q) => (
            <a key={q.id} className="btn btn-secondary" title="Что показано каждому респонденту и что он выбрал – по строке на вариант / карточку"
              href={`/api/admin/projects/${info.id}/design.csv?q=${q.id}&statuses=${statuses.join(',')}`}>Дизайн {q.id} (CSV)</a>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Excel содержит листы «Коды», «Метки» и «Кодбук». Время – по часовому поясу сервера выгрузки (по умолчанию Москва).
        </p>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>Последние ответы</h2>
          {!client && <label className="check small"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />показывать тестовые</label>}
        </div>
        {!recent ? <p className="muted">Загрузка…</p> : recent.length === 0 ? <p className="muted">Ответов пока нет</p> : !shownRecent.length ? (
          <p className="muted">{opts.panel ? 'По выбранной панели ответов нет' : 'Пока только тестовые ответы – включите «показывать тестовые»'}</p>
        ) : (
          <table className="table">
            <thead><tr><th>ID</th><th>Статус</th><th>Начало</th><th>Окончание</th><th>Время</th><th>Ответов</th><th>Параметры</th></tr></thead>
            <tbody>
              {shownRecent.slice(0, 100).map((r) => (
                <tr key={r.id} className={`clickable${r.rejected ? ' muted' : ''}`} onClick={() => setViewing(r.id)} title="Открыть ответ">
                  <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{r.id}</td>
                  <td>
                    {STATUS_LABELS[r.status]} {r.isTest && <span className="badge test">тест</span>}{r.rejected && <span className="badge closed">брак</span>}
                    {!!r.flags?.length && <span className="badge suspect" title={r.flags.map(flagLabel).join('\n')}>подозрительная</span>}
                  </td>
                  <td>{fmtDate(r.startedAt, '–')}</td>
                  <td>{fmtDate(r.completedAt, '–')}</td>
                  <td>
                    {r.durationSec !== null ? `${Math.floor(r.durationSec / 60)}:${String(r.durationSec % 60).padStart(2, '0')}` : '–'}
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
      {!client && <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Тестовые ответы: {info.counts.test}</h2>
          {editable && <span className="row" style={{ gap: 6 }}>
            <input className="input mini" type="number" min={1} max={500} value={simCount} title="Сколько анкет заполнить"
              onChange={(e) => setSimCount(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
            <button className="btn btn-secondary btn-sm" disabled={simBusy} title="Боты пройдут черновик по логике со случайными ответами" onClick={async () => {
              setSimBusy(true);
              try {
                const r = await api('POST', `/api/admin/projects/${info.id}/simulate`, { count: simCount });
                toast(`Заполнено: ${r.count} (завершили ${r.stats.completed ?? 0}, отсеяно ${r.stats.screened_out ?? 0}${r.stats.overquota ? `, сверх квоты ${r.stats.overquota}` : ''})`);
                await refresh();
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setSimBusy(false);
              }
            }}>{simBusy ? 'Заполнение…' : 'Заполнить тестовыми'}</button>
          </span>}
          <a className="btn btn-secondary btn-sm" href={`/api/admin/projects/${info.id}/export.xlsx?statuses=${EXPORT_STATUSES.join(',')}&test=1`}>Excel с тестовыми</a>
          {editable && <button className="btn btn-danger btn-sm" disabled={!info.counts.test} onClick={async () => {
            if (!window.confirm('Удалить все тестовые ответы?')) return;
            const r = await api('DELETE', `/api/admin/projects/${info.id}/test-responses`);
            toast(`Удалено: ${r.deleted}`);
            await refresh();
          }}>Удалить тестовые</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Тестовые ответы появляются из предпросмотра и тестового заполнения. В обычные выгрузки и Google Sheets они не попадают.
        </p>
      </div>}

      {!client && <div className="integrations">
        <details className="card integration" open={!!info.sheets || undefined}>
          <summary><h2>Google Sheets</h2><span className="muted small">{info.sheets ? 'подключено' : 'автоматическая запись ответов в таблицу'}</span></summary>
          <SheetsCard info={info} reload={reload} />
        </details>
        <details className="card integration" open={!!info.notify || undefined}>
          <summary><h2>Уведомления</h2><span className="muted small">{info.notify ? 'настроены' : 'вебхук и Telegram'}</span></summary>
          <NotifyCard info={info} reload={reload} />
        </details>
      </div>}
      {viewing && <ResponseModal editable={editable} surveyId={info.id} rid={viewing} onClose={() => setViewing(null)} onDeleted={() => { setViewing(null); refresh(); }} onChanged={refresh} />}
    </div>
  );
}

