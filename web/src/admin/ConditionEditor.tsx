import { useState } from 'react';
import { allOptions, allRows, findQuestion } from '../../../shared/logic.ts';
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
    case 'multi': return ['contains', 'notContains', 'containsAny', 'containsAll', 'answered', 'notAnswered'];
    case 'single': case 'dropdown': return ['eq', 'neq', 'in', 'notIn', 'answered', 'notAnswered'];
    case 'matrix': return ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'answered', 'notAnswered'];
    case 'text': case 'phone': return ['eq', 'neq', 'answered', 'notAnswered'];
    default: return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'answered', 'notAnswered'];
  }
}

/** Варианты значений для выбора из списка (если они есть) */
function valueChoices(def: Survey, q: Question | undefined, row: number | undefined): Option[] | null {
  if (!q) return null;
  if (q.type === 'single' || q.type === 'multi' || q.type === 'dropdown') return allOptions(def, q);
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

export function ConditionEditor({ def, value, onChange, required }: {
  def: Survey; value: Condition | undefined; onChange: (c: Condition | undefined) => void; required?: boolean;
}) {
  const visual = toVisual(value);
  const [jsonMode, setJsonMode] = useState(visual === null);
  const [jsonText, setJsonText] = useState(value ? JSON.stringify(value, null, 2) : '');
  const [jsonError, setJsonError] = useState('');

  const questions = def.pages.flatMap((p) => p.questions).filter((q) => q.type !== 'info');

  if (jsonMode || !visual) {
    return (
      <div className="cond stack">
        <textarea className="input" rows={6} spellCheck={false} style={{ fontFamily: 'var(--mono)', fontSize: 13 }} value={jsonText}
          placeholder='{"all": [{"q": "Q1", "op": "eq", "value": 1}, {"not": {"q": "Q2", "op": "answered"}}]}'
          onChange={(e) => {
            setJsonText(e.target.value);
            if (!e.target.value.trim()) { setJsonError(''); if (!required) onChange(undefined); return; }
            try { onChange(JSON.parse(e.target.value)); setJsonError(''); } catch (err) { setJsonError((err as Error).message); }
          }} />
        {jsonError && <span style={{ color: 'var(--danger)', fontSize: 13 }}>JSON: {jsonError}</span>}
        {toVisual(value) && <button className="btn-link" style={{ alignSelf: 'flex-start' }} onClick={() => setJsonMode(false)}>Визуальный режим</button>}
      </div>
    );
  }

  const setItems = (items: SimpleCondition[], mode = visual.mode) => {
    const c = fromVisual({ mode, items });
    onChange(c);
    setJsonText(c ? JSON.stringify(c, null, 2) : '');
  };

  const addItem = () => {
    const q = questions[0];
    setItems([...visual.items, q ? { q: q.id, op: opsFor(q, false)[0], ...(NO_VALUE.includes(opsFor(q, false)[0]) ? {} : { value: '' }) } : { param: 'src', op: 'eq', value: '' }]);
  };

  return (
    <div className="cond">
      {visual.items.length === 0 && <div className="muted" style={{ fontSize: 14, marginBottom: 6 }}>{required ? 'Добавьте условие' : 'Всегда'}</div>}
      {visual.items.length > 1 && (
        <select className="input" style={{ width: 'auto', minHeight: 32, marginBottom: 8 }} value={visual.mode}
          onChange={(e) => setItems(visual.items, e.target.value as 'all' | 'any')}>
          <option value="all">Выполнены все условия (И)</option>
          <option value="any">Выполнено любое условие (ИЛИ)</option>
        </select>
      )}
      {visual.items.map((c, i) => (
        <CondRow key={i} def={def} c={c} questions={questions}
          onChange={(nc) => setItems(visual.items.map((x, k) => (k === i ? nc : x)))}
          onRemove={() => setItems(visual.items.filter((_, k) => k !== i))} />
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={addItem}>+ условие</button>
        <button className="btn-link" onClick={() => { setJsonText(value ? JSON.stringify(value, null, 2) : ''); setJsonMode(true); }}>Сложное условие (JSON)</button>
      </div>
    </div>
  );
}

function CondRow({ def, c, questions, onChange, onRemove }: {
  def: Survey; c: SimpleCondition; questions: Question[]; onChange: (c: SimpleCondition) => void; onRemove: () => void;
}) {
  const isParam = c.param !== undefined;
  const q = !isParam && c.q ? findQuestion(def, c.q) : undefined;
  const ops = opsFor(q, isParam);
  const choices = valueChoices(def, q, c.row);
  const numeric = q && ['number', 'scale', 'matrix', 'single', 'multi', 'dropdown'].includes(q.type)
    || (q?.type === 'hidden' && q.valueType === 'number');

  const setSource = (src: string) => {
    if (src === '__param') return onChange({ param: '', op: 'eq', value: '' });
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

  return (
    <div className="cond-row">
      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
        <select className="input" value={isParam ? '__param' : c.q ?? ''} onChange={(e) => setSource(e.target.value)}>
          {!isParam && c.q && !q && <option value={c.q}>{c.q} (нет такого)</option>}
          {questions.map((x) => <option key={x.id} value={x.id}>{x.id}{x.text ? ` · ${x.text.slice(0, 40)}` : ''}</option>)}
          <option value="__param">Параметр ссылки…</option>
        </select>
        {isParam && <input className="input" placeholder="utm_source" value={c.param} onChange={(e) => onChange({ ...c, param: e.target.value.trim() })} />}
      </div>
      {q?.type === 'matrix' ? (
        <select className="input" value={c.row ?? ''} onChange={(e) => {
          const next = { ...c };
          if (e.target.value === '') delete next.row; else next.row = Number(e.target.value);
          onChange(next);
        }}>
          <option value="">(любая строка)</option>
          {allRows(def, q).map((r) => <option key={r.code} value={r.code}>{r.code} · {r.text}</option>)}
        </select>
      ) : <span />}
      <select className="input" value={c.op} onChange={(e) => setOp(e.target.value as ConditionOp)}>
        {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
      </select>
      {NO_VALUE.includes(c.op) ? <span /> : choices && ARRAY_OPS.includes(c.op) ? (
        <div className="multi-pick">
          {choices.map((o) => {
            const arr = Array.isArray(c.value) ? (c.value as unknown[]) : [];
            const on = arr.includes(o.code);
            return (
              <label key={o.code} className={on ? 'on' : ''} title={o.text}>
                <input type="checkbox" checked={on} style={{ display: 'none' }}
                  onChange={() => onChange({ ...c, value: on ? arr.filter((x) => x !== o.code) : [...arr, o.code] })} />
                {o.code}
              </label>
            );
          })}
        </div>
      ) : choices ? (
        <select className="input" value={String(c.value ?? '')} onChange={(e) => onChange({ ...c, value: e.target.value === '' ? '' : Number(e.target.value) })}>
          <option value="">— значение —</option>
          {choices.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.text}</option>)}
        </select>
      ) : ARRAY_OPS.includes(c.op) ? (
        <input className="input" placeholder="через запятую" value={Array.isArray(c.value) ? c.value.join(', ') : ''}
          onChange={(e) => onChange({ ...c, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).map(parse) })} />
      ) : (
        <input className="input" value={String(c.value ?? '')} placeholder={q?.type === 'date' ? 'ГГГГ-ММ-ДД' : 'значение'}
          onChange={(e) => onChange({ ...c, value: parse(e.target.value) })} />
      )}
      <button className="icon-btn" title="Убрать условие" onClick={onRemove}>✕</button>
    </div>
  );
}
