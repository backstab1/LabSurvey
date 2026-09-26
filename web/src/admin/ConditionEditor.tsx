import { useEffect, useRef, useState } from 'react';
import { FORMULA_HELP, FormulaError, formatFormula, parseFormula, referencedIds } from '../../../shared/condFormula.ts';
import { allOptions, allQuestions, allRows, findQuestion } from '../../../shared/logic.ts';
import { LOOP_REF, loopLevelsOf, withInstances } from '../../../shared/loops.ts';
import type { Condition, ConditionOp, Option, Question, SimpleCondition, Survey } from '../../../shared/types.ts';

const OP_LABELS: Record<ConditionOp, string> = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  in: 'один из', notIn: 'ни один из',
  contains: 'выбран', notContains: 'не выбран', containsAny: 'выбран любой из', containsAll: 'выбраны все',
  answered: 'есть ответ', notAnswered: 'нет ответа',
};
const ARRAY_OPS: ConditionOp[] = ['in', 'notIn', 'containsAny', 'containsAll'];
const NO_VALUE: ConditionOp[] = ['answered', 'notAnswered'];

function opsFor(q: Question | undefined, isParam: boolean): ConditionOp[] {
  if (isParam) return ['eq', 'neq', 'in', 'notIn', 'answered', 'notAnswered'];
  switch (q?.type) {
    case 'multi':
    case 'hotspot':
    case 'ranking': return ['contains', 'notContains', 'containsAny', 'containsAll', 'answered', 'notAnswered'];
    case 'file': case 'maxdiff': case 'conjoint': return ['answered', 'notAnswered'];
    case 'sum': return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'answered', 'notAnswered'];
    case 'single': case 'dropdown': return ['eq', 'neq', 'in', 'notIn', 'answered', 'notAnswered'];
    case 'matrix': return ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'answered', 'notAnswered'];
    case 'text': case 'phone': return ['eq', 'neq', 'answered', 'notAnswered'];
    default: return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'answered', 'notAnswered'];
  }
}

/** Варианты значений для выбора из списка (если они есть) */
function valueChoices(def: Survey, q: Question | undefined, row: number | undefined): Option[] | null {
  if (!q) return null;
  if (q.type === 'single' || q.type === 'multi' || q.type === 'dropdown' || q.type === 'ranking') return allOptions(def, q);
  if (q.type === 'hotspot') return q.options;
  if (q.type === 'matrix') return row !== undefined ? q.columns : null;
  if (q.type === 'scale') {
    const pts = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
    return [...pts.map((p) => ({ code: p, text: q.labels?.[String(p)] ? `${p} · ${q.labels[String(p)]}` : String(p) })), ...(q.extraOptions ?? [])];
  }
  return null;
}

type Visual = { mode: 'all' | 'any'; items: SimpleCondition[] };

function toVisual(c: Condition | undefined): Visual | null {
  if (!c) return { mode: 'all', items: [] };
  const isSimple = (x: Condition): x is SimpleCondition => !('all' in x) && !('any' in x) && !('not' in x);
  if (isSimple(c)) return { mode: 'all', items: [c] };
  if ('all' in c && c.all.every(isSimple)) return { mode: 'all', items: c.all as SimpleCondition[] };
  if ('any' in c && c.any.every(isSimple)) return { mode: 'any', items: c.any as SimpleCondition[] };
  return null;
}

function fromVisual(v: Visual): Condition | undefined {
  if (v.items.length === 0) return undefined;
  if (v.items.length === 1) return v.items[0];
  return v.mode === 'all' ? { all: v.items } : { any: v.items };
}

/** Условие ещё не дозаполнено (нет значения) — его редактор держим открытым */
export function isIncomplete(c: Condition | undefined): boolean {
  if (!c) return false;
  if ('all' in c) return c.all.some(isIncomplete);
  if ('any' in c) return c.any.some(isIncomplete);
  if ('not' in c) return isIncomplete(c.not);
  if (NO_VALUE.includes(c.op)) return false;
  return c.value === undefined || c.value === '' || (Array.isArray(c.value) && c.value.length === 0);
}

/** Простое условие по вопросу — стартовая точка, которую пользователь потом уточняет */
export function defaultCondition(def: Survey, questionId?: string): SimpleCondition | undefined {
  const q = (questionId && findQuestion(def, questionId)) || allQuestions(def).find((x) => x.type !== 'info');
  if (!q) return undefined;
  const op = opsFor(q, false)[0];
  return { q: q.id, ...(q.type === 'matrix' ? { row: allRows(def, q)[0]?.code } : {}), op, ...(NO_VALUE.includes(op) ? {} : { value: '' }) };
}

