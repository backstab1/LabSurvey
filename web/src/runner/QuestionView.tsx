import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pipe, resolveOptions, resolveRows } from '../../../shared/logic.ts';
import { isRequired } from '../../../shared/answers.ts';
import { rich } from './rich.tsx';
import { settingsOf } from '../../../shared/types.ts';
import type { Answer, MatrixQuestion, NumberQuestion, Option, Question, RankingQuestion, RespondentContext, ScaleQuestion, TextQuestion } from '../../../shared/types.ts';

interface Props {
  q: Question;
  ctx: RespondentContext;
  answer: Answer | undefined;
  error?: string;
  onChange: (a: Answer | undefined) => void;
}

export function QuestionView({ q, ctx, answer, error, onChange }: Props) {
  const text = pipe(q.text, ctx);
  if (q.type === 'info') {
    return <div className="question info" id={`q-${q.id}`}><div className="q-text">{rich(text)}</div></div>;
  }
  return (
    <fieldset className={`question${error ? ' has-error' : ''}`} id={`q-${q.id}`}>
      <legend className="q-text">
        {rich(text)}
        {!isRequired(q) && <span className="optional"> (необязательно)</span>}
      </legend>
      {/* Ошибка — сразу под текстом вопроса: на телефоне к ней прокручивается начало вопроса, а не конец длинного списка */}
      {error && <div className="q-error" role="alert">{error}</div>}
      {q.hint && <div className="q-hint">{rich(pipe(q.hint, ctx))}</div>}
      <Body q={q} ctx={ctx} answer={answer} onChange={onChange} />
    </fieldset>
  );
}

function Body({ q, ctx, answer, onChange }: Omit<Props, 'error'>) {
  switch (q.type) {
    case 'single': return <Choice q={q} options={resolveOptions(ctx, q)} multi={false} answer={answer} onChange={onChange} otherAlways={q.showOtherAlways} />;
    case 'multi': return <Choice q={q} options={resolveOptions(ctx, q)} multi answer={answer} onChange={onChange} max={q.maxSelected} otherAlways={q.showOtherAlways} />;
    case 'ranking': return <Ranking q={q} options={resolveOptions(ctx, q)} answer={answer} onChange={onChange} />;
    case 'dropdown': return <Dropdown options={resolveOptions(ctx, q)} answer={answer} onChange={onChange} />;
    case 'text': return <TextInput q={q} noPaste={q.noPaste ?? settingsOf(ctx.survey).noPaste} answer={answer} onChange={onChange} />;
    case 'number': return <NumberInput q={q} answer={answer} onChange={onChange} />;
    case 'scale': return <Scale q={q} answer={answer} onChange={onChange} />;
    case 'matrix': return <Matrix q={q} rows={resolveRows(ctx, q)} answer={answer} onChange={onChange} />;
    case 'date':
      return (
        <input type="date" className="input input-date" min={q.min} max={q.max} value={typeof answer?.v === 'string' ? answer.v : ''}
          onChange={(e) => onChange(e.target.value ? { v: e.target.value } : undefined)} />
      );
    case 'phone': return <PhoneInput format={q.format ?? 'ru'} answer={answer} onChange={onChange} />;
    default: return null;
  }
}

function OtherInput({ value, onChange, placeholder = 'Укажите ваш вариант', autoFocus }: {
  value: string; onChange: (s: string) => void; placeholder?: string; autoFocus?: boolean;
}) {
  return <input className="input other-input" value={value} placeholder={placeholder} maxLength={500} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />;
}

