// Живой дашборд для заказчика (/d/<token>): ход сбора и результаты без входа. Обновляется сам раз в минуту.
import '../admin/admin.css';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { DailyChart, QuotaProgress } from '../admin/project/Overview.tsx';
import { QuestionBlock } from '../admin/project/ReportTab.tsx';
import { fmtDate, pct } from '../admin/project/format.ts';
import { PROJECT_STATUS_LABELS } from '../../../shared/types.ts';
import type { DashboardData } from '../../../shared/api.ts';

const REFRESH_MS = 60_000;

export function Dashboard({ token }: { token: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<{ q: string; c: number } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const qs = filter ? `?q=${encodeURIComponent(filter.q)}&c=${filter.c}` : '';
    api<DashboardData>('GET', `/api/dash/${encodeURIComponent(token)}${qs}`)
      .then((d) => { if (alive) { setData(d); setError(''); document.title = d.title; } })
      .catch((e) => { if (alive) setError(e instanceof ApiError && e.status === 404 ? 'Дашборд не найден или выключен. Попросите у команды новую ссылку.' : (e as Error).message); });
    return () => { alive = false; };
  }, [token, filter, tick]);

  // Автообновление, пока вкладка открыта
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) setTick((x) => x + 1); }, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  if (error && !data) return <div className="container dash"><div className="error-box">{error}</div></div>;
  if (!data) return <div className="container dash muted">Загрузка…</div>;

  const c = data.counts;
  const fq = filter ? data.filters.find((f) => f.id === filter.q) : undefined;
  return (
    <div className="container dash stack">
      <header className="dash-head">
        <div className="grow">
          <h1>{data.title}</h1>
          <div className="muted small">
            <span className={`badge status-${data.status}`}>{PROJECT_STATUS_LABELS[data.status]}</span>
            {' '}Обновлено {fmtDate(data.generatedAt)} · обновляется автоматически
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => setTick((x) => x + 1)}>Обновить</button>
      </header>
      {error && <div className="warn-box">Не удалось обновить: {error}</div>}

      <div className="stats">
        <div className="card">
          <div className="stat">{c.completed}{data.target ? <span className="muted" style={{ fontSize: 16 }}> / {data.target}</span> : null}</div>
          <div className="stat-label">Завершили</div>
          {data.target ? <div className="quota-bar" style={{ marginTop: 6 }}><div style={{ width: `${Math.min(100, (c.completed / data.target) * 100)}%` }} className={c.completed >= data.target ? 'full' : ''} /></div> : null}
        </div>
        <div className="card"><div className="stat">{c.screenedOut}</div><div className="stat-label">Не подошли</div></div>
        {c.overquota > 0 && <div className="card"><div className="stat">{c.overquota}</div><div className="stat-label">Сверх квоты</div></div>}
        <div className="card"><div className="stat">{c.started}</div><div className="stat-label">Всего начали</div></div>
        <div className="card"><div className="stat">{pct(c.completed, c.started)}</div><div className="stat-label">Конверсия</div></div>
      </div>

      {data.daily && data.daily.length > 1 && (
        <div className="card stack"><h2 style={{ margin: 0 }}>По дням</h2><DailyChart days={data.daily} /></div>
      )}
      {data.quotas && data.quotas.length > 0 && (
        <div className="card stack"><h2 style={{ margin: 0 }}>Квоты</h2><QuotaProgress quotas={data.quotas} /></div>
      )}
      {data.sources && data.sources.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Источники</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>Источник</th><th>Начали</th><th>Завершили</th><th>Конверсия</th></tr></thead>
              <tbody>{data.sources.map((s) => <tr key={s.title}><td>{s.title}</td><td>{s.started}</td><td>{s.completed}</td><td>{pct(s.completed, s.started)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      {data.report && (
        <>
          <div className="card row dash-filter">
            <h2 className="grow" style={{ margin: 0 }}>Результаты</h2>
            {data.filters.length > 0 && (
              <>
                <select className="input" aria-label="Подгруппа: вопрос" value={filter?.q ?? ''}
                  onChange={(e) => { const f = data.filters.find((x) => x.id === e.target.value); setFilter(f ? { q: f.id, c: f.options[0]?.code } : null); }}>
                  <option value="">Все респонденты</option>
                  {data.filters.map((f) => <option key={f.id} value={f.id}>{f.id}. {f.text.slice(0, 60)}</option>)}
                </select>
                {fq && (
                  <select className="input" aria-label="Подгруппа: ответ" value={filter!.c} onChange={(e) => setFilter({ q: fq.id, c: Number(e.target.value) })}>
                    {fq.options.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                  </select>
                )}
              </>
            )}
          </div>
          <div className="muted small">
            Завершённых анкет в отчёте: <strong>{data.report.total}</strong>{data.filter ? <> · подгруппа: {data.filter.label}</> : null}. Проценты – от ответивших на вопрос.
          </div>
          {data.report.total === 0
            ? <div className="card muted">Пока нет завершённых анкет{data.filter ? ' в этой подгруппе' : ''}.</div>
            : data.report.questions.map((q) => <QuestionBlock key={q.id} q={q} projectId="" />)}
        </>
      )}
      <footer className="muted small dash-foot">SurveyLAB · открытые ответы и персональные данные на этой странице не показываются</footer>
    </div>
  );
}
