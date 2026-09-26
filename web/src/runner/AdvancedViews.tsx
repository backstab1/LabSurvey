// Слайдер, распределение суммы, загрузка файла, клик по картинке, MaxDiff и конджойнт — у респондента (телефон прежде всего)
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { rich } from './rich.tsx';
import { conjointDesign, conjointShape, maxdiffDesign } from '../../../shared/choiceDesign.ts';
import { fileIds } from '../../../shared/answers.ts';
import type {
  Answer, ConjointQuestion, FileQuestion, HotspotQuestion, MaxDiffQuestion, RespondentContext, SliderQuestion, SumQuestion,
} from '../../../shared/types.ts';

type Change = (a: Answer | undefined) => void;

/** Куда загружать файлы: опрос и сессия респондента */
export const UploadContext = createContext<{ surveyId: string; rid: string } | null>(null);

const unitText = (unit: string | undefined, n: number | string) => (unit ? (unit === '%' ? `${n}%` : `${n} ${unit}`) : String(n));

// ---------- Слайдер ----------

export function Slider({ q, answer, onChange }: { q: SliderQuestion; answer?: Answer; onChange: Change }) {
  const step = q.step ?? 1;
  const snap = (x: number) => Math.min(q.max, Math.max(q.min, q.min + Math.round((x - q.min) / step) * step));
  const v = typeof answer?.v === 'number' ? answer.v : undefined;
  const shown = v ?? snap(q.start ?? (q.min + q.max) / 2);
  const set = (x: number) => onChange({ v: Number(snap(x).toFixed(6)) });
  const pct = ((shown - q.min) / (q.max - q.min)) * 100;
  return (
    <div className={`slider${v === undefined ? ' untouched' : ''}`}>
      <div className="slider-value" aria-live="polite">{v === undefined ? 'Передвиньте ползунок' : unitText(q.unit, v)}</div>
      <input type="range" min={q.min} max={q.max} step={step} value={shown} style={{ ['--fill' as string]: `${pct}%` }}
        aria-valuetext={v === undefined ? 'не выбрано' : unitText(q.unit, v)}
        onChange={(e) => set(Number(e.target.value))}
        // Нажатие без движения на начальном положении — тоже ответ
        onPointerUp={(e) => { if (v === undefined) set(Number((e.target as HTMLInputElement).value)); }}
        onKeyDown={(e) => { if (v === undefined && (e.key === 'Enter' || e.key === ' ')) set(shown); }} />
      <div className="slider-labels">
        <span>{q.minLabel ? rich(q.minLabel) : unitText(q.unit, q.min)}</span>
        {q.midLabel && <span className="mid">{rich(q.midLabel)}</span>}
        <span>{q.maxLabel ? rich(q.maxLabel) : unitText(q.unit, q.max)}</span>
      </div>
    </div>
  );
}

// ---------- Распределение суммы ----------

export function SumInput({ q, answer, onChange }: { q: SumQuestion; answer?: Answer; onChange: Change }) {
  const items = q.options.filter((o) => !o.hidden);
  const total = q.total ?? 100;
  const unit = q.unit ?? '%';
  const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number>;
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])));
  const sum = Object.values(v).reduce((a, b) => a + b, 0);
  const done = (q.mode ?? 'exact') === 'exact' ? Math.abs(sum - total) < 1e-6 : sum <= total + 1e-6;
  const set = (code: number, raw: string) => {
    const text = raw.replace(/[^\d.,]/g, '');
    setDraft({ ...draft, [code]: text });
    const n = Number(text.replace(',', '.'));
    const next = { ...v };
    if (text === '' || !isFinite(n)) delete next[code]; else next[code] = n;
    onChange(Object.keys(next).length ? { v: next } : undefined);
  };
  const rest = Math.round((total - sum) * 100) / 100;
  return (
    <div className="sum-input">
      {items.map((o) => (
        <label key={o.code} className="sum-row">
          <span className="sum-label">{rich(o.text)}</span>
          <span className="sum-field">
            <input className="input" inputMode="decimal" value={draft[o.code] ?? ''} placeholder="0" aria-label={o.text}
              onChange={(e) => set(o.code, e.target.value)} />
            <span className="muted">{unit}</span>
          </span>
        </label>
      ))}
      <div className={`sum-total${done ? ' ok' : sum > total ? ' over' : ''}`} aria-live="polite">
        Итого: {unitText(unit, Math.round(sum * 100) / 100)} из {unitText(unit, total)}
        {!done && rest > 0 && <span> · осталось {unitText(unit, rest)}</span>}
        {sum > total + 1e-6 && <span> · больше на {unitText(unit, Math.round((sum - total) * 100) / 100)}</span>}
      </div>
    </div>
  );
}

