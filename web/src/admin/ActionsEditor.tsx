import { useState } from 'react';
import { ConditionField, describeCondition } from './ConditionEditor.tsx';
import { formatFormula } from '../../../shared/condFormula.ts';
import { SearchSelect, Segmented } from './common.tsx';
import { allOptions, allQuestions, allRows } from '../../../shared/logic.ts';
import { END, OPTION_TYPES, SCREENOUT, type Action, type Option, type Question, type Survey } from '../../../shared/types.ts';

type Phase = 'before' | 'after';

const LABELS: Record<Phase, [Action['do'], string][]> = {
  before: [
    ['skip', 'Пропустить вопрос'],
    ['hideOptions', 'Скрыть варианты'],
    ['showOnlyOptions', 'Показать только варианты'],
    ['hideOptionsFrom', 'Скрыть варианты по другому вопросу'],
    ['skipIfFewer', 'Пропустить, если вариантов меньше'],
    ['answer', 'Отметить ответ и не показывать'],
    ['setValue', 'Записать в переменную'],
  ],
  after: [
    ['goTo', 'Перейти к вопросу / блоку'],
    ['skipQuestion', 'Пропустить вопрос'],
    ['markAnswered', 'Пометить вопрос как отвеченный'],
    ['end', 'Завершить анкету'],
    ['screenout', 'Отсеять (скринаут)'],
    ['setValue', 'Записать в переменную'],
    ['error', 'Показать ошибку и не пускать дальше'],
  ],
};

const OPTION_ACTIONS: Action['do'][] = ['hideOptions', 'showOnlyOptions', 'hideOptionsFrom', 'skipIfFewer'];

/** Действия, доступные вопросу на данном этапе */
export function actionKinds(phase: Phase, q: Question): [Action['do'], string][] {
  const hasChoices = OPTION_TYPES.includes(q.type);
  return LABELS[phase]
    .filter(([k]) => hasChoices || !OPTION_ACTIONS.includes(k))
    .filter(([k]) => !(k === 'answer' && (q.type === 'matrix' || q.type === 'ranking')))
    .map(([k, l]) => [k, q.type === 'matrix' ? l.replace('вариант', 'строк') : l]);
}

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
    const target = a.do === 'goTo' || a.do === 'setValue' || a.do === 'skipQuestion' || a.do === 'markAnswered' ? ` ${a.target ?? ''}` : '';
    return `${cond}${actionLabel(a, q)}${target}`;
  }).join('; ');
}

const GROUPS: Record<Action['do'], string> = {
  hideOptions: 'Варианты ответа', showOnlyOptions: 'Варианты ответа', hideOptionsFrom: 'Варианты ответа', skipIfFewer: 'Варианты ответа',
  skip: 'Переходы и пропуск', answer: 'Переходы и пропуск', setValue: 'Переменные',
  goTo: 'Переходы и пропуск', skipQuestion: 'Переходы и пропуск', markAnswered: 'Переходы и пропуск',
  end: 'Завершение', screenout: 'Завершение', error: 'Проверка ответа',
};

