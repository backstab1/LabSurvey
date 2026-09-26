import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { SearchSelect, toast } from './common.tsx';
import { ConditionEditor, defaultCondition, describeCondition } from './ConditionEditor.tsx';
import type { ProjectInfo } from './ProjectPage.tsx';
import { allRows } from '../../../shared/logic.ts';
import { expandAllLoops } from '../../../shared/loops.ts';
import { crosstabCandidates, type CrosstabResult, type CrosstabSpec, type CrossTable, type VarRef } from '../../../shared/crosstab.ts';
import { STATUS_LABELS, type ResponseStatus } from '../../../shared/variables.ts';
import type { Condition, Survey } from '../../../shared/types.ts';

export interface TableSet { name: string; spec: CrosstabSpec }
type Measure = 'colPct' | 'count' | 'rowPct';
const MEASURES: [Measure, string][] = [['colPct', '% по столбцу'], ['count', 'Количество'], ['rowPct', '% по строке']];
const STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'overquota', 'terminated', 'in_progress'];

const refKey = (r: VarRef) => (r.param ? `p:${r.param}` : `q:${r.q}${r.row !== undefined ? `:${r.row}` : ''}`);
const keyRef = (k: string): VarRef => {
  const [kind, a, b] = k.split(':');
  return kind === 'p' ? { param: a } : { q: a, ...(b !== undefined ? { row: Number(b) } : {}) };
};
const short = (t: string, n = 70) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const plain = (t: string) => t.replace(/[*_[\]!()]/g, '').replace(/\s+/g, ' ').trim();

function refLabel(def: Survey, r: VarRef): string {
  if (r.param) return `Параметр: ${r.param}`;
  const q = crosstabCandidates(def).rows.find((x) => x.id === r.q);
  if (!q) return `${r.q} (нет в анкете)`;
  if (r.row !== undefined && q.type === 'matrix') {
    const row = allRows(def, q).find((x) => x.code === r.row);
    return `${q.id} — ${short(plain(row?.text ?? String(r.row)), 40)}`;
  }
  return `${q.id}. ${short(plain(q.text), 60)}`;
}

