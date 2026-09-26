import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { QUESTION_TYPE_LABELS } from '../../../shared/types.ts';
import { STATUS_LABELS, type ResponseStatus } from '../../../shared/variables.ts';
import type { QuestionReport, Report, ReportRow } from '../../../shared/report.ts';
import type { ProjectInfo } from './ProjectPage.tsx';
import { ConditionEditor, defaultCondition, describeCondition } from './ConditionEditor.tsx';
import type { Condition } from '../../../shared/types.ts';

const STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'overquota', 'terminated', 'in_progress'];

/** Топлайн: распределения по каждому вопросу — чтобы видеть результаты, не выгружая данные */
export function ReportTab({ info }: { info: ProjectInfo }) {
  const [statuses, setStatuses] = useState<ResponseStatus[]>(['completed']);
  const [test, setTest] = useState(!info.published);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Condition | undefined>();
  const def = test ? info.draft : info.published ?? info.draft;
  // Неполное условие (пустое значение) не отправляем, пока его не допишут
  const filterJson = filter && !JSON.stringify(filter).includes('"value":""') ? JSON.stringify(filter) : '';

  useEffect(() => {
    setError('');
    api<Report>('GET', `/api/admin/projects/${info.id}/report?statuses=${statuses.join(',')}${test ? '&test=1' : ''}${filterJson ? `&filter=${encodeURIComponent(filterJson)}` : ''}`)
      .then(setReport).catch((e) => setError((e as Error).message));
  }, [info.id, statuses, test, info.counts, filterJson]);

  return (
    <div className="stack report">
      <div className="card row report-filters">
        {STATUSES.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={statuses.includes(s)}
              onChange={(e) => setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s))} />
            {STATUS_LABELS[s]}
          </label>
        ))}
        <span className="grow" />
        {!filter && (
          <button className="btn btn-secondary btn-sm" title="Например, только мужчины или только из VK"
            onClick={() => setFilter(defaultCondition(def))}>+ Подгруппа</button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => window.print()} title="Печать или сохранение в PDF">Печать / PDF</button>
        <label className="check" title="Отчёт по тестовым ответам черновика (предпросмотр, тестовое заполнение)">
          <input type="checkbox" checked={test} onChange={(e) => setTest(e.target.checked)} />Тестовые ответы
        </label>
      </div>
      {filter && (
        <div className="card stack report-filter">
          <div className="row">
            <strong className="grow">Подгруппа</strong>
            <button className="btn-link" onClick={() => setFilter(undefined)}>убрать фильтр</button>
          </div>
          <ConditionEditor def={def} value={filter} required onChange={(c) => setFilter(c)} />
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      {report && (
        report.total === 0 ? (
          <div className="card muted">Нет ответов с выбранными статусами{test ? ' среди тестовых' : ''}.</div>
        ) : (
          <>
            <div className="muted small">
              Анкет в отчёте: <strong>{report.total}</strong>{filterJson ? <> · подгруппа: {describeCondition(def, filter)}</> : null}. Проценты — от ответивших на вопрос.
            </div>
            {report.questions.map((q) => <QuestionBlock key={q.id} q={q} projectId={info.id} />)}
          </>
        )
      )}
      {report && report.dropOff.length > 0 && (
        <div className="card stack">
          <h2>Где остановились незавершённые</h2>
          <p className="muted small" style={{ margin: 0 }}>Не дошедшие до конца и завершившие досрочно — по вопросу, на котором остановились.</p>
          <Bars rows={report.dropOff.map((d) => ({ label: `${d.id} · ${d.text}`, count: d.count, pct: 0 }))} counts />
        </div>
      )}
    </div>
  );
}

function QuestionBlock({ q, projectId }: { q: QuestionReport; projectId: string }) {
  return (
    <div className="card stack report-q">
      <div className="report-q-head">
        <span className="qid">{q.id}</span>
        <span className="muted small">{QUESTION_TYPE_LABELS[q.type]}</span>
        <span className="grow" />
        <span className="muted small">ответили: {q.n}</span>
      </div>
      {q.text && <div className="report-q-text">{q.text}</div>}
      {q.nps && (
        <div className="nps">
          <strong>NPS {q.nps.score > 0 ? '+' : ''}{q.nps.score}</strong>
          <span className="muted small">сторонники {q.nps.promoters}% · нейтральные {q.nps.passives}% · критики {q.nps.detractors}%</span>
        </div>
      )}
      {q.stats && (
        <div className="report-stats">
          <span>Среднее <strong>{q.stats.mean}</strong></span>
          {q.stats.median !== undefined && <span>Медиана <strong>{q.stats.median}</strong></span>}
          {q.stats.min !== undefined && <span>Мин <strong>{q.stats.min}</strong></span>}
          {q.stats.max !== undefined && <span>Макс <strong>{q.stats.max}</strong></span>}
        </div>
      )}
      {q.rows && <Bars rows={q.rows} note={q.type === 'multi' || q.type === 'hotspot' ? 'Можно было выбрать несколько — сумма больше 100%' : undefined} />}
      {q.means && (
        <table className="table report-table">
          <thead><tr><th>Вариант</th><th>Среднее</th></tr></thead>
          <tbody>{q.means.map((m) => <tr key={m.label}><td>{m.label}</td><td>{m.mean}</td></tr>)}</tbody>
        </table>
      )}
      {q.files && q.files.length > 0 && (
        <div className="report-files">
          {q.files.map((f) => {
            const url = `/api/admin/projects/${projectId}/files/${f.rid}/${f.id}`;
            return /\.(jpg|png|gif|webp)$/.test(f.id)
              ? <a key={`${f.rid}/${f.id}`} href={url} target="_blank" rel="noreferrer" title={f.name}><img src={url} alt={f.name} loading="lazy" /></a>
              : <a key={`${f.rid}/${f.id}`} href={url} className="report-file">📄 {f.name}</a>;
          })}
        </div>
      )}
      {(q.type === 'maxdiff' || q.type === 'conjoint') && (
        <p className="muted small" style={{ margin: 0 }}>Анализ — по выгрузке (выборы по наборам) и файлу дизайна во вкладке «Данные».</p>
      )}
      {q.ranks && (
        <table className="table report-table">
          <thead><tr><th>Вариант</th><th>Средний ранг</th><th>На 1-м месте</th><th>Ранжировали</th></tr></thead>
          <tbody>{q.ranks.map((r) => <tr key={r.label}><td>{r.label}</td><td>{r.n ? r.mean : '—'}</td><td>{r.first}</td><td>{r.n}</td></tr>)}</tbody>
        </table>
      )}
      {q.matrix && (
        <div className="matrix-wrap">
          <table className="table report-table">
            <thead><tr><th />{q.matrix[0]?.cells.map((c) => <th key={c.code}>{c.label}</th>)}<th>n</th></tr></thead>
            <tbody>
              {q.matrix.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {row.cells.map((c) => (
                    <td key={c.code} className="heat" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(c.pct * 0.6)}%, transparent)` }}>
                      {row.n ? `${c.pct}%` : '—'}
                    </td>
                  ))}
                  <td className="muted">{row.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.texts && q.texts.length > 0 && (
        <details className="report-texts">
          <summary>{q.rows || q.matrix ? 'Ответы «Другое»' : 'Последние ответы'} ({q.texts.length}{q.texts.length >= 30 ? '+' : ''})</summary>
          <ul>{q.texts.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function Bars({ rows, note, counts }: { rows: ReportRow[]; note?: string; counts?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => (counts ? r.count : r.pct)));
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label" title={r.label}>{r.code !== undefined && !r.label.startsWith(String(r.code)) && <span className="muted mono">{r.code} </span>}{r.label}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${((counts ? r.count : r.pct) / max) * 100}%` }} /></span>
          <span className="bar-value">{counts ? r.count : `${r.pct}%`}{!counts && <span className="muted"> ({r.count})</span>}</span>
        </div>
      ))}
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}