// ---------- Загрузка файла ----------

interface Uploaded { id: string; name: string }

export function FileUpload({ q, answer, onChange }: { q: FileQuestion; answer?: Answer; onChange: Change }) {
  const up = useContext(UploadContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const files: Uploaded[] = fileIds(answer?.v).map((id) => ({ id, name: answer?.o?.[id] ?? id }));
  const max = q.maxFiles ?? 1;
  const images = (q.accept ?? 'image') === 'image';
  const emit = (list: Uploaded[]) => onChange(list.length
    ? { v: list.map((f) => f.id).join(','), o: Object.fromEntries(list.map((f) => [f.id, f.name])) }
    : undefined);

  const upload = async (picked: FileList | null) => {
    if (!picked?.length || !up) return;
    setError('');
    setBusy(true);
    let list = files;
    try {
      for (const f of Array.from(picked).slice(0, Math.max(0, max - files.length))) {
        if (f.size > (q.maxSizeMb ?? 10) * 1024 * 1024) { setError(`«${f.name}» больше ${q.maxSizeMb ?? 10} МБ`); continue; }
        const res = await fetch(`/api/s/${up.surveyId}/upload?rid=${encodeURIComponent(up.rid)}&q=${encodeURIComponent(q.id)}`, {
          method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setError(data.error ?? 'Не удалось загрузить файл'); continue; }
        list = [...list, { id: data.id, name: data.name }];
        emit(list);
      }
      if (picked.length > max - files.length) setError(`Можно приложить не больше ${max} файл${max === 1 ? 'а' : 'ов'}`);
    } catch {
      setError('Нет связи — попробуйте ещё раз');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const src = (id: string) => (up ? `/api/s/${up.surveyId}/file?rid=${encodeURIComponent(up.rid)}&f=${encodeURIComponent(id)}` : '');
  const isImage = (id: string) => /\.(jpg|png|gif|webp)$/.test(id);
  return (
    <div className="file-upload">
      {files.length > 0 && (
        <div className="file-list">
          {files.map((f) => (
            <div key={f.id} className="file-item">
              {isImage(f.id) ? <img src={src(f.id)} alt={f.name} /> : <span className="file-icon" aria-hidden>📄</span>}
              <span className="file-name">{f.name}</span>
              <button type="button" className="icon-btn" aria-label={`Убрать ${f.name}`} onClick={() => emit(files.filter((x) => x.id !== f.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {files.length < max && (
        <label className={`btn btn-secondary file-pick${busy ? ' busy' : ''}`}>
          {busy ? 'Загрузка…' : images ? (files.length ? '📷 Добавить ещё фото' : '📷 Сфотографировать или выбрать фото') : (files.length ? 'Добавить ещё файл' : 'Выбрать файл')}
          <input ref={inputRef} type="file" hidden disabled={busy} multiple={max - files.length > 1}
            accept={images ? 'image/*' : 'image/*,.pdf,.docx,.xlsx,.pptx'} onChange={(e) => upload(e.target.files)} />
        </label>
      )}
      <div className="q-hint">
        {images ? 'JPG, PNG, HEIC' : 'Фото, PDF, Word, Excel, PowerPoint'}, до {q.maxSizeMb ?? 10} МБ{max > 1 ? `, не больше ${max} файлов` : ''}
      </div>
      {error && <div className="q-error" role="alert">{error}</div>}
    </div>
  );
}

// ---------- Клик по картинке ----------

export function Hotspot({ q, answer, onChange }: { q: HotspotQuestion; answer?: Answer; onChange: Change }) {
  const v = Array.isArray(answer?.v) ? (answer!.v as number[]) : [];
  const areas = q.options.filter((o) => !o.hidden && o.area);
  const toggle = (code: number) => {
    let next = v.includes(code) ? v.filter((c) => c !== code) : [...v, code];
    if (q.maxSelected === 1 && !v.includes(code)) next = [code];
    else if (q.maxSelected && next.length > q.maxSelected) return;
    onChange(next.length ? { v: next } : undefined);
  };
  return (
    <div className="hotspot">
      <div className={`hotspot-img${q.showAreas ? ' show-areas' : ''}`}>
        <img src={q.image} alt="" draggable={false} />
        {areas.map((o) => (
          <button key={o.code} type="button" className={`hotspot-area${v.includes(o.code) ? ' selected' : ''}`} aria-pressed={v.includes(o.code)}
            aria-label={o.text} title={q.showAreas ? o.text : undefined}
            style={{ left: `${o.area!.x}%`, top: `${o.area!.y}%`, width: `${o.area!.w}%`, height: `${o.area!.h}%` }}
            onClick={() => toggle(o.code)} />
        ))}
      </div>
      <div className="q-hint">
        {v.length ? <>Отмечено: {v.map((c) => areas.find((o) => o.code === c)?.text ?? c).join(', ')}</> : 'Нажмите на картинку, чтобы отметить'}
        {q.maxSelected && q.maxSelected > 1 ? ` (не больше ${q.maxSelected})` : ''}
      </div>
    </div>
  );
}

// ---------- Пошаговый выбор (наборы MaxDiff, задания конджойнта) ----------

function Steps({ count, current, done, label, onGo }: { count: number; current: number; done: (i: number) => boolean; label: string; onGo: (i: number) => void }) {
  return (
    <div className="steps-head">
      <button type="button" className="icon-btn" disabled={current === 0} onClick={() => onGo(current - 1)} aria-label="Назад">‹</button>
      <div className="steps-mid">
        <div className="steps-label">{label} {current + 1} из {count}</div>
        <div className="carousel-dots">
          {Array.from({ length: count }, (_, i) => (
            <button type="button" key={i} className={`dot${i === current ? ' current' : ''}${done(i) ? ' done' : ''}`} onClick={() => onGo(i)} aria-label={`${label} ${i + 1}`} />
          ))}
        </div>
      </div>
      <button type="button" className="icon-btn" disabled={current === count - 1} onClick={() => onGo(current + 1)} aria-label="Дальше">›</button>
    </div>
  );
}

export function MaxDiff({ q, ctx, answer, onChange }: { q: MaxDiffQuestion; ctx: RespondentContext; answer?: Answer; onChange: Change }) {
  const design = useMemo(() => maxdiffDesign(q, ctx.seed), [q, ctx.seed]);
  const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number[]>;
  const [idx, setIdx] = useState(() => Math.max(0, design.findIndex((_, i) => !v[String(i + 1)])));
  const [pending, setPending] = useState<Record<number, [number?, number?]>>({});
  const i = Math.min(idx, design.length - 1);
  const pick = v[String(i + 1)] ?? [];
  const cur: [number?, number?] = pending[i] ?? [pick[0], pick[1]];
  const text = (code: number) => q.options.find((o) => o.code === code)?.text ?? String(code);

  const choose = (kind: 0 | 1, code: number) => {
    const next: [number?, number?] = [...cur];
    next[kind] = code;
    if (next[1 - kind] === code) next[1 - kind] = undefined;
    setPending({ ...pending, [i]: next });
    const out = { ...v };
    if (next[0] !== undefined && next[1] !== undefined) out[String(i + 1)] = [next[0], next[1]];
    else delete out[String(i + 1)];
    onChange(Object.keys(out).length ? { v: out } : undefined);
    // Набор заполнен — к следующему незаполненному
    if (next[0] !== undefined && next[1] !== undefined && i < design.length - 1) {
      setTimeout(() => setIdx((x) => (x === i ? i + 1 : x)), 350);
    }
  };

  return (
    <div className="maxdiff">
      {design.length > 1 && <Steps count={design.length} current={i} label="Набор" done={(k) => !!v[String(k + 1)]} onGo={setIdx} />}
      <table className="maxdiff-table">
        <thead>
          <tr><th>{q.bestLabel ?? 'Наиболее важно'}</th><th /><th>{q.worstLabel ?? 'Наименее важно'}</th></tr>
        </thead>
        <tbody>
          {design[i].map((code) => (
            <tr key={code} className={cur[0] === code ? 'best' : cur[1] === code ? 'worst' : ''}>
              <td><label className="cell"><input type="radio" name={`${q.id}_best_${i}`} checked={cur[0] === code} onChange={() => choose(0, code)} aria-label={`${q.bestLabel ?? 'Наиболее важно'}: ${text(code)}`} /></label></td>
              <td className="maxdiff-item">{rich(text(code))}</td>
              <td><label className="cell"><input type="radio" name={`${q.id}_worst_${i}`} checked={cur[1] === code} onChange={() => choose(1, code)} aria-label={`${q.worstLabel ?? 'Наименее важно'}: ${text(code)}`} /></label></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Conjoint({ q, ctx, answer, onChange }: { q: ConjointQuestion; ctx: RespondentContext; answer?: Answer; onChange: Change }) {
  const design = useMemo(() => conjointDesign(q, ctx.seed), [q, ctx.seed]);
  const { attrs } = useMemo(() => conjointShape(q), [q]);
  const v = (answer?.v && typeof answer.v === 'object' && !Array.isArray(answer.v) ? answer.v : {}) as Record<string, number>;
  const [idx, setIdx] = useState(() => Math.max(0, design.findIndex((_, t) => v[String(t + 1)] === undefined)));
  const t = Math.min(idx, design.length - 1);
  const chosen = v[String(t + 1)];
  const choose = (c: number) => {
    onChange({ v: { ...v, [String(t + 1)]: c } });
    if (t < design.length - 1) setTimeout(() => setIdx((x) => (x === t ? t + 1 : x)), 350);
  };
  useEffect(() => { if (idx >= design.length) setIdx(design.length - 1); }, [idx, design.length]);
  const level = (ai: number, code: number) => attrs[ai].levels.find((l) => l.code === code)?.text ?? String(code);

  return (
    <div className="conjoint">
      {design.length > 1 && <Steps count={design.length} current={t} label="Задание" done={(k) => v[String(k + 1)] !== undefined} onGo={setIdx} />}
      <div className="conjoint-wrap">
        <table className="conjoint-table" style={{ ['--cards' as string]: design[t].length }}>
          <thead>
            <tr><th />{design[t].map((_, k) => <th key={k} className={chosen === k + 1 ? 'chosen' : ''}>Вариант {k + 1}</th>)}</tr>
          </thead>
          <tbody>
            {attrs.map((a, ai) => (
              <tr key={a.id}>
                <th scope="row">{rich(a.text)}</th>
                {design[t].map((card, k) => (
                  <td key={k} className={chosen === k + 1 ? 'chosen' : ''} onClick={() => choose(k + 1)}>{rich(level(ai, card[ai]))}</td>
                ))}
              </tr>
            ))}
            <tr className="conjoint-pick">
              <th />
              {design[t].map((_, k) => (
                <td key={k} className={chosen === k + 1 ? 'chosen' : ''}>
                  <button type="button" className={`btn ${chosen === k + 1 ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={chosen === k + 1} onClick={() => choose(k + 1)}>
                    {chosen === k + 1 ? '✓ Выбрано' : 'Выбрать'}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {q.none && (
        <button type="button" className={`btn conjoint-none ${chosen === 0 ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={chosen === 0} onClick={() => choose(0)}>
          {chosen === 0 ? `✓ ${q.none}` : q.none}
        </button>
      )}
    </div>
  );
}