/** Таблицы (кросс-таблицы): строки × шапка, проценты, значимость различий */
export function TablesTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const [spec, setSpec] = useState<CrosstabSpec>(() => info.tableSets[0]?.spec ?? { rows: [], cols: [], statuses: ['completed'], sig: 0.95, test: !info.published });
  const [setName, setSetName] = useState(info.tableSets[0]?.name ?? '');
  const [measures, setMeasures] = useState<Measure[]>(['colPct']);
  const [result, setResult] = useState<CrosstabResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const def = useMemo(() => expandAllLoops(spec.test ? info.draft : info.published ?? info.draft), [spec.test, info.draft, info.published]);
  const cand = useMemo(() => crosstabCandidates(def), [def]);
  const filterOk = !spec.filter || !JSON.stringify(spec.filter).includes('"value":""');
  const specJson = JSON.stringify(spec);

  useEffect(() => {
    if (!spec.rows.length || !filterOk) { setResult(null); return; }
    const t = setTimeout(() => {
      setLoading(true);
      setError('');
      api<CrosstabResult>('GET', `/api/admin/projects/${info.id}/crosstab?spec=${encodeURIComponent(specJson)}`)
        .then(setResult).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specJson, info.id, info.counts]);

  const set = (patch: Partial<CrosstabSpec>) => setSpec({ ...spec, ...patch });
  const qItems = (list: typeof cand.rows, withMatrixRows: boolean) => list.flatMap((q) => [
    { value: `q:${q.id}`, label: `${q.id}. ${short(plain(q.text), 60)}${q.type === 'matrix' ? ' — все строки' : ''}` },
    ...(q.type === 'matrix' && withMatrixRows ? allRows(def, q).filter((r) => !r.group && !r.other)
      .map((r) => ({ value: `q:${q.id}:${r.code}`, label: `${q.id} — ${short(plain(r.text), 50)}` })) : []),
  ]);
  const params = [...new Set([...(result?.params ?? []), ...(info.panels.length ? ['panel'] : [])])];
  const rowGroups = [{ label: 'Вопросы', items: qItems(cand.rows, true) }];
  const colGroups = [
    { label: 'Вопросы', items: qItems(cand.cols.filter((q) => q.type !== 'matrix'), false).concat(qItems(cand.cols.filter((q) => q.type === 'matrix'), true).filter((i) => i.value.split(':').length === 3)) },
    ...(params.length ? [{ label: 'Параметры ссылки', items: params.map((p) => ({ value: `p:${p}`, label: p === 'panel' ? 'panel — панель' : p })) }] : []),
  ];

  const saveSet = async (name: string) => {
    const others = info.tableSets.filter((s) => s.name !== name);
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { tables: [...others, { name, spec }] });
      setSetName(name);
      await reload();
      toast('Набор таблиц сохранён');
    } catch (e) { toast((e as Error).message); }
  };
  const xlsxUrl = `/api/admin/projects/${info.id}/crosstab.xlsx?spec=${encodeURIComponent(specJson)}&measures=${measures.join(',')}`;

  return (
    <div className="stack tables-tab">
      <div className="card stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 className="grow" style={{ margin: 0 }}>Таблицы</h2>
          {info.tableSets.length > 0 && (
            <select className="input" style={{ width: 'auto' }} value={setName} aria-label="Набор таблиц" onChange={(e) => {
              const s = info.tableSets.find((x) => x.name === e.target.value);
              if (s) { setSpec(s.spec); setSetName(s.name); }
            }}>
              {!info.tableSets.some((s) => s.name === setName) && <option value={setName}>— не сохранён —</option>}
              {info.tableSets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </select>
          )}
          {!readOnly && (
            <button className="btn btn-secondary btn-sm" disabled={!spec.rows.length} onClick={() => {
              const name = window.prompt('Название набора таблиц', setName || 'Основные таблицы');
              if (name?.trim()) saveSet(name.trim());
            }}>Сохранить набор</button>
          )}
          {!readOnly && info.tableSets.some((s) => s.name === setName) && (
            <button className="btn-link small" style={{ color: 'var(--danger)' }} onClick={async () => {
              if (!window.confirm(`Удалить набор «${setName}»?`)) return;
              await api('PUT', `/api/admin/projects/${info.id}`, { tables: info.tableSets.filter((s) => s.name !== setName) });
              setSetName('');
              await reload();
            }}>удалить набор</button>
          )}
          {result && result.tables.length > 0 && <a className="btn btn-primary btn-sm" href={xlsxUrl}>Excel</a>}
        </div>

        <div className="grid2">
          <div className="field">
            <span>Строки — что считаем</span>
            <div className="xchips">
              {spec.rows.map((r, i) => (
                <span key={refKey(r)} className="xchip">{refLabel(def, r)}
                  <button className="icon-btn" aria-label="Убрать" onClick={() => set({ rows: spec.rows.filter((_, k) => k !== i) })}>✕</button>
                </span>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <SearchSelect className="grow" value="" groups={rowGroups}
                onChange={(v) => !spec.rows.some((r) => refKey(r) === v) && set({ rows: [...spec.rows, keyRef(v)] })} />
              <button className="btn-link small" onClick={() => set({ rows: cand.rows.filter((q) => q.type !== 'text' && q.type !== 'phone').map((q) => ({ q: q.id })) })}>все вопросы</button>
            </div>
          </div>
          <div className="field">
            <span>Шапка — в каких разрезах<small className="muted"> (столбец «Всего» есть всегда)</small></span>
            <div className="xchips">
              {spec.cols.map((r, i) => (
                <span key={refKey(r)} className="xchip banner">{refLabel(def, r)}
                  <button className="icon-btn" aria-label="Убрать" onClick={() => set({ cols: spec.cols.filter((_, k) => k !== i) })}>✕</button>
                </span>
              ))}
            </div>
            <SearchSelect value="" groups={colGroups}
              onChange={(v) => !spec.cols.some((r) => refKey(r) === v) && set({ cols: [...spec.cols, keyRef(v)] })} />
          </div>
        </div>

        <div className="row report-filters" style={{ flexWrap: 'wrap' }}>
          {MEASURES.map(([m, label]) => (
            <label key={m} className="check">
              <input type="checkbox" checked={measures.includes(m)}
                onChange={(e) => setMeasures(e.target.checked ? MEASURES.map(([x]) => x).filter((x) => x === m || measures.includes(x)) : measures.filter((x) => x !== m).length ? measures.filter((x) => x !== m) : measures)} />
              {label}
            </label>
          ))}
          <label className="row" style={{ gap: 6 }}><span className="muted small">значимость</span>
            <select className="input" style={{ width: 'auto' }} value={String(spec.sig ?? 0.95)} onChange={(e) => set({ sig: Number(e.target.value) })}>
              <option value="0.9">90%</option><option value="0.95">95%</option><option value="0.99">99%</option><option value="0">не проверять</option>
            </select>
          </label>
        </div>
        <div className="row report-filters" style={{ flexWrap: 'wrap' }}>
          {STATUSES.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={(spec.statuses ?? ['completed']).includes(s)}
                onChange={(e) => { const cur = spec.statuses ?? ['completed']; set({ statuses: e.target.checked ? [...cur, s] : cur.filter((x) => x !== s) }); }} />
              {STATUS_LABELS[s]}
            </label>
          ))}
          <span className="grow" />
          {!spec.filter && <button className="btn btn-secondary btn-sm" onClick={() => set({ filter: defaultCondition(def) })}>+ Подгруппа</button>}
          <label className="check"><input type="checkbox" checked={!!spec.test} onChange={(e) => set({ test: e.target.checked })} />Тестовые ответы</label>
        </div>
        {spec.filter && (
          <div className="stack report-filter">
            <div className="row"><strong className="grow">Подгруппа</strong><button className="btn-link" onClick={() => set({ filter: undefined })}>убрать</button></div>
            <ConditionEditor def={def} value={spec.filter} required onChange={(c: Condition | undefined) => set({ filter: c })} />
          </div>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {!spec.rows.length && <div className="card muted">Добавьте вопросы в строки, а в шапку — разрезы (пол, возраст, панель…). Буквы в ячейках — значимые различия между столбцами одной шапки.</div>}
      {loading && !result && <p className="muted">Считаем…</p>}
      {result && (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            Анкет: <strong>{result.total}</strong>{spec.filter && filterOk ? <> · подгруппа: {describeCondition(def, spec.filter)}</> : null}.
            {spec.sig !== 0 && <> Буква в ячейке — значение в этом столбце значимо больше, чем в столбце с этой буквой (та же шапка, {Math.round((spec.sig ?? 0.95) * 100)}%, база от {result.minBase}).</>}
            {' '}Серым — база меньше 30.
          </p>
          {result.tables.map((t) => <XTable key={t.key} t={t} measures={measures} />)}
        </>
      )}
    </div>
  );
}

function XTable({ t, measures }: { t: CrossTable; measures: Measure[] }) {
  const groups: { banner: string; span: number }[] = [];
  for (const c of t.columns) {
    const last = groups[groups.length - 1];
    if (last && last.banner === c.banner && c.banner) last.span++;
    else groups.push({ banner: c.banner, span: 1 });
  }
  const small = (i: number) => t.columns[i].base < 30;
  const fmtPct = (x: number) => `${x.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  return (
    <div className="card xtab-card">
      <div className="xtab-title">{t.title}{t.multi && <span className="muted small"> · несколько ответов, сумма больше 100%</span>}</div>
      <div className="xtab-wrap">
        <table className="xtab">
          <thead>
            {t.columns.length > 1 && (
              <tr><th />{groups.map((g, i) => <th key={i} colSpan={g.span} className="xtab-banner">{g.banner}</th>)}</tr>
            )}
            <tr>
              <th />
              {t.columns.map((c, i) => <th key={i} className={i === 0 ? 'xtab-total' : ''}>{c.label}{c.letter && <span className="xtab-letter">{c.letter}</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="xtab-base">
              <td>База (ответили)</td>
              {t.columns.map((c, i) => <td key={i} className={small(i) ? 'small-base' : ''}>{c.base}</td>)}
            </tr>
            {t.rows.map((r, ri) => (
              <tr key={ri}>
                <td>{r.label}</td>
                {r.cells.map((cell, i) => (
                  <td key={i} className={`${small(i) ? 'small-base' : ''}${i === 0 ? ' xtab-total' : ''}`}>
                    {measures.map((m) => (
                      <Fragment key={m}>
                        <div className={`xtab-${m}`}>
                          {m === 'count' ? cell.count : fmtPct(m === 'colPct' ? cell.colPct : cell.rowPct)}
                          {m === 'colPct' && cell.sig && <sup className="xtab-sig">{cell.sig}</sup>}
                        </div>
                      </Fragment>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
            {t.stats?.map((s) => (
              <tr key={s.label} className="xtab-stat">
                <td>{s.label}</td>
                {s.cells.map((c, i) => (
                  <td key={i} className={`${small(i) ? 'small-base' : ''}${i === 0 ? ' xtab-total' : ''}`}>
                    {c.value === null ? '—' : c.value.toLocaleString('ru-RU')}{c.sig && <sup className="xtab-sig">{c.sig}</sup>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
