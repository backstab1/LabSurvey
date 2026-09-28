// Сводка проекта: статус, счётчики, источники, динамика по дням, квоты, анкета
import { useState, type ReactNode } from 'react';
import { api } from '../../api.ts';
import { navigate } from '../AdminApp.tsx';
import { toast } from '../common.tsx';
import { fmtDate, fmtDuration, pct } from './format.ts';
import type { Tab } from './ProjectPage.tsx';
import { PROJECT_STATUS_LABELS, type ProjectStatus } from '../../../../shared/types.ts';
import type { DayStat, PanelCounts, ProjectInfo, SurveyListItem } from '../../../../shared/api.ts';

/** Что значит статус проекта для респондентов */
export const STATUS_HINTS: Record<ProjectStatus, string> = {
  development: 'Проект готовится. Респонденты видят «Опрос ещё не начался», работает только тестовая ссылка.',
  collecting: 'Идёт сбор: ссылка открыта для респондентов, работают сроки, лимиты и квоты.',
  processing: 'Сбор остановлен: новые анкеты не принимаются, данные и отчёты доступны.',
  archive: 'Проект завершён и убран в архив. Сбор закрыт, данные сохранены.',
};

export function Overview({ info, readOnly, client, setStatus, reload, onTab }: {
  info: ProjectInfo; readOnly: boolean; client: boolean; setStatus: (s: ProjectStatus) => void; reload: () => Promise<unknown>; onTab: (t: Tab) => void;
}) {
  const [surveys, setSurveys] = useState<SurveyListItem[] | null>(null);
  const st = info.settings;
  const done = info.counts.real.completed ?? 0;
  const started = Object.values(info.counts.real).reduce((a, b) => a + b, 0);
  const limitPct = st.maxResponses ? Math.min(100, Math.round((done / st.maxResponses) * 100)) : 0;
  const now = Date.now();
  const timing = st.openFrom && now < Date.parse(st.openFrom) ? `Сбор откроется ${fmtDate(st.openFrom)}`
    : st.closeAt && now >= Date.parse(st.closeAt) ? `Срок сбора истёк ${fmtDate(st.closeAt)}`
      : st.maxResponses && done >= st.maxResponses ? 'Лимит анкет набран – новые респонденты не попадут в опрос' : '';

  const actions: ReactNode[] = [];
  if (!readOnly) {
    if (info.status === 'development') {
      actions.push(<button key="go" className="btn btn-primary" disabled={!info.survey.published} onClick={() => setStatus('collecting')}
        title={info.survey.published ? '' : 'Сначала опубликуйте анкету'}>Начать сбор данных</button>);
    }
    if (info.status === 'collecting') actions.push(<button key="stop" className="btn btn-secondary" onClick={() => setStatus('processing')}>Остановить сбор</button>);
    if (info.status === 'processing') {
      actions.push(<button key="resume" className="btn btn-primary" onClick={() => setStatus('collecting')}>Возобновить сбор</button>);
      actions.push(<button key="arch" className="btn btn-secondary" onClick={() => setStatus('archive')}>В архив</button>);
    }
    if (info.status === 'archive') actions.push(<button key="unarch" className="btn btn-secondary" onClick={() => setStatus('processing')}>Вернуть из архива</button>);
  }

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row" style={{ alignItems: 'center' }}>
          <h2 className="grow" style={{ margin: 0 }}>{readOnly ? `Статус: ${PROJECT_STATUS_LABELS[info.status]}` : 'Статус проекта'}</h2>
          {!readOnly && (
            <select className="input" style={{ width: 'auto' }} value={info.status} aria-label="Статус проекта"
              onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {(Object.keys(PROJECT_STATUS_LABELS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</option>)}
            </select>
          )}
        </div>
        <p className="muted" style={{ margin: 0 }}>{STATUS_HINTS[info.status]}</p>
        {info.status === 'collecting' && timing && <div className="warn-box">{timing}</div>}
        {info.status === 'development' && !info.survey.published && (
          <div className="warn-box">Анкета ещё не опубликована – начать сбор нельзя. <button className="btn-link" onClick={() => navigate(`/admin/s/${info.survey.id}`)}>Открыть анкету</button></div>
        )}
        {actions.length > 0 && <div className="row" style={{ gap: 8 }}>{actions}</div>}
        <div className="muted small">
          {st.openFrom || st.closeAt
            ? <>Сроки: {st.openFrom ? `с ${fmtDate(st.openFrom)}` : 'без даты начала'} {st.closeAt ? `до ${fmtDate(st.closeAt)}` : 'без даты окончания'}</>
            : 'Сроки не заданы'}
          {!client && <> · <button className="btn-link" style={{ padding: 0 }} onClick={() => onTab('settings')}>настроить</button></>}
        </div>
      </div>

      <div className="stats">
        <div className="card">
          <div className="stat">{done}{st.maxResponses ? <span className="muted" style={{ fontSize: 16 }}> / {st.maxResponses}</span> : null}</div>
          <div className="stat-label">Завершили</div>
          {st.maxResponses ? <div className="quota-bar" style={{ marginTop: 6 }}><div style={{ width: `${limitPct}%` }} className={done >= st.maxResponses ? 'full' : ''} /></div> : null}
        </div>
        <div className="card"><div className="stat">{info.counts.real.screened_out ?? 0}</div><div className="stat-label">Отсеяны</div></div>
        <div className="card"><div className="stat">{info.counts.real.overquota ?? 0}</div><div className="stat-label">Сверх квоты</div></div>
        <div className="card"><div className="stat">{info.counts.real.in_progress ?? 0}</div><div className="stat-label">В процессе / бросили</div></div>
        <div className="card"><div className="stat">{started}</div><div className="stat-label">Всего начали</div></div>
        <div className="card">
          <div className="stat">{pct(done, started)}</div>
          <div className="stat-label" title="Завершили / начали">Конверсия</div>
        </div>
        <div className="card">
          <div className="stat">{fmtDuration(medianAll(info.panelCounts))}</div>
          <div className="stat-label" title="Медиана длительности завершённых анкет">Медиана времени</div>
        </div>
      </div>

      {(info.panels.length > 0 || info.panelCounts.some((c) => c.panel !== null)) && (
        <div className="card stack">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>Источники</h2>{!client && <button className="btn-link" onClick={() => onTab('panels')}>панели</button>}</div>
          <SourcesTable info={info} />
        </div>
      )}

      {info.daily.length > 1 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>По дням</h2>
          <DailyChart days={info.daily} />
        </div>
      )}

      {info.quotas.length > 0 && (
        <div className="card stack">
          <div className="row"><h2 className="grow" style={{ margin: 0 }}>Квоты</h2>{!client && <button className="btn-link" onClick={() => onTab('quotas')}>изменить</button>}</div>
          <QuotaProgress quotas={info.quotas} />
        </div>
      )}

      {!client && <div className="card stack">
        <h2 style={{ margin: 0 }}>Анкета</h2>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <strong>{info.survey.title}</strong>
          <span className="muted small">{info.survey.published ? `опубликована версия ${info.survey.version}` : 'не опубликована'}</span>
          {info.survey.published && info.survey.unpublished && <span className="badge test">есть неопубликованные правки</span>}
          <span className="grow" />
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/admin/s/${info.survey.id}`)}>Открыть в конструкторе</button>
          <button className="btn btn-secondary btn-sm" onClick={() => window.open(`/s/${info.id}?test=${info.testToken}&new=1`, '_blank')}>Пройти тестово</button>
        </div>
        {!readOnly && (
          info.status === 'collecting'
            ? <p className="muted small" style={{ margin: 0 }}>Во время сбора анкету проекта менять нельзя. Новые версии анкеты подхватываются после публикации.</p>
            : surveys === null
              ? <button className="btn-link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => api<SurveyListItem[]>('GET', '/api/admin/surveys').then((l) => setSurveys(l.filter((s) => !s.archived || s.id === info.survey.id)))}>Выбрать другую анкету</button>
              : (
                <label className="field"><span>Анкета проекта</span>
                  <select className="input" value={info.survey.id} onChange={async (e) => {
                    const hasData = Object.values(info.counts.real).some((n) => n > 0);
                    if (hasData && !window.confirm('В проекте уже есть ответы по текущей анкете. Сменить анкету? Старые ответы останутся, но выгрузка и отчёт будут строиться по новой анкете.')) return;
                    try {
                      await api('PUT', `/api/admin/projects/${info.id}`, { surveyId: e.target.value });
                      await reload();
                      setSurveys(null);
                    } catch (err) { toast((err as Error).message); }
                  }}>
                    {surveys.map((s) => <option key={s.id} value={s.id}>{s.title}{s.version ? ` · версия ${s.version}` : ' · не опубликована'}</option>)}
                  </select>
                </label>
              )
        )}
      </div>}
    </div>
  );
}

/** Столбики по дням: завершили (основной цвет) поверх начавших (светлый); подробности — при наведении */
export function DailyChart({ days }: { days: DayStat[] }) {
  const max = Math.max(1, ...days.map((d) => d.started));
  const total = days.reduce((a, d) => a + d.completed, 0);
  const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const every = Math.ceil(days.length / 10);
  return (
    <div className="daily">
      <div className="daily-bars" role="img" aria-label={`Завершили за ${days.length} дн.: ${total}`}>
        {days.map((d) => (
          <div key={d.day} className="daily-col"
            title={`${fmtDay(d.day)}: начали ${d.started}, завершили ${d.completed}${d.screenedOut ? `, отсеяны ${d.screenedOut}` : ''}${d.overquota ? `, сверх квоты ${d.overquota}` : ''}`}>
            <div className="daily-started" style={{ height: `${(d.started / max) * 100}%` }} />
            <div className="daily-done" style={{ height: `${(Math.min(d.completed, max) / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="daily-axis">
        {days.map((d, i) => <span key={d.day}>{i % every === 0 || i === days.length - 1 ? fmtDay(d.day) : ''}</span>)}
      </div>
      <div className="row small muted" style={{ gap: 14 }}>
        <span><i className="daily-key done" /> завершили</span>
        <span><i className="daily-key started" /> начали</span>
        <span className="grow" />
        <span>Всего завершили: {total}</span>
      </div>
    </div>
  );
}

export function QuotaProgress({ quotas }: { quotas: ProjectInfo['quotas'] }) {
  return (
    <div className="quota-lines">
      {quotas.map((q) => {
        const pct = q.limit ? Math.min(100, Math.round((q.count / q.limit) * 100)) : 100;
        return (
          <div key={q.id} className="quota-line">
            <span className="quota-name" style={{ paddingLeft: q.depth * 16 }}>{q.depth > 0 && <span className="muted">└ </span>}{q.title || q.id}</span>
            <div className="quota-bar"><div style={{ width: `${pct}%` }} className={q.count >= q.limit ? 'full' : ''} /></div>
            <span className="small quota-count">{q.count} / {q.limit}{q.count >= q.limit ? ' ✓' : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Медиана по всем источникам — приближённо: медианы источников, взвешенные по числу завершённых */
function medianAll(list: PanelCounts[]): number | null {
  const withTime = list.filter((c) => c.medianSec !== null && (c.statuses.completed ?? 0) > 0);
  if (!withTime.length) return null;
  const n = withTime.reduce((a, c) => a + (c.statuses.completed ?? 0), 0);
  return Math.round(withTime.reduce((a, c) => a + c.medianSec! * (c.statuses.completed ?? 0), 0) / n);
}

/** Воронка по источникам: панели проекта, неизвестные коды и прямая ссылка */
function SourcesTable({ info }: { info: ProjectInfo }) {
  const byCode = new Map(info.panelCounts.map((c) => [c.panel, c]));
  const rows: { key: string; name: ReactNode; c: PanelCounts | undefined; limit?: number; closed?: boolean }[] = [
    ...info.panels.map((p) => ({
      key: p.id, name: <>{p.title || p.id} <span className="muted mono small">{p.id}</span></>, c: byCode.get(p.id), limit: p.limit, closed: p.closed,
    })),
    ...info.panelCounts.filter((c) => c.panel !== null && !info.panels.some((p) => p.id === c.panel))
      .map((c) => ({ key: `?${c.panel}`, name: <>{c.panel} <span className="muted small">– нет такой панели</span></>, c })),
  ];
  const direct = byCode.get(null);
  if (direct || info.panels.length === 0) rows.push({ key: '-', name: <span className="muted">Прямая ссылка (без панели)</span>, c: direct });
  const n = (c: PanelCounts | undefined, st: string) => c?.statuses[st] ?? 0;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table sources">
        <thead>
          <tr>
            <th>Источник</th><th>Начали</th><th>Завершили</th><th>Отсеяны</th><th>Сверх квоты</th><th title="В процессе и завершили досрочно">Бросили</th>
            <th title="Завершили / начали">Конверсия</th><th title="Завершили / (завершили + отсеяны)">Инцидентность</th><th title="Медиана длительности завершённых">Время</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, c, limit, closed }) => {
            const started = Object.values(c?.statuses ?? {}).reduce((a, b) => a + b, 0);
            const done = n(c, 'completed');
            return (
              <tr key={key}>
                <td>{name}{closed && <span className="badge status-processing" style={{ marginLeft: 6 }}>стоп</span>}</td>
                <td>{started}</td>
                <td>{done}{limit ? <span className="muted"> / {limit}</span> : null}</td>
                <td>{n(c, 'screened_out')}</td>
                <td>{n(c, 'overquota')}</td>
                <td>{n(c, 'in_progress') + n(c, 'terminated')}</td>
                <td>{pct(done, started)}</td>
                <td>{pct(done, done + n(c, 'screened_out'))}</td>
                <td>{fmtDuration(c?.medianSec ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