/**
 * Список действий как в Survey Studio: строки «Условие → Действие». Клик по строке раскрывает её:
 * условие формулой (или конструктором), выбор действия и его параметры.
 */
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
  const kinds = actionKinds(phase, q);
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, a: Action) => onChange(list.map((x, k) => (k === i ? a : x)));
  const move = (i: number, dir: -1 | 1) => {
    const next = list.slice();
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
    if (open === i) setOpen(i + dir); else if (open === i + dir) setOpen(i);
  };
  const insert = (i: number, a: Action) => {
    const next = list.slice();
    next.splice(i, 0, a);
    onChange(next);
    setOpen(i);
  };
  const remove = (i: number) => {
    const next = list.filter((_, k) => k !== i);
    onChange(next.length ? next : undefined);
    setOpen(open === i ? null : open !== null && open > i ? open - 1 : open);
  };

  return (
    <div className="atable">
      <div className="list-toolbar">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!kinds.length}
          onClick={() => insert(list.length, { do: phase === 'after' ? 'goTo' : kinds[0][0] })}>+ Добавить</button>
      </div>
      {list.length === 0 ? <p className="empty-rules">{phase === 'before' ? 'Действий нет — вопрос показывается как есть.' : 'Действий нет — дальше следующий вопрос.'}</p> : (
        <div className="list-table">
          <div className="list-head atable-head"><span>Условие</span><span>Действие</span><span /></div>
          {list.map((a, i) => (
            <ActionRow key={i} def={def} q={q} a={a} kinds={kinds} open={open === i} onToggle={() => setOpen(open === i ? null : i)}
              onChange={(na) => set(i, na)} onCreateVar={onCreateVar}
              tools={<>
                <button type="button" className="icon-btn" title="Выше" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="icon-btn" title="Ниже" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="icon-btn" title="Копировать действие" onClick={() => insert(i + 1, structuredClone(a))}>⧉</button>
                <button type="button" className="icon-btn" title="Удалить действие" onClick={() => remove(i)}>✕</button>
              </>} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Параметр действия одной строкой: «Q5», «коды 1, 2», «H1 = 3» */
function paramSummary(a: Action): string {
  switch (a.do) {
    case 'goTo': return a.target ?? '— куда? —';
    case 'skipQuestion': return a.target ?? '— какой? —';
    case 'markAnswered': return `${a.target ?? '?'} = ${Array.isArray(a.value) ? a.value.join(', ') : a.value ?? ''}`;
    case 'setValue': return `${a.target ?? '?'} = ${a.value ?? ''}`;
    case 'hideOptions': case 'showOnlyOptions': return a.codes?.length ? a.codes.join(', ') : '— какие? —';
    case 'hideOptionsFrom': return `${a.filter === 'notSelected' ? 'невыбранные' : 'выбранные'} в ${a.question ?? '?'}`;
    case 'skipIfFewer': return `< ${a.n ?? 2}`;
    case 'answer': return a.value === undefined ? '' : Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
    case 'error': case 'end': case 'screenout': return a.message ? `«${a.message.length > 30 ? a.message.slice(0, 29) + '…' : a.message}»` : '';
    default: return '';
  }
}

function ActionRow({ def, q, a, kinds, open, onToggle, onChange, onCreateVar, tools }: {
  def: Survey; q: Question; a: Action; kinds: [Action['do'], string][]; open: boolean; onToggle: () => void;
  onChange: (a: Action) => void; onCreateVar: () => string; tools: React.ReactNode;
}) {
  const set = (patch: Partial<Action>) => {
    const next = { ...a, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as unknown as Action);
  };
  const ownOptions: Option[] = q.type === 'matrix' ? allRows(def, q) : allOptions(def, q);
  const questions = allQuestions(def);
  const hiddenVars = questions.filter((x) => x.type === 'hidden');
  const selfIdx = questions.findIndex((x) => x.id === q.id);
  const groups = [...new Set(kinds.map(([k]) => GROUPS[k]))];
  const param = paramSummary(a);

  return (
    <div className={`list-item${open ? ' open' : ''}`}>
      <div className="list-row atable-row" onClick={onToggle}>
        <span className={`atable-cond mono${a.if ? '' : ' muted'}`} title={a.if ? describeCondition(def, a.if) : undefined}>{a.if ? formatFormula(a.if) : 'всегда'}</span>
        <span className="atable-do">{actionLabel(a, q)}{param && <span className="muted"> · {param}</span>}</span>
        <span className="list-tools" onClick={(e) => e.stopPropagation()}>{tools}</span>
      </div>
      {open && (
      <div className="list-editor action-editor">
        <div className="action-field"><span className="action-field-label">Условие</span>
          <ConditionField def={def} value={a.if} self={q.id} suggest={q.type !== 'info' && q.type !== 'hidden' ? q.id : undefined}
            placeholder="пусто — выполнять всегда" onChange={(c) => set({ if: c })} />
        </div>
        <div className="action-field"><span className="action-field-label">Действие</span>
          <div className="stack" style={{ gap: 8 }}>
            <SearchSelect className="action-kind" value={a.do}
              groups={groups.map((g) => ({ label: g, items: kinds.filter(([k]) => GROUPS[k] === g).map(([k, label]) => ({ value: k, label })) }))}
              onChange={(k) => onChange({ ...(a.if ? { if: a.if } : {}), do: k as Action['do'], ...(k === 'skipIfFewer' ? { n: 2 } : {}) })} />
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
            {questions.slice(0, Math.max(0, selfIdx)).filter((x) => OPTION_TYPES.includes(x.type))
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
      {(a.do === 'skipQuestion' || a.do === 'markAnswered') && (
        <div className="action-params">
          <select className="input" value={a.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })}>
            <option value="">— какой вопрос —</option>
            {questions.slice(selfIdx + 1).filter((x) => x.type !== 'hidden' && x.type !== 'info')
              .map((x) => <option key={x.id} value={x.id}>{x.id} · {x.text.slice(0, 50)}</option>)}
            {a.target && !questions.slice(selfIdx + 1).some((x) => x.id === a.target) && <option value={a.target}>{a.target} (не дальше этого вопроса)</option>}
          </select>
          {a.do === 'markAnswered' && (
            <>
              <span className="muted small">ответ</span>
              <input className="input" placeholder="код; для нескольких — через запятую; можно {{Q1}}"
                value={a.value === undefined ? '' : Array.isArray(a.value) ? a.value.join(', ') : String(a.value)}
                onChange={(e) => set({ value: e.target.value === '' ? undefined : e.target.value })} />
            </>
          )}
        </div>
      )}
      {(a.do === 'end' || a.do === 'screenout') && (
        <div className="action-params ending-params">
          <input className="input" placeholder="Своё сообщение (необязательно, иначе — из настроек)" value={a.message ?? ''}
            onChange={(e) => set({ message: e.target.value || undefined })} />
          <input className="input mono" placeholder="или адрес перехода: https://…?pid={{param.pid}}" value={a.redirect ?? ''}
            onChange={(e) => set({ redirect: e.target.value.trim() || undefined })} />
        </div>
      )}
      {a.do === 'error' && (
        <div className="action-params">
          <input className="input" placeholder="Текст ошибки для респондента" value={a.message ?? ''} onChange={(e) => set({ message: e.target.value || undefined })} />
        </div>
      )}

          </div>
        </div>
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
