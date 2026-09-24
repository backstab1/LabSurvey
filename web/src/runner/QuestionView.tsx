import { useState } from 'react';
import { pipe, resolveOptions, resolveRows } from '../../../shared/logic.ts';
import { isRequired } from '../../../shared/answers.ts';
import type { Answer, MatrixQuestion, Option, Question, RespondentContext, ScaleQuestion } from '../../../shared/types.ts';

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
    return <div className="question info" id={`q-${q.id}`}><div className="q-text">{text}</div></div>;
  }
  return (
    <fieldset className={`question${error ? ' has-error' : ''}`} id={`q-${q.id}`}>
      <legend className="q-text">
        {text}
        {!isRequired(q) && <span className="optional"> (необязательно)</span>}
      </legend>
      {q.hint && <div className="q-hint">{pipe(q.hint, ctx)}</div>}
      <Body q={q} ctx={ctx} answer={answer} onChange={onChange} />
      {error && <div className="q-error" role="alert">{error}</div>}
    </fieldset>
  );
}

function Body({ q, ctx, answer, onChange }: Omit<Props, 'error'>) {
  switch (q.type) {
    case 'single': return <Choice q={q} options={resolveOptions(ctx, q)} multi={false} answer={answer} onChange={onChange} />;
    case 'multi': return <Choice q={q} options={resolveOptions(ctx, q)} multi answer={answer} onChange={onChange} max={q.maxSelected} />;
    case 'dropdown': return <Dropdown options={resolveOptions(ctx, q)} answer={answer} onChange={onChange} />;
    case 'text': return <TextInput multiline={q.multiline} maxLength={q.maxLength} answer={answer} onChange={onChange} />;
    case 'number': return <NumberInput decimals={q.decimals ?? 0} answer={answer} onChange={onChange} />;
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

function Choice({ q, options, multi, answer, onChange, max }: {
  q: Question; options: Option[]; multi: boolean; answer?: Answer; onChange: (a: Answer | undefined) => void; max?: number;
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
  const setOther = (code: number, text: string) => onChange({ v: answer?.v ?? (multi ? [] : code), o: { ...others, [code]: text } });

  const atMax = multi && !!max && selected.length >= max;
  return (
    <div className="options">
      {options.map((o) => {
        const on = selected.includes(o.code);
        return (
          <div key={o.code}>
            <label className={`option${on ? ' selected' : ''}`}>
              <input type={multi ? 'checkbox' : 'radio'} name={q.id} checked={on} disabled={!on && atMax && !o.exclusive}
                onChange={() => toggle(o)} />
              <span>{o.text}</span>
            </label>
            {o.other && on && <OtherInput autoFocus={!others[o.code]} value={others[o.code] ?? ''} onChange={(t) => setOther(o.code, t)} />}
          </div>
        );
      })}
      {multi && max ? <div className="q-hint">Можно выбрать не более {max}</div> : null}
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

function TextInput({ multiline, maxLength, answer, onChange }: { multiline?: boolean; maxLength?: number; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const value = typeof answer?.v === 'string' ? answer.v : '';
  const set = (s: string) => onChange(s ? { v: s } : undefined);
  return (
    <div>
      {multiline
        ? <textarea className="input" rows={4} value={value} maxLength={maxLength} onChange={(e) => set(e.target.value)} />
        : <input className="input" value={value} maxLength={maxLength} onChange={(e) => set(e.target.value)} />}
      {maxLength && <div className="counter">{value.length} / {maxLength}</div>}
    </div>
  );
}

function NumberInput({ decimals, answer, onChange }: { decimals: number; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const [raw, setRaw] = useState(typeof answer?.v === 'number' ? String(answer.v).replace('.', ',') : '');
  return (
    <input className="input input-number" inputMode={decimals > 0 ? 'decimal' : 'numeric'} value={raw}
      onChange={(e) => {
        const s = e.target.value.replace(/[^\d,.\-]/g, '');
        setRaw(s);
        if (!s) return onChange(undefined);
        const n = Number(s.replace(',', '.'));
        onChange({ v: isNaN(n) ? NaN : n });
      }} />
  );
}

function Scale({ q, answer, onChange }: { q: ScaleQuestion; answer?: Answer; onChange: (a: Answer | undefined) => void }) {
  const points = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
  const value = typeof answer?.v === 'number' ? answer.v : null;
  const labels = q.labels ?? {};
  const hasEndLabels = labels[String(q.from)] || labels[String(q.to)];
  const midLabels = points.filter((p) => p !== q.from && p !== q.to && labels[String(p)]);
  return (
    <div className="scale">
      <div className="scale-points" style={{ ['--n' as string]: points.length }}>
        {points.map((p) => (
          <button type="button" key={p} className={`scale-point${value === p ? ' selected' : ''}`} aria-pressed={value === p}
            title={labels[String(p)]} onClick={() => onChange({ v: p })}>{p}</button>
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
  const pick = (row: number, col: number) => {
    const key = String(row);
    if (q.mode === 'single') return emit({ ...v, [key]: col }, others);
    const cur = (v[key] as number[] | undefined) ?? [];
    emit({ ...v, [key]: cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col] }, others);
  };
  const isOn = (row: number, col: number) => {
    const x = v[String(row)];
    return Array.isArray(x) ? x.includes(col) : x === col;
  };

  return (
    <div className="matrix-wrap">
      <table className="matrix" style={{ ['--cols' as string]: q.columns.length }}>
        <thead>
          <tr>
            <th />
            {q.columns.map((c) => <th key={c.code} scope="col">{c.text}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <th scope="row">
                {r.other
                  ? <OtherInput placeholder={r.text} value={others[r.code] ?? ''} onChange={(t) => emit(v, { ...others, [r.code]: t })} />
                  : r.text}
              </th>
              {q.columns.map((c) => (
                <td key={c.code}>
                  <label className={`cell${isOn(r.code, c.code) ? ' selected' : ''}`}>
                    <input type={q.mode === 'single' ? 'radio' : 'checkbox'} name={`${q.id}_${r.code}`}
                      checked={isOn(r.code, c.code)} onChange={() => pick(r.code, c.code)} />
                    <span className="cell-label">{c.text}</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
