import { useState } from 'react';
import { ConditionEditor, describeCondition } from './ConditionEditor.tsx';
import { Segmented } from './common.tsx';
import { allOptions, allQuestions, allRows } from '../../../shared/logic.ts';
import { END, SCREENOUT, type Action, type Option, type Question, type Survey } from '../../../shared/types.ts';

type Phase = 'before' | 'after';

const LABELS: Record<Phase, [Action['do'], string][]> = {
  before: [
    ['hideOptions', 'Скрыть варианты'],
    ['showOnlyOptions', 'Показать только варианты'],
    ['hideOptionsFrom', 'Скрыть варианты по другому вопросу'],
    ['skipIfFewer', 'Пропустить, если вариантов меньше'],
    ['answer', 'Отметить ответ и не показывать'],
    ['setValue', 'Записать в переменную'],
  ],
  after: [
    ['goTo', 'Перейти к вопросу / блоку'],
    ['end', 'Завершить анкету'],
    ['screenout', 'Отсеять (скринаут)'],
    ['setValue', 'Записать в переменную'],
    ['error', 'Показать ошибку и не пускать дальше'],
  ],
};

const OPTION_ACTIONS: Action['do'][] = ['hideOptions', 'showOnlyOptions', 'hideOptionsFrom', 'skipIfFewer'];

export function actionLabel(a: Action, q?: Question): string {
  const all = [...LABELS.before, ...LABELS.after];
  let label = all.find(([k]) => k === a.do)?.[1] ?? a.do;
  if (q?.type === 'matrix') label = label.replace('вариант', 'строк');
  return label;
}

/** Краткое описание списка действий: «если Q1 = Да → Перейти к Q5; …» */
export function describeActions(def: Survey, q: Question, list: Action[] | undefined): string {
  if (!list?.length) return '';
  return list.map((a) => {
    const cond = a.if ? `если ${describeCondition(def, a.if)} → ` : '';
    const target = a.do === 'goTo' || a.do === 'setValue' ? ` ${a.target ?? ''}` : '';
    return `${cond}${actionLabel(a, q)}${target}`;
  }).join('; ');
}

export function ActionsEditor({ def, q, phase, value, onChange, onCreateVar }: {
  def: Survey;
  q: Question;
  phase: Phase;
  value: Action[] | undefined;
  onChange: (v: Action[] | undefined) => void;
  /** Создать скрытую переменную и вернуть её ID */
  onCreateVar: () => string;
}) {
  const list = value ?? [];
  const hasChoices = ['single', 'multi', 'dropdown', 'matrix'].includes(q.type);
  const kinds = LABELS[phase].filter(([k]) => hasChoices || !OPTION_ACTIONS.includes(k));
  const set = (i: number, a: Action) => onChange(list.map((x, k) => (k === i ? a : x)));
  const move = (i: number, dir: -1 | 1) => {
    const next = list.slice();
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };

  return (
    <div className="actions">
      {list.map((a, i) => (
        <ActionRow key={i} def={def} q={q} a={a} kinds={kinds} onChange={(na) => set(i, na)} onCreateVar={onCreateVar}
          tools={<>
            <button className="icon-btn" title="Выше" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="icon-btn" title="Ниже" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="icon-btn" title="Удалить действие" onClick={() => {
              const next = list.filter((_, k) => k !== i);
              onChange(next.length ? next : undefined);
            }}>✕</button>
          </>} />
      ))}
      <button className="btn-link" onClick={() => {
        const first: Action = phase === 'after'
          ? { if: q.type !== 'info' ? { q: q.id, op: 'answered' } : undefined, do: 'goTo' }
          : { do: kinds[0][0] };
        onChange([...list, first]);
      }}>+ действие</button>
    </div>
  );
}

