import { memo, useEffect, useRef, useState } from 'react';
import { QuestionDialog } from './QuestionEditor.tsx';
import { describeCondition } from './ConditionEditor.tsx';
import { describeActions } from './ActionsEditor.tsx';
import { QuestionPreview } from './preview.tsx';
import { Menu } from './common.tsx';
import { QUESTION_TYPE_LABELS, type Question, type QuestionType, type Survey } from '../../../shared/types.ts';
import type { ValidationResult } from '../../../shared/validate.ts';

export const TYPE_ICONS: Record<QuestionType, string> = {
  single: '◉', multi: '☑', dropdown: '▾', text: '✎', number: '#', scale: '⋯',
  matrix: '▦', date: '◷', phone: '☏', info: 'ℹ', hidden: '⊘',
};

export function nextId(existing: string[], prefix: string): string {
  let max = 0;
  for (const id of existing) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

export function newQuestion(type: QuestionType, id: string): Question {
  const base = { id, text: '' };
  switch (type) {
    case 'single': case 'dropdown': case 'multi':
      return { ...base, type, options: [{ code: 1, text: '' }] } as Question;
    case 'scale': return { ...base, type, from: 1, to: 5 };
    case 'matrix':
      return {
        ...base, type, mode: 'single',
        rows: [{ code: 1, text: '' }],
        columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Средне' }, { code: 3, text: 'Хорошо' }],
      };
    case 'hidden': return { ...base, type, valueType: 'string' };
    default: return { ...base, type } as Question;
  }
}

/** ID вопросов и блоков — одно пространство имён (переход можно задать и к вопросу, и к блоку) */
const allIds = (def: Survey) => [...def.blocks.map((b) => b.id), ...def.blocks.flatMap((b) => b.questions.map((q) => q.id))];

type Pos = { bi: number; qi: number };

/** Точечное обновление вопроса без пересоздания остальных объектов (карточки не перерисовываются) */
function withQuestion(def: Survey, { bi, qi }: Pos, q: Question): Survey {
  return { ...def, blocks: def.blocks.map((b, i) => (i === bi ? { ...b, questions: b.questions.map((x, j) => (j === qi ? q : x)) } : b)) };
}

export function Builder({ def, onChange, issues, focus }: {
  def: Survey; onChange: (d: Survey) => void; issues: ValidationResult; focus?: { where: string; n: number };
}) {
  const [open, setOpen] = useState<Pos | null>(null);
  const [picker, setPicker] = useState<Pos | null>(null);
  const [drag, setDrag] = useState<Pos | null>(null);
  const [drop, setDrop] = useState<Pos | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const mutate = (fn: (d: Survey) => void) => {
    const next = structuredClone(def);
    fn(next);
    onChange(next);
  };

  // Переход из списка ошибок: «Q3 → …»
  useEffect(() => {
    if (!focus) return;
    const id = focus.where.split(' ')[0];
    def.blocks.forEach((b, i) => {
      if (b.id === id) jumpTo(b.id);
      b.questions.forEach((q, j) => { if (q.id === id) setOpen({ bi: i, qi: j }); });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  const issueFor = (id: string) => issues.errors.find((e) => e.where === id || e.where.startsWith(id + ' '));

  const addQuestion = (at: Pos, type: QuestionType) => {
    const id = nextId(allIds(def), type === 'hidden' ? 'H' : 'Q');
    mutate((d) => { d.blocks[at.bi].questions.splice(at.qi, 0, newQuestion(type, id)); });
    setPicker(null);
    setOpen(at);
  };

  const addBlock = (after: number) => {
    const id = nextId(allIds(def), 'B');
    mutate((d) => { d.blocks.splice(after + 1, 0, { id, title: 'Новый блок', questions: [] }); });
    setPicker({ bi: after + 1, qi: 0 });
  };

  const moveQuestion = (from: Pos, to: Pos) => mutate((d) => {
    const [q] = d.blocks[from.bi].questions.splice(from.qi, 1);
    const qi = from.bi === to.bi && from.qi < to.qi ? to.qi - 1 : to.qi;
    d.blocks[to.bi].questions.splice(qi, 0, q);
  });

  const moveBlock = (bi: number, dir: -1 | 1) => mutate((d) => {
    const [b] = d.blocks.splice(bi, 1);
    d.blocks.splice(bi + dir, 0, b);
  });

  const setBlockTitle = (bi: number, title: string) =>
    onChange({ ...def, blocks: def.blocks.map((b, i) => (i === bi ? { ...b, title: title || undefined } : b)) });

  // Плоский список для навигации ‹ › в окне вопроса
  const flat: Pos[] = def.blocks.flatMap((b, bi) => b.questions.map((_, qi) => ({ bi, qi })));
  const openIdx = open ? flat.findIndex((x) => x.bi === open.bi && x.qi === open.qi) : -1;
  const openQ = open ? def.blocks[open.bi]?.questions[open.qi] : undefined;
  let counter = 0;

  function jumpTo(id: string) {
    document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash(null), 1200);
  }

  const endDrag = () => { setDrag(null); setDrop(null); };
  const dropAt = (to: Pos) => { if (drag) moveQuestion(drag, to); endDrag(); };

  return (
    <div className="builder">
      <nav className="outline">
        {def.blocks.map((b, bi) => (
          <div key={bi}>
            <button className={`outline-page${issueFor(b.id) ? ' has-issue' : ''}`} onClick={() => jumpTo(b.id)}>
              {b.title || `Блок ${bi + 1}`}
            </button>
            {b.questions.map((q) => (
              <button key={q.id} className={`outline-q${issueFor(q.id) ? ' has-issue' : ''}`} onClick={() => jumpTo(q.id)} title={q.text}>
                <span className="qid">{q.id}</span><span className="qtext">{q.text || QUESTION_TYPE_LABELS[q.type]}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="canvas">
        {def.blocks.map((b, bi) => (
          <section key={bi} className="page-block" id={`card-${b.id}`}>
            <header className={`page-head${flash === b.id ? ' flash' : ''}`}>
              <input className="block-title-input" value={b.title ?? ''} placeholder={`Блок ${bi + 1} (без заголовка)`}
                title="Заголовок блока — респондент видит его над вопросами блока" onChange={(e) => setBlockTitle(bi, e.target.value)} />
              <span className="muted small mono" title="ID блока — для перехода «в начало блока»">{b.id}</span>
              {issueFor(b.id) && <span className="chip-error">{issueFor(b.id)!.message}</span>}
              <span className="grow" />
              <Menu items={[
                { label: 'Добавить блок после', onClick: () => addBlock(bi) },
                { label: 'Переместить выше', onClick: () => moveBlock(bi, -1), disabled: bi === 0 },
                { label: 'Переместить ниже', onClick: () => moveBlock(bi, 1), disabled: bi === def.blocks.length - 1 },
                bi > 0 && { label: 'Объединить с предыдущим', onClick: () => mutate((d) => { d.blocks[bi - 1].questions.push(...d.blocks[bi].questions); d.blocks.splice(bi, 1); }) },
                def.blocks.length > 1 && {
                  label: 'Удалить блок', danger: true,
                  onClick: () => {
                    if (b.questions.length && !window.confirm(`Удалить блок вместе с вопросами (${b.questions.length})?`)) return;
                    mutate((d) => { d.blocks.splice(bi, 1); });
                  },
                },
              ]} />
            </header>

            {b.questions.map((q, qi) => {
              const n = q.type === 'hidden' ? null : ++counter;
              return (
                <div key={`${bi}:${qi}:${q.id}`}>
                  <Inserter active={picker?.bi === bi && picker.qi === qi} onOpen={() => setPicker({ bi, qi })}
                    onPick={(t) => addQuestion({ bi, qi }, t)} onClose={() => setPicker(null)}
                    dropping={!!drag && drop?.bi === bi && drop.qi === qi}
                    onDragOver={() => drag && setDrop({ bi, qi })} onDrop={() => dropAt({ bi, qi })} />
                  <QuestionCard def={def} q={q} n={n} error={issueFor(q.id)?.message} flash={flash === q.id}
                    dragging={drag?.bi === bi && drag.qi === qi}
                    onOpen={() => setOpen({ bi, qi })}
                    onDragStart={() => setDrag({ bi, qi })} onDragEnd={endDrag}
                    onDragOverHalf={(after) => drag && setDrop({ bi, qi: after ? qi + 1 : qi })}
                    onDropHere={() => { if (drag && drop) moveQuestion(drag, drop); endDrag(); }}
                    onDuplicate={() => mutate((d) => {
                      const copy = structuredClone(q);
                      copy.id = nextId(allIds(d), 'Q');
                      d.blocks[bi].questions.splice(qi + 1, 0, copy);
                    })}
                    onDelete={() => { if (window.confirm(`Удалить ${q.id}?`)) mutate((d) => { d.blocks[bi].questions.splice(qi, 1); }); }} />
                </div>
              );
            })}
            <Inserter last active={picker?.bi === bi && picker.qi === b.questions.length} onOpen={() => setPicker({ bi, qi: b.questions.length })}
              onPick={(t) => addQuestion({ bi, qi: b.questions.length }, t)} onClose={() => setPicker(null)}
              dropping={!!drag && drop?.bi === bi && drop.qi === b.questions.length}
              onDragOver={() => drag && setDrop({ bi, qi: b.questions.length })}
              onDrop={() => dropAt({ bi, qi: b.questions.length })} />
          </section>
        ))}
        <button className="add-page" onClick={() => addBlock(def.blocks.length - 1)}>+ Новый блок</button>
      </div>

      {open && openQ && (
        <QuestionDialog
          key={`${open.bi}:${open.qi}`}
          def={def}
          q={openQ}
          prevId={flat[openIdx - 1] ? def.blocks[flat[openIdx - 1].bi].questions[flat[openIdx - 1].qi].id : undefined}
          position={`${def.blocks[open.bi].title || `блок ${open.bi + 1}`} · вопрос ${openIdx + 1} из ${flat.length}`}
          onChange={(nq) => onChange(withQuestion(def, open, nq))}
          onClose={() => setOpen(null)}
          onDelete={() => {
            if (!window.confirm(`Удалить ${openQ.id}?`)) return;
            mutate((d) => { d.blocks[open.bi].questions.splice(open.qi, 1); });
            setOpen(null);
          }}
          onDuplicate={() => {
            const copy = structuredClone(openQ);
            copy.id = nextId(allIds(def), 'Q');
            mutate((d) => { d.blocks[open.bi].questions.splice(open.qi + 1, 0, copy); });
            setOpen({ bi: open.bi, qi: open.qi + 1 });
          }}
          hasPrev={openIdx > 0}
          hasNext={openIdx < flat.length - 1}
          onNav={(dir) => { const t = flat[openIdx + dir]; if (t) setOpen(t); }}
          onCreateVar={() => {
            // Скрытая переменная — в конец текущего блока, чтобы не сдвигать открытый вопрос
            const id = nextId(allIds(def), 'H');
            mutate((d) => { d.blocks[open.bi].questions.push({ id, type: 'hidden', text: '', valueType: 'string' }); });
            return id;
          }}
        />
      )}
    </div>
  );
}

const QuestionCard = memo(function QuestionCard({ def, q, n, error, flash, dragging, onOpen, onDragStart, onDragEnd, onDragOverHalf, onDropHere, onDuplicate, onDelete }: {
  def: Survey; q: Question; n: number | null; error?: string; flash: boolean; dragging: boolean;
  onOpen: () => void; onDragStart: () => void; onDragEnd: () => void;
  onDragOverHalf: (after: boolean) => void; onDropHere: () => void;
  onDuplicate: () => void; onDelete: () => void;
}) {
  const chips: { text: string; kind: 'cond' | 'act' | 'plain' }[] = [];
  if (q.type !== 'info' && q.type !== 'hidden' && q.required === false) chips.push({ text: 'необязательный', kind: 'plain' });
  if (q.showIf) chips.push({ text: `если ${describeCondition(def, q.showIf)}`, kind: 'cond' });
  const before = describeActions(def, q, q.actions?.before);
  const after = describeActions(def, q, q.actions?.after);
  if (before) chips.push({ text: `перед показом: ${before}`, kind: 'act' });
  if (after) chips.push({ text: `после ответа: ${after}`, kind: 'act' });
  if (q.scripts) chips.push({ text: 'JS', kind: 'plain' });
  return (
    <div id={`card-${q.id}`} className={`qcard${error ? ' has-error' : ''}${flash ? ' flash' : ''}${dragging ? ' dragging' : ''}${q.type === 'hidden' ? ' hidden-card' : ''}`}
      onClick={onOpen}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverHalf(e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => { e.preventDefault(); onDropHere(); }}>
      <div className="qcard-head">
        <span className="drag-handle" draggable title="Перетащите, чтобы переместить"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id); onDragStart(); }}
          onDragEnd={onDragEnd}>⋮⋮</span>
        {n !== null && <span className="qnum">{n}</span>}
        <span className="qid">{q.id}</span>
        <span className="qtype">{TYPE_ICONS[q.type]} {QUESTION_TYPE_LABELS[q.type]}</span>
        {chips.map((c, i) => <span key={i} className={`chip-info ${c.kind}`} title={c.text}>{c.text}</span>)}
        <span className="grow" />
        <span className="card-tools" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Дублировать" onClick={onDuplicate}>⧉</button>
          <button className="icon-btn" title="Удалить" onClick={onDelete}>✕</button>
        </span>
      </div>
      {error && <div className="card-error">{error}</div>}
      {q.text || q.type === 'hidden'
        ? <QuestionPreview def={def} q={q} />
        : <div className="muted empty-q">Пустой вопрос — нажмите, чтобы заполнить</div>}
    </div>
  );
}, (a, b) => a.q === b.q && a.n === b.n && a.error === b.error && a.flash === b.flash && a.dragging === b.dragging
  && a.def.blocks.length === b.def.blocks.length);

/** Полоска между карточками: «+» добавляет вопрос в это место, сюда же можно бросить перетаскиваемую карточку */
function Inserter({ active, last, dropping, onOpen, onPick, onClose, onDragOver, onDrop }: {
  active: boolean; last?: boolean; dropping: boolean;
  onOpen: () => void; onPick: (t: QuestionType) => void; onClose: () => void;
  onDragOver: () => void; onDrop: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [active, onClose]);
  return (
    <div ref={ref} className={`inserter${last ? ' last' : ''}${active ? ' active' : ''}${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }} onDrop={(e) => { e.preventDefault(); onDrop(); }}>
      {last
        ? <button className="add-question" onClick={onOpen}>+ Добавить вопрос</button>
        : <button className="insert-btn" title="Вставить вопрос сюда" onClick={onOpen}>+</button>}
      {active && (
        <div className="type-picker">
          {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
            <button key={t} onClick={() => onPick(t)}>
              <span className="type-icon">{TYPE_ICONS[t]}</span>{QUESTION_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