type LoopLevel = { ref: string; label: string; items: Option[] };

export function ConditionEditor({ def: baseDef, value, onChange, required, suggest, self }: {
  def: Survey; value: Condition | undefined; onChange: (c: Condition | undefined) => void; required?: boolean;
  /** ID вопроса, который подставляется в новое условие (обычно — предыдущий вопрос) */
  suggest?: string;
  /** Вопрос, к которому относится условие: внутри цикла можно проверять код текущего повтора */
  self?: string;
}) {
  // На копии вопросов из циклов (FREQ_1) тоже можно ссылаться
  const def = withInstances(baseDef);
  const loops: LoopLevel[] = loopLevelsOf(baseDef, self);
  const visual = toVisual(value);
  const [jsonMode, setJsonMode] = useState(visual === null);
  const [jsonText, setJsonText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [jsonError, setJsonError] = useState('');

  const questions = allQuestions(def).filter((q) => q.type !== 'info');

  if (jsonMode || !visual) {
    return (
      <div className="cond cond-json">
        <textarea className="input" rows={5} spellCheck={false} value={jsonText}
          placeholder='{"all": [{"q": "Q1", "op": "eq", "value": 1}, {"not": {"q": "Q2", "op": "answered"}}]}'
          onChange={(e) => {
            setJsonText(e.target.value);
            if (!e.target.value.trim()) { setJsonError(''); if (!required) onChange(undefined); return; }
            try { onChange(JSON.parse(e.target.value)); setJsonError(''); } catch (err) { setJsonError((err as Error).message); }
          }} />
        <div className="cond-foot">
          {jsonError && <span className="field-error">JSON: {jsonError}</span>}
          <span className="grow" />
          {toVisual(value) && <button className="btn-link" onClick={() => setJsonMode(false)}>обычный вид</button>}
        </div>
      </div>
    );
  }

  const setItems = (items: SimpleCondition[], mode = visual.mode) => {
    const c = fromVisual({ mode, items });
    onChange(c);
    setJsonText(c ? JSON.stringify(c, null, 2) : '');
  };

  const addItem = () => {
    const last = visual.items[visual.items.length - 1];
    const q = (last?.q && findQuestion(def, last.q)) || (suggest && findQuestion(def, suggest)) || questions[0];
    const op = opsFor(q, false)[0];
    setItems([...visual.items, q
      ? { q: q.id, ...(q.type === 'matrix' ? { row: allRows(def, q)[0]?.code } : {}), op, ...(NO_VALUE.includes(op) ? {} : { value: '' }) }
      : { param: 'src', op: 'eq', value: '' }]);
  };

  return (
    <div className="cond">
      {visual.items.map((c, i) => (
        <CondRow key={i} def={def} c={c} questions={questions} loops={loops}
          label={i === 0 ? 'если' : visual.mode === 'all' ? 'и' : 'или'}
          onToggleMode={i > 0 ? () => setItems(visual.items, visual.mode === 'all' ? 'any' : 'all') : undefined}
          onChange={(nc) => setItems(visual.items.map((x, k) => (k === i ? nc : x)))}
          onRemove={() => setItems(visual.items.filter((_, k) => k !== i))} />
      ))}
      <div className="cond-foot">
        <button className="btn-link add-link" onClick={addItem}>{visual.items.length ? '+ ещё условие' : '+ условие'}</button>
        <span className="grow" />
        <button className="btn-link json-link" title="Сложное условие с вложенными И / ИЛИ / НЕ — в виде JSON"
          onClick={() => { setJsonText(value ? JSON.stringify(value, null, 2) : ''); setJsonMode(true); }}>{'{ }'}</button>
      </div>
    </div>
  );
}

function CondRow({ def, c, questions, loops, label, onToggleMode, onChange, onRemove }: {
  def: Survey; c: SimpleCondition; questions: Question[]; loops: LoopLevel[]; label: string; onToggleMode?: () => void;
  onChange: (c: SimpleCondition) => void; onRemove: () => void;
}) {
  const isParam = c.param !== undefined;
  const loop = c.q && LOOP_REF.test(c.q) ? loops.find((l) => l.ref === c.q) ?? { ref: c.q, label: c.q, items: [] } : undefined;
  const q = !isParam && !loop && c.q ? findQuestion(def, c.q) : undefined;
  const ops: ConditionOp[] = loop ? ['eq', 'neq', 'in', 'notIn'] : opsFor(q, isParam);
  const choices = loop ? loop.items : valueChoices(def, q, c.row);
  const numeric = q && ['number', 'scale', 'matrix', 'single', 'multi', 'dropdown', 'ranking'].includes(q.type)
    || (q?.type === 'hidden' && q.valueType === 'number');

  const setSource = (src: string) => {
    if (src === '__param') return onChange({ param: '', op: 'eq', value: '' });
    if (LOOP_REF.test(src)) return onChange({ q: src, op: 'eq', value: '' });
    const nq = findQuestion(def, src);
    const op = opsFor(nq, false)[0];
    const row = nq?.type === 'matrix' ? allRows(def, nq)[0]?.code : undefined;
    onChange({ q: src, ...(row !== undefined ? { row } : {}), op, ...(NO_VALUE.includes(op) ? {} : { value: '' }) });
  };
  const setOp = (op: ConditionOp) => {
    const next: SimpleCondition = { ...c, op };
    if (NO_VALUE.includes(op)) delete next.value;
    else if (ARRAY_OPS.includes(op) && !Array.isArray(c.value)) next.value = c.value === '' || c.value === undefined ? [] : [c.value];
    else if (!ARRAY_OPS.includes(op) && Array.isArray(c.value)) next.value = c.value[0] ?? '';
    onChange(next);
  };
  const parse = (s: string) => (numeric && s.trim() !== '' && !isNaN(Number(s)) ? Number(s) : s);
  const short = (t: string, n = 28) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

  return (
    <div className="cond-row">
      {onToggleMode
        ? <button type="button" className="cond-label toggle" title="Переключить И / ИЛИ для всех условий" onClick={onToggleMode}>{label}</button>
        : <span className="cond-label">{label}</span>}
      <div className="cond-fields">
        <select className="input cond-source" value={isParam ? '__param' : c.q ?? ''} onChange={(e) => setSource(e.target.value)}>
          {!isParam && c.q && !q && !loop && <option value={c.q}>{c.q} (нет такого)</option>}
          {(loops.length > 0 || loop) && (
            <optgroup label="Цикл">
              {loops.map((l) => <option key={l.ref} value={l.ref}>↻ {l.label}</option>)}
              {loop && !loops.some((l) => l.ref === loop.ref) && <option value={loop.ref}>{loop.ref} (вне цикла)</option>}
            </optgroup>
          )}
          {questions.map((x) => <option key={x.id} value={x.id}>{x.id}{x.text ? ` · ${short(x.text, 40)}` : ''}</option>)}
          <option value="__param">параметр ссылки…</option>
        </select>
        {isParam && <input className="input cond-param" placeholder="utm_source" value={c.param} onChange={(e) => onChange({ ...c, param: e.target.value.trim() })} />}
        {q?.type === 'matrix' && (
          <select className="input cond-rowsel" value={c.row ?? ''} title="Строка матрицы" onChange={(e) => {
            const next = { ...c };
            if (e.target.value === '') delete next.row; else next.row = Number(e.target.value);
            onChange(next);
          }}>
            <option value="">строка…</option>
            {allRows(def, q).map((r) => <option key={r.code} value={r.code}>{short(r.text)}</option>)}
          </select>
        )}
        <select className="input cond-op" value={c.op} onChange={(e) => setOp(e.target.value as ConditionOp)}>
          {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
        </select>
        {NO_VALUE.includes(c.op) ? null : choices && ARRAY_OPS.includes(c.op) ? (
          <div className="multi-pick cond-value">
            {choices.map((o) => {
              const arr = Array.isArray(c.value) ? (c.value as unknown[]) : [];
              const on = arr.includes(o.code);
              return (
                <label key={o.code} className={on ? 'on' : ''} title={`${o.code} · ${o.text}`}>
                  <input type="checkbox" checked={on} style={{ display: 'none' }}
                    onChange={() => onChange({ ...c, value: on ? arr.filter((x) => x !== o.code) : [...arr, o.code] })} />
                  {short(o.text, 18)}
                </label>
              );
            })}
          </div>
        ) : choices ? (
          <select className="input cond-value" value={String(c.value ?? '')} onChange={(e) => onChange({ ...c, value: e.target.value === '' ? '' : Number(e.target.value) })}>
            <option value="">выберите…</option>
            {choices.map((o) => <option key={o.code} value={o.code}>{short(o.text, 40)}</option>)}
          </select>
        ) : ARRAY_OPS.includes(c.op) ? (
          <input className="input cond-value" placeholder="через запятую" value={Array.isArray(c.value) ? c.value.join(', ') : ''}
            onChange={(e) => onChange({ ...c, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map(parse) })} />
        ) : (
          <input className="input cond-value" value={String(c.value ?? '')} placeholder={q?.type === 'date' ? 'ГГГГ-ММ-ДД' : 'значение'}
            onChange={(e) => onChange({ ...c, value: parse(e.target.value) })} />
        )}
      </div>
      <button className="icon-btn cond-remove" title="Убрать условие" onClick={onRemove}>✕</button>
    </div>
  );
}

/** Короткое описание условия для свёрнутых настроек: «Q1 = Да и S1 ≥ 18» */
export function describeCondition(def: Survey, c: Condition | undefined): string {
  if (!c) return '';
  if ('all' in c) return c.all.map((x) => describeCondition(def, x)).join(' и ');
  if ('any' in c) return c.any.map((x) => describeCondition(def, x)).join(' или ');
  if ('not' in c) return `не (${describeCondition(def, c.not)})`;
  if (c.q && LOOP_REF.test(c.q)) {
    const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value);
    return `повтор цикла${c.q === 'LOOP' ? '' : ` ур. ${c.q.slice(4)}`} ${OP_LABELS[c.op]} ${v}`;
  }
  const full = withInstances(def);
  const q = c.q ? findQuestion(full, c.q) : undefined;
  const subject = c.param !== undefined ? `?${c.param}` : `${c.q ?? '?'}${c.row !== undefined ? `[${c.row}]` : ''}`;
  if (c.op === 'answered' || c.op === 'notAnswered') return `${subject}: ${OP_LABELS[c.op]}`;
  const choices = valueChoices(full, q, c.row);
  const label = (v: unknown) => {
    const o = choices?.find((x) => x.code === v);
    const t = o ? o.text : String(v);
    return t.length > 18 ? t.slice(0, 17) + '…' : t;
  };
  const value = Array.isArray(c.value) ? c.value.map(label).join(', ') : label(c.value);
  return `${subject} ${OP_LABELS[c.op]} ${value}`;
}

/**
 * Условие одной строкой-формулой (Q1 = 1 and S1 >= 18) + кнопка визуального конструктора.
 * Формула и конструктор синхронны: оба меняют одно и то же условие.
 */
export function ConditionField({ def, value, onChange, self, suggest, placeholder = 'например, Q1 = 1', autoFocus }: {
  def: Survey; value: Condition | undefined; onChange: (c: Condition | undefined) => void;
  self?: string; suggest?: string; placeholder?: string; autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatFormula(value));
  const [error, setError] = useState('');
  const [visual, setVisual] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const focused = useRef(false);
  const formatted = formatFormula(value);
  // Условие поменяли снаружи (конструктором) — показываем его формулой
  useEffect(() => { if (!focused.current) { setDraft(formatted); setError(''); } }, [formatted]);

  const known = new Set(allQuestions(withInstances(def)).map((q) => q.id.toLowerCase()));
  const unknown = error ? [] : [...new Set(referencedIds(value))].filter((id) => !LOOP_REF.test(id) && !known.has(id.toLowerCase()));

  return (
    <div className="cond-field">
      <div className="cond-field-row">
        <input className={`input mono${error ? ' invalid' : ''}`} value={draft} placeholder={placeholder} spellCheck={false} autoFocus={autoFocus}
          onFocus={() => { focused.current = true; setHasFocus(true); }}
          onBlur={() => { focused.current = false; setHasFocus(false); if (!error) setDraft(formatted); }}
          onChange={(e) => {
            setDraft(e.target.value);
            try { onChange(parseFormula(e.target.value)); setError(''); } catch (err) {
              if (err instanceof FormulaError) setError(err.message); else throw err;
            }
          }} />
        <button type="button" className={`btn btn-secondary btn-sm cond-visual-btn${visual ? ' on' : ''}`} title="Собрать условие из списков"
          onClick={() => setVisual(!visual)}>{visual ? 'Скрыть конструктор' : 'Конструктор'}</button>
      </div>
      {error ? <span className="field-error">{error}</span>
        : unknown.length ? <span className="field-error">Нет вопроса {unknown.join(', ')}</span>
          : hasFocus ? <span className="field-help">{FORMULA_HELP}</span>
            : value ? <span className="field-help">{describeCondition(def, value)}</span> : null}
      {visual && <ConditionEditor def={def} value={value} self={self} suggest={suggest} onChange={onChange} />}
    </div>
  );
}