function ActionRow({ def, q, a, kinds, onChange, onCreateVar, tools }: {
  def: Survey; q: Question; a: Action; kinds: [Action['do'], string][];
  onChange: (a: Action) => void; onCreateVar: () => string; tools: React.ReactNode;
}) {
  const [editCond, setEditCond] = useState(false);
  const set = (patch: Partial<Action>) => {
    const next = { ...a, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as unknown as Action);
  };
  const ownOptions: Option[] = q.type === 'matrix' ? allRows(def, q) : allOptions(def, q);
  const questions = allQuestions(def);
  const hiddenVars = questions.filter((x) => x.type === 'hidden');
  const selfIdx = questions.findIndex((x) => x.id === q.id);

  return (
    <div className="action">
      <div className="action-main">
        <button type="button" className={`cond-chip${a.if ? ' on' : ''}`} onClick={() => setEditCond(!editCond)} title="Условие действия">
          {a.if ? `если ${describeCondition(def, a.if)}` : 'всегда'}
        </button>
        <span className="arrow">→</span>
        <select className="input action-kind" value={a.do}
          onChange={(e) => onChange({ ...(a.if ? { if: a.if } : {}), do: e.target.value as Action['do'] })}>
          {kinds.map(([k, label]) => <option key={k} value={k}>{q.type === 'matrix' ? label.replace('вариант', 'строк') : label}</option>)}
        </select>
        <span className="row-tools">{tools}</span>
      </div>

      {/* Параметры действия */}
      {(a.do === 'hideOptions' || a.do === 'showOnlyOptions') && (
        <CodePick options={ownOptions} value={a.codes ?? []} onChange={(codes) => set({ codes })} />
      )}
      {a.do === 'hideOptionsFrom' && (
        <div className="action-params">
          <Segmented value={a.filter ?? 'selected'} onChange={(filter) => set({ filter: filter === 'selected' ? undefined : filter })}
            options={[{ value: 'selected', label: 'выбранные в' }, { value: 'notSelected', label: 'не выбранные в' }]} />
          <select className="input" value={a.question ?? ''} onChange={(e) => set({ question: e.target.value || undefined })}>
            <option value="">— вопрос —</option>
            {questions.slice(0, Math.max(0, selfIdx)).filter((x) => ['single', 'multi', 'dropdown', 'matrix'].includes(x.type))
              .map((x) => <option key={x.id} value={x.id}>{x.id} · {x.text.slice(0, 40)}</option>)}
          </select>
        </div>
      )}
      {a.do === 'skipIfFewer' && (
        <div className="action-params">
          <span className="muted small">меньше</span>
          <input className="input mini" type="number" min={1} value={a.n ?? 2} onChange={(e) => set({ n: Math.max(1, Number(e.target.value) || 1) })} />
          <span className="muted small">{q.type === 'matrix' ? 'строк' : 'вариантов'}</span>
        </div>
      )}
      {a.do === 'answer' && (
        <div className="action-params">
          {q.type === 'single' || q.type === 'dropdown' ? (
            <select className="input" value={a.value === undefined ? '' : String(a.value)}
              onChange={(e) => set({ value: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">единственный оставшийся вариант</option>
              {ownOptions.map((o) => <option key={o.code} value={o.code}>{o.code} · {o.text}</option>)}
            </select>
          ) : q.type === 'multi' ? (
            <>
              <span className="muted small">{Array.isArray(a.value) && a.value.length ? 'варианты:' : 'единственный оставшийся или:'}</span>
              <CodePick options={ownOptions} value={Array.isArray(a.value) ? a.value : []} onChange={(codes) => set({ value: codes.length ? codes : undefined })} />
            </>
          ) : (
            <input className="input" placeholder="значение ответа" value={a.value === undefined ? '' : String(a.value)}
              onChange={(e) => set({ value: e.target.value === '' ? undefined : q.type === 'number' || q.type === 'scale' ? Number(e.target.value) : e.target.value })} />
          )}
        </div>
      )}
      {a.do === 'setValue' && (
        <div className="action-params">
          <select className="input" value={a.target ?? ''} onChange={(e) => {
            if (e.target.value === '__new') set({ target: onCreateVar() });
            else set({ target: e.target.value || undefined });
          }}>
            <option value="">— переменная —</option>
            {hiddenVars.map((h) => <option key={h.id} value={h.id}>{h.id}{h.text ? ` · ${h.text}` : ''}</option>)}
            <option value="__new">+ новая скрытая переменная</option>
          </select>
          <span className="muted small">=</span>
          <input className="input" placeholder="значение, можно {{Q1}}" value={a.value === undefined ? '' : String(a.value)}
            onChange={(e) => set({ value: e.target.value === '' ? undefined : e.target.value })} />
        </div>
      )}
      {a.do === 'goTo' && (
        <div className="action-params">
          <select className="input" value={a.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })}>
            <option value="">— куда —</option>
            {def.blocks.map((b, bi) => {
              const later = b.questions.filter((x) => questions.indexOf(x) > selfIdx && x.type !== 'hidden');
              if (!later.length) return null;
              const whole = questions.indexOf(b.questions[0]) > selfIdx;
              return (
                <optgroup key={b.id} label={b.title || `Блок ${bi + 1}`}>
                  {whole && <option value={b.id}>↳ в начало блока «{b.title || b.id}»</option>}
                  {later.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.text.slice(0, 50)}</option>)}
                </optgroup>
              );
            })}
            {a.target && ![...questions.map((x) => x.id), ...def.blocks.map((b) => b.id), END, SCREENOUT].includes(a.target) && <option value={a.target}>{a.target}</option>}
          </select>
        </div>
      )}
      {a.do === 'error' && (
        <div className="action-params">
          <input className="input" placeholder="Текст ошибки для респондента" value={a.message ?? ''} onChange={(e) => set({ message: e.target.value || undefined })} />
        </div>
      )}

      {editCond && (
        <div className="action-cond">
          <ConditionEditor def={def} value={a.if} suggest={q.type !== 'info' && q.type !== 'hidden' ? q.id : undefined}
            onChange={(c) => set({ if: c })} />
          <button className="btn-link" onClick={() => setEditCond(false)}>свернуть</button>
        </div>
      )}
    </div>
  );
}

function CodePick({ options, value, onChange }: { options: Option[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="multi-pick action-params">
      {options.length === 0 && <span className="muted small">нет вариантов</span>}
      {options.map((o) => {
        const on = value.includes(o.code);
        return (
          <label key={o.code} className={on ? 'on' : ''} title={o.text}>
            <input type="checkbox" checked={on} style={{ display: 'none' }}
              onChange={() => onChange(on ? value.filter((c) => c !== o.code) : [...value, o.code])} />
            {o.code} · {o.text.length > 24 ? o.text.slice(0, 23) + '…' : o.text}
          </label>
        );
      })}
    </div>
  );
}
