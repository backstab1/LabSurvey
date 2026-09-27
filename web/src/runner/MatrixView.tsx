// Матрица: таблица на широком экране, карточки по строкам на телефоне
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rich } from './rich.tsx';
import type { Answer, MatrixQuestion, Option } from '../../../shared/types.ts';
import { OtherInput } from './OtherInput.tsx';

export function Matrix({ q, rows, answer, onChange }: { q: MatrixQuestion; rows: Option[]; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number | number[]>;
  const others = answer?.o ?? {};
  const emit = (nv: Record<string, number | number[]>, no: Record<string, string>) => {
    const cleanV = Object.fromEntries(Object.entries(nv).filter(([, x]) => !(Array.isArray(x) && x.length === 0)));
    const cleanO = Object.fromEntries(Object.entries(no).filter(([, t]) => t));
    if (!Object.keys(cleanV).length && !Object.keys(cleanO).length) return onChange(undefined);
    onChange({ v: cleanV, o: cleanO });
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  // Столбцы «общий для всей таблицы» — отдельными вариантами под таблицей
  const sharedCols = q.columns.filter((c) => c.shared);
  const columns = sharedCols.length ? q.columns.filter((c) => !c.shared) : q.columns;
  // Заголовки групп строк — только подписи; отвечают в остальных строках
  const choiceRows = rows.filter((r) => !r.group);
  const plainRows = choiceRows.filter((r) => !r.other);
  /** Заголовок группы, к которой относится строка (для карусели) */
  const groupHead = (r: Option): Option | undefined => {
    let head: Option | undefined;
    for (const x of rows) {
      if (x.group) head = x;
      else if (x.code === r.code) return head && !head.groupHidden ? head : undefined;
    }
    return undefined;
  };
  const sharedOn = (c: Option) => plainRows.length > 0 && plainRows.every((r) => {
    const x = v[String(r.code)];
    return Array.isArray(x) ? x.includes(c.code) : x === c.code;
  });
  const toggleShared = (c: Option) => {
    if (sharedOn(c)) return emit(Object.fromEntries(Object.entries(v).filter(([k]) => !plainRows.some((r) => String(r.code) === k))), others);
    const nv: Record<string, number | number[]> = {};
    for (const r of plainRows) nv[String(r.code)] = q.mode === 'single' ? c.code : [c.code];
    emit(nv, others);
  };
  const pick = (row: number, col: number) => {
    const key = String(row);
    // Выбор в таблице снимает общий вариант во всех строках
    if (sharedCols.some((c) => sharedOn(c))) {
      const nv: Record<string, number | number[]> = { [key]: q.mode === 'single' ? col : [col] };
      return emit(nv, others);
    }
    if (q.mode === 'single') {
      const firstTime = v[key] === undefined;
      emit({ ...v, [key]: col }, others);
      if (firstTime && window.matchMedia('(max-width: 640px)').matches) {
        const next = plainRows.find((r) => r.code !== row && v[String(r.code)] === undefined);
        if (next) setTimeout(() => wrapRef.current?.querySelector(`[data-row="${next.code}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
      }
      return;
    }
    const cur = (v[key] as number[] | undefined) ?? [];
    emit({ ...v, [key]: cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col] }, others);
  };
  const isOn = (row: number, col: number) => {
    const x = v[String(row)];
    return Array.isArray(x) ? x.includes(col) : x === col;
  };
  const answered = (r: Option) => {
    const x = v[String(r.code)];
    return x !== undefined && (!Array.isArray(x) || x.length > 0);
  };
  const rowLabel = (r: Option): ReactNode => (r.other
    ? <OtherInput opt={r} placeholder={r.text} value={others[r.code] ?? ''} onChange={(t) => emit(v, { ...others, [r.code]: t })} />
    : r.text);
  const sharedBlock = sharedCols.length > 0 && (
    <div className={`options matrix-shared${q.hideMarker ? ' no-marker' : ''}`}>
      {sharedCols.map((c) => (
        <label key={c.code} className={`option${sharedOn(c) ? ' selected' : ''}`}>
          <span className="opt-line">
            <input type="checkbox" checked={sharedOn(c)} onChange={() => toggleShared(c)} />
            <span>{rich(c.text)}</span>
          </span>
        </label>
      ))}
    </div>
  );
  const cell = (r: Option, c: Option, label: string): ReactNode => (
    <label className={`cell${isOn(r.code, c.code) ? ' selected' : ''}`}>
      <input type={q.mode === 'single' ? 'radio' : 'checkbox'} name={`${q.id}_${r.code}`}
        checked={isOn(r.code, c.code)} onChange={() => pick(r.code, c.code)} />
      <span className="cell-label">{label}</span>
    </label>
  );

  const markerCls = q.hideMarker ? ' no-marker' : '';
  if (q.carousel) {
    return (
      <div className={markerCls.trim() || undefined}>
        <MatrixCarousel q={q} columns={columns} rows={choiceRows} rowLabel={(r) => {
          const head = groupHead(r);
          return head ? <><div className="matrix-group-label">{rich(head.text)}</div>{rowLabel(r)}</> : rowLabel(r);
        }} cell={cell} answered={answered} />
        {sharedBlock}
      </div>
    );
  }

  // Постепенный показ: строки до первой неотвеченной (строки «Другое» не останавливают)
  let shownRows = rows;
  if (q.progressiveRows) {
    const firstOpen = rows.findIndex((r) => !r.group && !r.other && !answered(r));
    if (firstOpen >= 0) shownRows = rows.slice(0, firstOpen + 1);
  }
  const cls = `matrix${q.verticalHeaders ? ' vertical-headers' : ''}${markerCls}`;

  if (q.transpose) {
    return (
      <>
      <div className="matrix-wrap">
        <table className={cls}>
          <thead>
            <tr><th />{shownRows.filter((r) => !r.group).map((r) => <th key={r.code} scope="col"><span>{rowLabel(r)}</span></th>)}</tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.code}>
                <th scope="row">{c.text}</th>
                {shownRows.filter((r) => !r.group).map((r) => <td key={r.code}>{cell(r, c, r.other ? others[r.code] || r.text : r.text)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sharedBlock}
      </>
    );
  }

  return (
    <>
    <div className="matrix-wrap" ref={wrapRef}>
      <table className={cls}>
        <thead>
          <tr><th />{columns.map((c) => <th key={c.code} scope="col"><span>{c.text}</span></th>)}</tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (r.group ? (r.groupHidden ? null : (
            <tr key={`g${r.code}`} className="matrix-group">
              <th scope="rowgroup" colSpan={columns.length + 1}>{rich(r.text)}</th>
            </tr>
          )) : (
            <tr key={r.code} className={`fade-in${answered(r) ? ' answered' : r.other ? '' : ' unanswered'}`} data-row={r.code}>
              <th scope="row">{rowLabel(r)}</th>
              {columns.map((c) => <td key={c.code}>{cell(r, c, c.text)}</td>)}
            </tr>
          )))}
        </tbody>
      </table>
    </div>
    {sharedBlock}
    </>
  );
}

export function MatrixCarousel({ q, columns, rows, rowLabel, cell, answered }: {
  q: MatrixQuestion;
  columns: Option[];
  rows: Option[];
  rowLabel: (r: Option) => ReactNode;
  cell: (r: Option, c: Option, label: string) => ReactNode;
  answered: (r: Option) => boolean;
}) {
  const [idx, setIdx] = useState(() => Math.max(0, rows.findIndex((r) => !answered(r))));
  const i = Math.min(idx, rows.length - 1);
  const row = rows[i];
  const done = row ? answered(row) : false;
  // В режиме «один ответ» после ответа в строке — переход к следующей
  const [wasDone, setWasDone] = useState(done);
  useEffect(() => { setWasDone(rows[i] ? answered(rows[i]) : false); /* eslint-disable-next-line */ }, [i]);
  useEffect(() => {
    if (done && !wasDone && q.mode === 'single' && !row?.other && i < rows.length - 1) {
      const t = setTimeout(() => setIdx(i + 1), 250);
      return () => clearTimeout(t);
    }
  }, [done, wasDone, q.mode, row, i, rows.length]);
  if (!row) return null;
  return (
    <div className="carousel">
      <div className="carousel-head">
        <button type="button" className="icon-btn" disabled={i === 0} onClick={() => setIdx(i - 1)} aria-label="Предыдущая строка">‹</button>
        <div className="carousel-dots">
          {rows.map((r, k) => (
            <button type="button" key={r.code} className={`dot${k === i ? ' current' : ''}${answered(r) ? ' done' : ''}`}
              onClick={() => setIdx(k)} aria-label={`Строка ${k + 1}`} />
          ))}
        </div>
        <button type="button" className="icon-btn" disabled={i === rows.length - 1} onClick={() => setIdx(i + 1)} aria-label="Следующая строка">›</button>
      </div>
      <div className="carousel-row">{rowLabel(row)}</div>
      <div className="options">
        {columns.map((c) => <div key={c.code} className="carousel-cell">{cell(row, c, c.text)}</div>)}
      </div>
    </div>
  );
}