function Choice({ q, options, multi, answer, onChange, max, otherAlways }: {
  q: Question; options: Option[]; multi: boolean; answer?: Answer; onChange: (a: Answer | undefined) => void; max?: number; otherAlways?: boolean;
}) {
  const selected: number[] = multi ? ((answer?.v as number[]) ?? []) : typeof answer?.v === 'number' ? [answer.v] : [];
  const others = answer?.o ?? {};

  const toggle = (o: Option) => {
    if (!multi) return onChange({ v: o.code, o: others });
    let next: number[];
    if (selected.includes(o.code)) next = selected.filter((c) => c !== o.code);
    else if (o.exclusive) next = [o.code];
    else next = [...selected.filter((c) => !options.find((x) => x.code === c)?.exclusive), o.code];
    onChange(next.length ? { v: next, o: others } : undefined);
  };
  // Ввод текста в «Другое» сам отмечает вариант
  const setOther = (code: number, text: string) => {
    let v = answer?.v;
    if (text && !selected.includes(code)) {
      v = multi ? [...selected.filter((c) => !options.find((x) => x.code === c)?.exclusive), code] : code;
    }
    onChange({ v: v ?? (multi ? [] : code), o: { ...others, [code]: text } });
  };

  const atMax = multi && !!max && selected.length >= max;
  // С картинками варианты — карточки в сетке
  const withImages = options.some((o) => o.image);
  const cols = 'columnCount' in q && q.columnCount && q.columnCount > 1 ? q.columnCount : withImages ? 2 : 0;
  return (
    <>
    {multi && <div className="q-hint choice-hint">{max ? `Можно выбрать не более ${max}` : 'Можно выбрать несколько вариантов'}</div>}
    <div className={`options${cols ? ' cols' : ''}`} style={cols ? { ['--cols' as string]: cols } : undefined}>
      {options.map((o) => {
        const on = selected.includes(o.code);
        return (
          <div key={o.code}>
            <label className={`option${on ? ' selected' : ''}${o.image ? ' with-image' : ''}`}>
              {o.image && <img className="opt-img" src={o.image} alt="" loading="lazy" />}
              <span className="opt-line">
                <input type={multi ? 'checkbox' : 'radio'} name={q.id} checked={on} disabled={!on && atMax && !o.exclusive}
                  onChange={() => toggle(o)} />
                <span>{rich(o.text)}</span>
              </span>
            </label>
            {o.other && (on || otherAlways) && <OtherInput autoFocus={on && !others[o.code]} value={others[o.code] ?? ''} onChange={(t) => setOther(o.code, t)} />}
          </div>
        );
      })}
    </div>
    </>
  );
}

