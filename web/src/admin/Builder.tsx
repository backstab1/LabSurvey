import { memo, useEffect, useRef, useState } from 'react';
import { QuestionDialog } from './QuestionEditor.tsx';
import { describeCondition } from './ConditionEditor.tsx';
import { describeActions } from './ActionsEditor.tsx';
import { plain, rich } from '../runner/rich.tsx';
import { Menu, toast } from './common.tsx';
import { QUESTION_TYPE_LABELS, type Block, type LoopSpec, type Question, type QuestionType, type Survey } from '../../../shared/types.ts';
import { LoopDialog, describeLoop, shownTitle } from './LoopEditor.tsx';
import { loopChain, loopDepth } from '../../../shared/loops.ts';
import { allIds, nextId, renameId } from '../../../shared/refactor.ts';
import type { ValidationResult } from '../../../shared/validate.ts';

export const TYPE_ICONS: Record<QuestionType, string> = {
  single: '◉', multi: '☑', dropdown: '▾', ranking: '⇅', text: '✎', number: '#', scale: '⋯',
  matrix: '▦', date: '◷', phone: '☏', info: 'ℹ', hidden: '⊘',
};

export function newQuestion(type: QuestionType, id: string): Question {
  const base = { id, text: '' };
  switch (type) {
    case 'single': case 'dropdown': case 'multi': case 'ranking':
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

type Pos = { bi: number; qi: number };

/** Точечное обновление вопроса без пересоздания остальных объектов (карточки не перерисовываются) */
function withQuestion(def: Survey, { bi, qi }: Pos, q: Question): Survey {
  return { ...def, blocks: def.blocks.map((b, i) => (i === bi ? { ...b, questions: b.questions.map((x, j) => (j === qi ? q : x)) } : b)) };
}

/** Циклы, в которые можно вложить блок: цикл прямо перед ним или внешние циклы предыдущего блока */
function nestTargets(def: Survey, bi: number): Block[] {
  const b = def.blocks[bi];
  const prev = def.blocks[bi - 1];
  if (!prev) return [];
  const chain = loopChain(def, prev);
  return chain.filter((t) => t.id !== b.parent && t.id !== b.id && loopChain(def, t).length < 3).reverse();
}

const compactBlock = (b: Block): Block => {
  const out = { ...b };
  if (!out.order) delete out.order;
  return out;
};

/** Вопросы из буфера обмена: вопрос, массив вопросов или анкета целиком. Конфликтующие ID получают новые */
function questionsFromClipboard(text: string, def: Survey): Question[] | null {
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  let list: any[] = Array.isArray(data) ? data
    : data?.blocks ? data.blocks.flatMap((b: any) => b.questions ?? [])
    : data?.questions ? data.questions
    : data?.type && data?.id ? [data] : [];
  list = list.filter((q) => q && typeof q === 'object' && typeof q.id === 'string' && typeof q.type === 'string');
  if (!list.length) return null;
  // Переименование внутри вставляемого набора — ссылки между вставленными вопросами сохраняются
  let tmp: Survey = { formatVersion: 2, title: '', blocks: [{ id: '__paste', questions: structuredClone(list) }] };
  const taken = allIds(def);
  for (const q of list) {
    if (taken.some((x) => x.toLowerCase() === q.id.toLowerCase())) {
      const prefix = q.id.match(/^[A-Za-z_]+/)?.[0] ?? 'Q';
      const fresh = nextId([...taken, ...allIds(tmp)], prefix);
      tmp = renameId(tmp, q.id, fresh);
      taken.push(fresh);
    } else taken.push(q.id);
  }
  return tmp.blocks[0].questions;
}

export function Builder({ def, onChange, issues, focus, onPreview }: {
  def: Survey; onChange: (d: Survey) => void; issues: ValidationResult; focus?: { where: string; n: number };
  onPreview: (startAt?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Pos | null>(null);
  const [picker, setPicker] = useState<Pos | null>(null);
  const [drag, setDrag] = useState<Pos | null>(null);
  const [drop, setDrop] = useState<Pos | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [loopFor, setLoopFor] = useState<string | null>(null);
  // Выделенные вопросы для массовых действий; lastPick — опора для выделения диапазона с Shift
  const [sel, setSel] = useState<Set<string>>(new Set());
  const lastPick = useRef<string | null>(null);

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

  const pasteAt = async (at: Pos) => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { toast('Нет доступа к буферу обмена'); return; }
    const qs = questionsFromClipboard(text, def);
    if (!qs) { toast('В буфере нет вопросов в формате JSON'); setPicker(null); return; }
    mutate((d) => { d.blocks[at.bi].questions.splice(at.qi, 0, ...qs); });
    setPicker(null);
    toast(`Вставлено вопросов: ${qs.length}`);
  };

  const toggleBlock = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const q = query.trim().toLowerCase();
  const matches = (x: Question) => !q || x.id.toLowerCase().includes(q) || x.text.toLowerCase().includes(q) || !!x.note?.toLowerCase().includes(q);

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

  const setBlockLoop = (id: string, loop: LoopSpec | undefined) => mutate((d) => {
    const b = d.blocks.find((x) => x.id === id)!;
    if (loop) b.loop = loop; else delete b.loop;
    // Блок перестал быть циклом — вложенные в него поднимаются на уровень выше
    if (!loop) for (const c of d.blocks) if (c.parent === id) { if (b.parent) c.parent = b.parent; else delete c.parent; }
  });
  const setBlockParent = (id: string, parent: string | undefined) => mutate((d) => {
    const b = d.blocks.find((x) => x.id === id)!;
    if (parent) b.parent = parent; else delete b.parent;
  });

  const setBlockOrder = (bi: number, order: 'random' | 'rotate' | undefined) =>
    onChange({ ...def, blocks: def.blocks.map((b, i) => (i === bi ? compactBlock({ ...b, order }) : b)) });

  const setBlockTitle = (bi: number, title: string) =>
    onChange({ ...def, blocks: def.blocks.map((b, i) => (i === bi ? { ...b, title: title || undefined } : b)) });

  // Плоский список для навигации ‹ › в окне вопроса
  const flat: Pos[] = def.blocks.flatMap((b, bi) => b.questions.map((_, qi) => ({ bi, qi })));
  const openIdx = open ? flat.findIndex((x) => x.bi === open.bi && x.qi === open.qi) : -1;
  const openQ = open ? def.blocks[open.bi]?.questions[open.qi] : undefined;
  // Сквозная нумерация (скрытые переменные не нумеруются), не зависит от свёрнутых блоков
  const numbers = new Map<string, number>();
  for (const x of def.blocks.flatMap((b) => b.questions)) if (x.type !== 'hidden') numbers.set(x.id, numbers.size + 1);

  function jumpTo(id: string) {
    document.getElementById(`card-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(id);
    setTimeout(() => setFlash(null), 1200);
  }

  // ---- Выделение и массовые действия ----
  const flatIds = def.blocks.flatMap((b) => b.questions.map((x) => x.id));
  const selected = flatIds.filter((id) => sel.has(id));
  // Карточки не перерисовываются при каждой правке, поэтому порядок берём из ref
  const flatRef = useRef(flatIds);
  flatRef.current = flatIds;
  const pick = (id: string, range: boolean) => setSel((prev) => {
    const next = new Set(prev);
    const ids = flatRef.current;
    if (range && lastPick.current && ids.includes(lastPick.current)) {
      const [a, b] = [ids.indexOf(lastPick.current), ids.indexOf(id)].sort((x, y) => x - y);
      for (const x of ids.slice(a, b + 1)) next.add(x);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    lastPick.current = id;
    return next;
  });
  const clearSel = () => setSel(new Set());
  useEffect(() => {
    if (!selected.length) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !open && !document.querySelector('.menu-list')) clearSel(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [selected.length, open]);

  const bulk = {
    required: (on: boolean) => mutate((d) => {
      for (const b of d.blocks) for (const x of b.questions) {
        if (sel.has(x.id) && x.type !== 'info' && x.type !== 'hidden') { if (on) delete x.required; else x.required = false; }
      }
    }),
    duplicate: () => mutate((d) => {
      for (const b of d.blocks) {
        for (let i = b.questions.length - 1; i >= 0; i--) {
          if (!sel.has(b.questions[i].id)) continue;
          const copy = structuredClone(b.questions[i]);
          copy.id = nextId(allIds(d), copy.type === 'hidden' ? 'H' : 'Q');
          b.questions.splice(i + 1, 0, copy);
        }
      }
    }),
    moveTo: (bi: number) => mutate((d) => {
      const moved = d.blocks.flatMap((b) => b.questions.filter((x) => sel.has(x.id)));
      for (const b of d.blocks) b.questions = b.questions.filter((x) => !sel.has(x.id));
      d.blocks[bi].questions.push(...moved);
    }),
    copy: () => {
      const list = def.blocks.flatMap((b) => b.questions.filter((x) => sel.has(x.id)));
      navigator.clipboard.writeText(JSON.stringify(list, null, 2));
      toast(`Скопировано вопросов: ${list.length} — вставьте через «+» в любой анкете`);
    },
    remove: () => {
      if (!window.confirm(`Удалить выделенные вопросы (${selected.length})?`)) return;
      mutate((d) => { for (const b of d.blocks) b.questions = b.questions.filter((x) => !sel.has(x.id)); });
      clearSel();
    },
  };

  const endDrag = () => { setDrag(null); setDrop(null); };
  const dropAt = (to: Pos) => { if (drag) moveQuestion(drag, to); endDrag(); };

  return (
    <div className="builder">
      <nav className="outline">
        <input className="input outline-search" type="search" placeholder="Найти вопрос…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {def.blocks.map((b, bi) => {
          const found = b.questions.filter(matches);
          if (q && !found.length) return null;
          return (
            <div key={bi}>
              <button className={`outline-page${issueFor(b.id) ? ' has-issue' : ''}`} onClick={() => {
                if (collapsed.has(b.id)) toggleBlock(b.id);
                jumpTo(b.id);
              }}>
                {shownTitle(b.title) || `Блок ${bi + 1}`}
              </button>
              {found.map((x) => (
                <button key={x.id} className={`outline-q${issueFor(x.id) ? ' has-issue' : ''}`} title={plain(x.text)} onClick={() => {
                  if (collapsed.has(b.id)) { toggleBlock(b.id); setTimeout(() => jumpTo(x.id), 50); } else jumpTo(x.id);
                }}>
                  <span className="qid">{x.id}</span><span className="qtext">{plain(x.text) || QUESTION_TYPE_LABELS[x.type]}</span>
                </button>
              ))}
            </div>
          );
        })}
        {q && !def.blocks.some((b) => b.questions.some(matches)) && <p className="muted small" style={{ padding: '4px 8px' }}>Ничего не найдено</p>}
      </nav>

      <div className="canvas">
        {selected.length > 0 && (
          <div className="bulk-bar">
            <strong>Выбрано: {selected.length}</strong>
            <button className="btn-link" onClick={() => setSel(new Set(flatIds))}>выбрать все</button>
            <span className="grow" />
            <button className="btn btn-secondary btn-sm" onClick={() => bulk.required(true)}>Обязательные</button>
            <button className="btn btn-secondary btn-sm" onClick={() => bulk.required(false)}>Необязательные</button>
            <Menu className="btn btn-secondary btn-sm" label="В блок ▾" title="Перенести в конец блока" items={
              def.blocks.map((b, bi) => ({ label: b.title || `Блок ${bi + 1} (${b.id})`, onClick: () => bulk.moveTo(bi) }))
            } />
            <button className="btn btn-secondary btn-sm" onClick={bulk.duplicate}>Дублировать</button>
            <button className="btn btn-secondary btn-sm" onClick={bulk.copy}>Копировать</button>
            <button className="btn btn-danger btn-sm" onClick={bulk.remove}>Удалить</button>
            <button className="icon-btn" title="Снять выделение (Esc)" onClick={clearSel}>✕</button>
          </div>
        )}
        {def.blocks.map((b, bi) => (
          <section key={bi} className={`page-block${b.parent ? ' nested' : ''}${b.loop ? ' loop-block' : ''}`} id={`card-${b.id}`}
            style={b.parent ? { marginLeft: Math.min(3, loopDepth(def, b)) * 28 } : undefined}>
            <header className={`page-head${flash === b.id ? ' flash' : ''}`}>
              <button className="icon-btn chev-btn" title={collapsed.has(b.id) ? 'Развернуть блок' : 'Свернуть блок'}
                onClick={() => toggleBlock(b.id)}>{collapsed.has(b.id) ? '▸' : '▾'}</button>
              <input className="block-title-input" value={b.title ?? ''} placeholder={`Блок ${bi + 1} (без заголовка)`}
                title="Заголовок блока — респондент видит его над вопросами блока" onChange={(e) => setBlockTitle(bi, e.target.value)} />
              {issueFor(b.id) && <span className="chip-error">{issueFor(b.id)!.message}</span>}
              <span className="grow" />
              {b.loop && (
                <button className="chip-info act loop-chip" title="Настроить цикл" onClick={() => setLoopFor(b.id)}>{describeLoop(def, b)}</button>
              )}
              {b.parent && !b.loop && <span className="chip-info plain" title="Повторяется внутри каждого повтора внешнего цикла">внутри цикла «{b.parent}»</span>}
              {b.order && (
                <span className="chip-info act" title="Порядок вопросов у каждого респондента свой; закреплённые вопросы остаются на местах">
                  {b.order === 'random' ? '🔀 случайный порядок' : '↻ ротация'}
                </span>
              )}
              {collapsed.has(b.id) && <span className="muted small">вопросов: {b.questions.length}</span>}
              <span className="block-id" title="ID блока — для перехода «в начало блока»">{b.id}</span>
              <Menu items={[
                { label: collapsed.has(b.id) ? 'Развернуть' : 'Свернуть', onClick: () => toggleBlock(b.id) },
                { label: 'Свернуть все блоки', onClick: () => setCollapsed(new Set(def.blocks.map((x) => x.id))) },
                { label: 'Развернуть все', onClick: () => setCollapsed(new Set()) },
                { label: 'Цикл', onClick: () => {}, group: true },
                { label: b.loop ? 'Настроить цикл…' : 'Повторять блок в цикле…', onClick: () => setLoopFor(b.id) },
                ...nestTargets(def, bi).map((t) => ({ label: `Вложить в цикл «${shownTitle(t.title) || t.id}»`, onClick: () => setBlockParent(b.id, t.id) })),
                !!b.parent && { label: 'Вынести из цикла на уровень выше', onClick: () => setBlockParent(b.id, def.blocks.find((x) => x.id === b.parent)?.parent) },
                { label: 'Порядок вопросов', onClick: () => {}, group: true },
                { label: `${!b.order ? '✓ ' : ''}Как в конструкторе`, onClick: () => setBlockOrder(bi, undefined) },
                { label: `${b.order === 'random' ? '✓ ' : ''}Случайный для каждого респондента`, onClick: () => setBlockOrder(bi, 'random') },
                { label: `${b.order === 'rotate' ? '✓ ' : ''}Ротация`, onClick: () => setBlockOrder(bi, 'rotate') },
                { label: 'Действия', onClick: () => {}, group: true },
                { label: 'Предпросмотр с начала блока', onClick: () => b.questions[0] && onPreview(b.questions[0].id), disabled: !b.questions.length },
                { label: 'Добавить блок после', onClick: () => addBlock(bi) },
                { label: 'Переместить выше', onClick: () => moveBlock(bi, -1), disabled: bi === 0 },
                { label: 'Переместить ниже', onClick: () => moveBlock(bi, 1), disabled: bi === def.blocks.length - 1 },
                bi > 0 && { label: 'Объединить с предыдущим', onClick: () => mutate((d) => { d.blocks[bi - 1].questions.push(...d.blocks[bi].questions); d.blocks.splice(bi, 1); }) },
                def.blocks.length > 1 && {
                  label: 'Удалить блок', danger: true,
                  onClick: () => {
                    if (b.questions.length && !window.confirm(`Удалить блок вместе с вопросами (${b.questions.length})?`)) return;
                    mutate((d) => {
                      const [gone] = d.blocks.splice(bi, 1);
                      for (const c of d.blocks) if (c.parent === gone.id) { if (gone.parent) c.parent = gone.parent; else delete c.parent; }
                    });
                  },
                },
              ]} />
            </header>

            {!collapsed.has(b.id) && b.questions.map((q, qi) => {
              const n = numbers.get(q.id) ?? null;
              return (
                <div key={`${bi}:${qi}:${q.id}`}>
                  <Inserter active={picker?.bi === bi && picker.qi === qi} onOpen={() => setPicker({ bi, qi })}
                    onPick={(t) => addQuestion({ bi, qi }, t)} onPaste={() => pasteAt({ bi, qi })} onClose={() => setPicker(null)}
                    dropping={!!drag && drop?.bi === bi && drop.qi === qi}
                    onDragOver={() => drag && setDrop({ bi, qi })} onDrop={() => dropAt({ bi, qi })} />
                  <QuestionCard def={def} q={q} n={n} error={issueFor(q.id)?.message} flash={flash === q.id} pinned={!!b.order && !!q.fixed}
                    selected={sel.has(q.id)} onSelect={(range) => pick(q.id, range)}
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
                    onDelete={() => { if (window.confirm(`Удалить ${q.id}?`)) mutate((d) => { d.blocks[bi].questions.splice(qi, 1); }); }}
                    onPreview={() => onPreview(q.id)}
                    onCopy={() => { navigator.clipboard.writeText(JSON.stringify(q, null, 2)); toast(`${q.id} скопирован — вставьте через «+» в любой анкете`); }} />
                </div>
              );
            })}
            {!collapsed.has(b.id) && <Inserter last active={picker?.bi === bi && picker.qi === b.questions.length} onOpen={() => setPicker({ bi, qi: b.questions.length })}
              onPick={(t) => addQuestion({ bi, qi: b.questions.length }, t)} onPaste={() => pasteAt({ bi, qi: b.questions.length })} onClose={() => setPicker(null)}
              dropping={!!drag && drop?.bi === bi && drop.qi === b.questions.length}
              onDragOver={() => drag && setDrop({ bi, qi: b.questions.length })}
              onDrop={() => dropAt({ bi, qi: b.questions.length })} />}
          </section>
        ))}
        <button className="add-page" onClick={() => addBlock(def.blocks.length - 1)}>+ Новый блок</button>
      </div>

      {loopFor && def.blocks.find((b) => b.id === loopFor) && (
        <LoopDialog def={def} block={def.blocks.find((b) => b.id === loopFor)!} onClose={() => setLoopFor(null)}
          onSave={(loop) => { setBlockLoop(loopFor, loop); setLoopFor(null); }} />
      )}
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
          onRename={(newId) => onChange(renameId(def, openQ.id, newId))}
          onPreview={() => onPreview(openQ.id)}
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

const QuestionCard = memo(function QuestionCard({ def, q, n, error, flash, pinned, dragging, selected, onSelect, onOpen, onDragStart, onDragEnd, onDragOverHalf, onDropHere, onDuplicate, onDelete, onPreview, onCopy }: {
  def: Survey; q: Question; n: number | null; error?: string; flash: boolean; pinned: boolean; dragging: boolean;
  selected: boolean; onSelect: (range: boolean) => void;
  onOpen: () => void; onDragStart: () => void; onDragEnd: () => void;
  onDragOverHalf: (after: boolean) => void; onDropHere: () => void;
  onDuplicate: () => void; onDelete: () => void; onPreview: () => void; onCopy: () => void;
}) {
  const chips: { text: string; kind: 'show' | 'act' | 'plain' }[] = [];
  if (q.type !== 'info' && q.type !== 'hidden' && q.required === false) chips.push({ text: 'необязательный', kind: 'plain' });
  if (pinned) chips.push({ text: '📌 на месте при перемешивании', kind: 'plain' });
  if (q.showIf) chips.push({ text: `если ${describeCondition(def, q.showIf)}`, kind: 'show' });
  const before = describeActions(def, q, q.actions?.before);
  const after = describeActions(def, q, q.actions?.after);
  if (before) chips.push({ text: `перед показом: ${before}`, kind: 'act' });
  if (after) chips.push({ text: `после ответа: ${after}`, kind: 'act' });
  if (q.scripts) chips.push({ text: 'JS', kind: 'plain' });
  return (
    <div id={`card-${q.id}`} className={`qcard${error ? ' has-error' : ''}${flash ? ' flash' : ''}${dragging ? ' dragging' : ''}${q.type === 'hidden' ? ' hidden-card' : ''}${selected ? ' selected' : ''}`}
      onClick={onOpen}
      onDragOver={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOverHalf(e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => { e.preventDefault(); onDropHere(); }}>
      <div className="qcard-head">
        <input type="checkbox" className="q-select" checked={selected} title="Выделить (Shift — диапазон)" aria-label={`Выделить ${q.id}`}
          onClick={(e) => { e.stopPropagation(); onSelect(e.shiftKey); }} onChange={() => {}} />
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
          <button className="icon-btn" title="Предпросмотр с этого вопроса" onClick={onPreview}>▶</button>
          <button className="icon-btn" title="Дублировать" onClick={onDuplicate}>⧉</button>
          <Menu items={[
            { label: 'Открыть', onClick: onOpen },
            { label: 'Предпросмотр с этого вопроса', onClick: onPreview },
            { label: 'Дублировать', onClick: onDuplicate },
            { label: 'Копировать (JSON)', onClick: onCopy },
            { label: 'Удалить', onClick: onDelete, danger: true },
          ]} />
        </span>
      </div>
      {error && <div className="card-error">{error}</div>}
      {q.note && <div className="qcard-note" title="Комментарий для команды — респондент его не видит">💬 {q.note}</div>}
      {q.type === 'hidden' ? (
        <div className="hidden-var">
          {q.text && <span className="qcard-label">{q.text} · </span>}
          {q.calc ? <>формула <code>{q.calc}</code></> : q.fromParam ? <>из параметра ссылки <code>?{q.fromParam}</code></> : 'задаётся действием или скриптом'}
        </div>
      ) : q.text ? (
        <>
          <div className={`qcard-text${q.type === 'info' ? ' info' : ''}`}>{rich(pipeMark(q.text))}</div>
          {q.hint && <div className="qcard-hint">{rich(pipeMark(q.hint))}</div>}
        </>
      ) : <div className="muted empty-q">Пустой вопрос — нажмите, чтобы заполнить</div>}
    </div>
  );
}, (a, b) => a.q === b.q && a.n === b.n && a.error === b.error && a.flash === b.flash && a.dragging === b.dragging && a.selected === b.selected && a.pinned === b.pinned
  && a.def.blocks.length === b.def.blocks.length);

/** Подстановки в карточке — как [Q1] */
const pipeMark = (t: string) => t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '[$1]');

/** Полоска между карточками: «+» добавляет вопрос в это место, сюда же можно бросить перетаскиваемую карточку */
function Inserter({ active, last, dropping, onOpen, onPick, onPaste, onClose, onDragOver, onDrop }: {
  active: boolean; last?: boolean; dropping: boolean;
  onOpen: () => void; onPick: (t: QuestionType) => void; onPaste: () => void; onClose: () => void;
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
          <button className="paste-btn" onClick={onPaste}><span className="type-icon">⎘</span>Вставить из буфера (JSON)</button>
        </div>
      )}
    </div>
  );
}