/** Ранжирование: нажатие ставит вариант на следующее место, повторное — убирает */
function Ranking({ q, options, answer, onChange }: { q: RankingQuestion; options: Option[]; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const ranked = Array.isArray(answer?.v) ? (answer!.v as number[]) : [];
  const need = Math.min(q.rankCount ?? options.length, options.length);
  const toggle = (code: number) => {
    const i = ranked.indexOf(code);
    if (i >= 0) {
      const next = ranked.filter((c) => c !== code);
      return onChange(next.length ? { v: next } : undefined);
    }
    if (ranked.length >= need) return;
    onChange({ v: [...ranked, code] });
  };
  const move = (code: number, dir: -1 | 1) => {
    const i = ranked.indexOf(code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ranked.length) return;
    const next = ranked.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ v: next });
  };
  const byCode = new Map(options.map((o) => [o.code, o]));
  return (
    <div className="ranking">
      <div className="q-hint">
        {ranked.length < need
          ? `Нажимайте на варианты по порядку: сначала самый важный (${ranked.length} из ${need})`
          : 'Готово. Порядок можно поменять стрелками или снять вариант нажатием'}
      </div>
      {ranked.length > 0 && (
        <ol className="ranked">
          {ranked.map((code, i) => (
            <li key={code}>
              <span className="rank-num">{i + 1}</span>
              <button type="button" className="rank-text" onClick={() => toggle(code)} title="Убрать">{rich(byCode.get(code)?.text ?? String(code))}</button>
              <button type="button" className="rank-move" disabled={i === 0} onClick={() => move(code, -1)} aria-label="Выше">↑</button>
              <button type="button" className="rank-move" disabled={i === ranked.length - 1} onClick={() => move(code, 1)} aria-label="Ниже">↓</button>
            </li>
          ))}
        </ol>
      )}
      <div className="options">
        {options.filter((o) => !ranked.includes(o.code)).map((o) => (
          <button type="button" key={o.code} className="option rank-option" disabled={ranked.length >= need} onClick={() => toggle(o.code)}>
            <span className="rank-slot">{ranked.length + 1}</span><span>{rich(o.text)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Dropdown({ options, answer, onChange }: { options: Option[]; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const value = typeof answer?.v === 'number' ? answer.v : '';
  const opt = options.find((o) => o.code === value);
  return (
    <div>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value === '' ? undefined : { v: Number(e.target.value), o: answer?.o })}>
        <option value="">— выберите —</option>
        {options.map((o) => <option key={o.code} value={o.code}>{o.text}</option>)}
      </select>
      {opt?.other && (
        <OtherInput autoFocus={!answer?.o?.[opt.code]} value={answer?.o?.[opt.code] ?? ''} onChange={(t) => onChange({ v: opt.code, o: { [opt.code]: t } })} />
      )}
    </div>
  );
}

function TextInput({ q, noPaste, answer, onChange }: { q: TextQuestion; noPaste: boolean; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const value = typeof answer?.v === 'string' ? answer.v : '';
  const set = (s: string) => onChange(s ? { v: s } : undefined);
  const block = (e: { preventDefault: () => void }) => e.preventDefault();
  const common = {
    value,
    maxLength: q.maxLength,
    placeholder: q.placeholder,
    onChange: (e: { target: { value: string } }) => set(e.target.value),
    onPaste: noPaste ? block : undefined,
    onDrop: noPaste ? block : undefined,
  };
  if (q.inputType === 'time') return <input className="input input-date" type="time" {...common} />;
  if (q.inputType === 'email') return <input className="input" type="email" inputMode="email" autoComplete="email" {...common} />;
  return (
    <div>
      {q.multiline ? <textarea className="input" rows={q.rows ?? 4} {...common} /> : <input className="input" {...common} />}
      {q.maxLength && <div className="counter">{value.length} / {q.maxLength}</div>}
    </div>
  );
}

function NumberInput({ q, answer, onChange }: { q: NumberQuestion; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const [raw, setRaw] = useState(typeof answer?.v === 'number' ? String(answer.v).replace('.', ',') : '');
  const input = (
    <input className="input input-number" inputMode={(q.decimals ?? 0) > 0 ? 'decimal' : 'numeric'} value={raw} placeholder={q.placeholder}
      onChange={(e) => {
        const s = e.target.value.replace(/[^\d,.\-]/g, '');
        setRaw(s);
        if (!s) return onChange(undefined);
        const n = Number(s.replace(',', '.'));
        onChange({ v: isNaN(n) ? NaN : n });
      }} />
  );
  const range = q.min !== undefined && q.max !== undefined ? `от ${q.min} до ${q.max}`
    : q.min !== undefined ? `не меньше ${q.min}` : q.max !== undefined ? `не больше ${q.max}` : '';
  return (
    <>
      {q.suffix ? <div className="input-suffix">{input}<span>{q.suffix}</span></div> : input}
      {range && <div className="q-hint range-hint">Введите число {range}</div>}
    </>
  );
}

const SMILEYS = ['😠', '🙁', '😐', '🙂', '😀'];

function Scale({ q, answer, onChange }: { q: ScaleQuestion; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const points = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
  const value = typeof answer?.v === 'number' ? answer.v : null;
  const labels = q.labels ?? {};
  const hasEndLabels = labels[String(q.from)] || labels[String(q.to)];
  const midLabels = points.filter((p) => p !== q.from && p !== q.to && labels[String(p)]);
  const display = q.display ?? 'buttons';
  const inScale = value !== null && value >= q.from && value <= q.to;
  const face = (i: number) => SMILEYS[Math.round((i / Math.max(1, points.length - 1)) * (SMILEYS.length - 1))];
  return (
    <div className="scale">
      <div className={`scale-points ${display}`}
        style={{ ['--n' as string]: points.length, ['--nm' as string]: points.length > 7 ? Math.ceil(points.length / 2) : points.length }}>
        {points.map((p, i) => (
          <button type="button" key={p} aria-pressed={value === p} aria-label={labels[String(p)] ? `${p} — ${labels[String(p)]}` : String(p)}
            className={`scale-point${value === p ? ' selected' : ''}${display === 'stars' && inScale && p <= value! ? ' lit' : ''}`}
            title={labels[String(p)] ?? String(p)} onClick={() => onChange({ v: p })}>
            {display === 'stars' ? '★' : display === 'smileys' ? face(i) : p}
          </button>
        ))}
      </div>
      {hasEndLabels && (
        <div className="scale-labels">
          <span>{labels[String(q.from)]}</span>
          <span>{labels[String(q.to)]}</span>
        </div>
      )}
      {midLabels.length > 0 && (
        <div className="q-hint">{midLabels.map((p) => `${p} — ${labels[String(p)]}`).join('; ')}</div>
      )}
      {q.extraOptions?.map((o) => (
        <label key={o.code} className={`option extra${value === o.code ? ' selected' : ''}`}>
          <input type="radio" name={q.id} checked={value === o.code} onChange={() => onChange({ v: o.code })} />
          <span>{o.text}</span>
        </label>
      ))}
    </div>
  );
}

function Matrix({ q, rows, answer, onChange }: { q: MatrixQuestion; rows: Option[]; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number | number[]>;
  const others = answer?.o ?? {};
  const emit = (nv: Record<string, number | number[]>, no: Record<string, string>) => {
    const cleanV = Object.fromEntries(Object.entries(nv).filter(([, x]) => !(Array.isArray(x) && x.length === 0)));
    const cleanO = Object.fromEntries(Object.entries(no).filter(([, t]) => t));
    if (!Object.keys(cleanV).length && !Object.keys(cleanO).length) return onChange(undefined);
    onChange({ v: cleanV, o: cleanO });
  };
  const wrapRef = useRef<HTMLDivElement>(null);
  const pick = (row: number, col: number) => {
    const key = String(row);
    if (q.mode === 'single') {
      const firstTime = v[key] === undefined;
      emit({ ...v, [key]: col }, others);
      if (firstTime && window.matchMedia('(max-width: 640px)').matches) {
        const next = rows.find((r) => r.code !== row && !r.other && v[String(r.code)] === undefined);
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
    ? <OtherInput placeholder={r.text} value={others[r.code] ?? ''} onChange={(t) => emit(v, { ...others, [r.code]: t })} />
    : r.text);
  const cell = (r: Option, c: Option, label: string): ReactNode => (
    <label className={`cell${isOn(r.code, c.code) ? ' selected' : ''}`}>
      <input type={q.mode === 'single' ? 'radio' : 'checkbox'} name={`${q.id}_${r.code}`}
        checked={isOn(r.code, c.code)} onChange={() => pick(r.code, c.code)} />
      <span className="cell-label">{label}</span>
    </label>
  );

  if (q.carousel) return <MatrixCarousel q={q} rows={rows} rowLabel={rowLabel} cell={cell} answered={answered} />;

  // Постепенный показ: строки до первой неотвеченной (строки «Другое» не останавливают)
  let shownRows = rows;
  if (q.progressiveRows) {
    const firstOpen = rows.findIndex((r) => !r.other && !answered(r));
    if (firstOpen >= 0) shownRows = rows.slice(0, firstOpen + 1);
  }
  const cls = `matrix${q.verticalHeaders ? ' vertical-headers' : ''}`;

  if (q.transpose) {
    return (
      <div className="matrix-wrap">
        <table className={cls}>
          <thead>
            <tr><th />{shownRows.map((r) => <th key={r.code} scope="col"><span>{rowLabel(r)}</span></th>)}</tr>
          </thead>
          <tbody>
            {q.columns.map((c) => (
              <tr key={c.code}>
                <th scope="row">{c.text}</th>
                {shownRows.map((r) => <td key={r.code}>{cell(r, c, r.other ? others[r.code] || r.text : r.text)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="matrix-wrap" ref={wrapRef}>
      <table className={cls}>
        <thead>
          <tr><th />{q.columns.map((c) => <th key={c.code} scope="col"><span>{c.text}</span></th>)}</tr>
        </thead>
        <tbody>
          {shownRows.map((r) => (
            <tr key={r.code} className={`fade-in${answered(r) ? ' answered' : r.other ? '' : ' unanswered'}`} data-row={r.code}>
              <th scope="row">{rowLabel(r)}</th>
              {q.columns.map((c) => <td key={c.code}>{cell(r, c, c.text)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixCarousel({ q, rows, rowLabel, cell, answered }: {
  q: MatrixQuestion;
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
        {q.columns.map((c) => <div key={c.code} className="carousel-cell">{cell(row, c, c.text)}</div>)}
      </div>
    </div>
  );
}

function formatRuPhone(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('8') || d.startsWith('7')) d = d.slice(1);
  d = d.slice(0, 10);
  let out = '+7';
  if (d.length) out += ' (' + d.slice(0, 3);
  if (d.length >= 3) out += ')';
  if (d.length > 3) out += ' ' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  if (d.length > 8) out += '-' + d.slice(8, 10);
  return out;
}

function PhoneInput({ format, answer, onChange }: { format: 'ru' | 'international'; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const value = typeof answer?.v === 'string' ? answer.v : '';
  const shown = format === 'ru' && value ? formatRuPhone(value) : value;
  return (
    <input className="input input-phone" type="tel" inputMode="tel" autoComplete="tel"
      placeholder={format === 'ru' ? '+7 (___) ___-__-__' : '+'} value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        const digits = raw.replace(/\D/g, '');
        if (!digits || (format === 'ru' && digits === '7')) return onChange(undefined);
        onChange({ v: format === 'ru' ? formatRuPhone(raw) : '+' + digits });
      }} />
  );
}
