import { useState } from 'react';
import { QuestionEditor } from './QuestionEditor.tsx';
import { ConditionEditor } from './ConditionEditor.tsx';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { compact } from './common.tsx';
import { QUESTION_TYPE_LABELS, END, SCREENOUT, type Page, type Question, type QuestionType, type Survey } from '../../../shared/types.ts';
import type { ValidationResult } from '../../../shared/validate.ts';

type Sel = { kind: 'page'; pi: number } | { kind: 'q'; pi: number; qi: number } | null;

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
      return { ...base, type, options: [{ code: 1, text: 'Вариант 1' }, { code: 2, text: 'Вариант 2' }] } as Question;
    case 'scale': return { ...base, type, from: 1, to: 5 };
    case 'matrix':
      return {
        ...base, type, mode: 'single',
        rows: [{ code: 1, text: 'Строка 1' }, { code: 2, text: 'Строка 2' }],
        columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Средне' }, { code: 3, text: 'Хорошо' }],
      };
    case 'info': return { ...base, type, text: 'Текст для респондента' };
    case 'hidden': return { ...base, type, valueType: 'string' };
    default: return { ...base, type } as Question;
  }
}

const allQuestionIds = (def: Survey) => def.pages.flatMap((p) => p.questions.map((q) => q.id));

export function Builder({ def, onChange, issues }: { def: Survey; onChange: (d: Survey) => void; issues: ValidationResult }) {
  const [sel, setSel] = useState<Sel>(def.pages[0]?.questions.length ? { kind: 'q', pi: 0, qi: 0 } : { kind: 'page', pi: 0 });
  const [adding, setAdding] = useState<number | null>(null);

  const mutate = (fn: (d: Survey) => void) => {
    const next = structuredClone(def);
    fn(next);
    onChange(next);
  };

  const hasIssue = (id: string) => issues.errors.some((e) => e.where === id || e.where.startsWith(id + ' '));

  const addQuestion = (pi: number, type: QuestionType) => {
    const id = nextId(allQuestionIds(def), type === 'hidden' ? 'H' : 'Q');
    mutate((d) => { d.pages[pi].questions.push(newQuestion(type, id)); });
    setSel({ kind: 'q', pi, qi: def.pages[pi].questions.length });
    setAdding(null);
  };

  const addPage = () => {
    const id = nextId(def.pages.map((p) => p.id), 'P');
    mutate((d) => { d.pages.push({ id, questions: [] }); });
    setSel({ kind: 'page', pi: def.pages.length });
  };

  const movePage = (pi: number, dir: -1 | 1) => mutate((d) => {
    const [p] = d.pages.splice(pi, 1);
    d.pages.splice(pi + dir, 0, p);
    setSel({ kind: 'page', pi: pi + dir });
  });

  const moveQuestion = (pi: number, qi: number, dir: -1 | 1) => mutate((d) => {
    const qs = d.pages[pi].questions;
    // На границе страницы вопрос переезжает на соседнюю страницу
    if (qi + dir < 0 && pi > 0) {
      const [q] = qs.splice(qi, 1);
      d.pages[pi - 1].questions.push(q);
      setSel({ kind: 'q', pi: pi - 1, qi: d.pages[pi - 1].questions.length - 1 });
    } else if (qi + dir >= qs.length && pi < d.pages.length - 1) {
      const [q] = qs.splice(qi, 1);
      d.pages[pi + 1].questions.unshift(q);
      setSel({ kind: 'q', pi: pi + 1, qi: 0 });
    } else if (qi + dir >= 0 && qi + dir < qs.length) {
      const [q] = qs.splice(qi, 1);
      qs.splice(qi + dir, 0, q);
      setSel({ kind: 'q', pi, qi: qi + dir });
    }
  });

  const current = sel?.kind === 'q' ? def.pages[sel.pi]?.questions[sel.qi] : undefined;
  const currentPage = sel ? def.pages[sel.pi] : undefined;

  return (
    <div className="builder">
      <div className="card outline">
        {def.pages.map((p, pi) => (
          <div key={pi} className="outline-page">
            <div className={`outline-item page-item${sel?.kind === 'page' && sel.pi === pi ? ' selected' : ''}${hasIssue(p.id) ? ' has-issue' : ''}`}
              onClick={() => setSel({ kind: 'page', pi })}>
              <span className="qtext">{p.id}{p.title ? ` · ${p.title}` : ''}</span>
              {p.showIf && <span className="flag" title="Условие показа страницы">если</span>}
              {p.jumps?.length ? <span className="flag" title="Переходы">↪{p.jumps.length}</span> : null}
            </div>
            <div className="outline-questions">
              {p.questions.map((q, qi) => (
                <div key={qi} className={`outline-item${sel?.kind === 'q' && sel.pi === pi && sel.qi === qi ? ' selected' : ''}${hasIssue(q.id) ? ' has-issue' : ''}`}
                  onClick={() => setSel({ kind: 'q', pi, qi })}>
                  <span className="qid">{q.id}</span>
                  <span className="qtext">{q.text || <em className="muted">{QUESTION_TYPE_LABELS[q.type]}</em>}</span>
                  {q.showIf && <span className="flag" title="Условие показа">если</span>}
                  {q.scripts && Object.values(q.scripts).some(Boolean) && <span className="flag" title="Есть скрипты">JS</span>}
                </div>
              ))}
              {adding === pi ? (
                <div className="stack" style={{ gap: 2, margin: '4px 0 0 8px' }}>
                  {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
                    <button key={t} className="btn-link" style={{ textAlign: 'left', padding: '3px 6px', color: 'var(--text)', textDecoration: 'none' }}
                      onClick={() => addQuestion(pi, t)}>+ {QUESTION_TYPE_LABELS[t]}</button>
                  ))}
                  <button className="btn-link" style={{ textAlign: 'left' }} onClick={() => setAdding(null)}>отмена</button>
                </div>
              ) : (
                <button className="btn btn-secondary add-q" onClick={() => setAdding(pi)}>+ вопрос</button>
              )}
            </div>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={addPage}>+ Страница</button>
      </div>

      <div className="card">
        {current && sel?.kind === 'q' ? (
          <QuestionEditor
            key={`${sel.pi}:${sel.qi}`}
            q={current}
            def={def}
            onChange={(nq) => mutate((d) => { d.pages[sel.pi].questions[sel.qi] = nq; })}
            onDelete={() => {
              if (!window.confirm(`Удалить вопрос ${current.id}?`)) return;
              mutate((d) => { d.pages[sel.pi].questions.splice(sel.qi, 1); });
              setSel({ kind: 'page', pi: sel.pi });
            }}
            onDuplicate={() => {
              const copy = structuredClone(current);
              copy.id = nextId(allQuestionIds(def), 'Q');
              mutate((d) => { d.pages[sel.pi].questions.splice(sel.qi + 1, 0, copy); });
              setSel({ kind: 'q', pi: sel.pi, qi: sel.qi + 1 });
            }}
            onMove={(dir) => moveQuestion(sel.pi, sel.qi, dir)}
          />
        ) : currentPage && sel ? (
          <PageEditor
            key={sel.pi}
            page={currentPage}
            def={def}
            index={sel.pi}
            onChange={(np) => mutate((d) => { d.pages[sel.pi] = np; })}
            onMove={(dir) => movePage(sel.pi, dir)}
            onDelete={() => {
              if (def.pages.length === 1) return;
              if (!window.confirm(`Удалить страницу ${currentPage.id} вместе с ${currentPage.questions.length} вопросами?`)) return;
              mutate((d) => { d.pages.splice(sel.pi, 1); });
              setSel({ kind: 'page', pi: Math.max(0, sel.pi - 1) });
            }}
          />
        ) : <p className="muted">Выберите страницу или вопрос слева</p>}
      </div>
    </div>
  );
}

function PageEditor({ page, def, index, onChange, onMove, onDelete }: {
  page: Page; def: Survey; index: number; onChange: (p: Page) => void; onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const set = (patch: Partial<Page>) => onChange(compact({ ...page, ...patch }));
  const jumps = page.jumps ?? [];
  const targets = [
    ...def.pages.filter((_, i) => i > index).map((p) => ({ value: p.id, label: `Страница ${p.id}${p.title ? ` · ${p.title}` : ''}` })),
    { value: END, label: 'Завершить опрос (END)' },
    { value: SCREENOUT, label: 'Отсеять респондента (SCREENOUT)' },
  ];
  return (
    <div className="stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>Страница {page.id}</h2>
        <button className="icon-btn" title="Выше" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="icon-btn" title="Ниже" disabled={index === def.pages.length - 1} onClick={() => onMove(1)}>↓</button>
        <button className="btn btn-danger btn-sm" disabled={def.pages.length === 1} onClick={onDelete}>Удалить</button>
      </div>
      <div className="grid2">
        <label className="field"><span>ID страницы</span>
          <input className="input" value={page.id} onChange={(e) => set({ id: e.target.value.trim() })} />
        </label>
        <label className="field"><span>Заголовок (необязательно)</span>
          <input className="input" value={page.title ?? ''} onChange={(e) => set({ title: e.target.value || undefined })} />
        </label>
      </div>

      <div className="section-title">Показывать страницу, если</div>
      <ConditionEditor def={def} value={page.showIf} onChange={(c) => set({ showIf: c })} />

      <div className="section-title">Переходы после страницы</div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Проверяются по порядку, срабатывает первый подходящий. Если ни один не подошёл — следующая страница.
      </p>
      {jumps.map((j, ji) => (
        <div key={ji} className="card" style={{ padding: 12 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong className="grow">Правило {ji + 1}</strong>
            <button className="icon-btn" title="Удалить правило" onClick={() => set({ jumps: jumps.filter((_, k) => k !== ji) })}>✕</button>
          </div>
          <ConditionEditor def={def} value={j.if} required onChange={(c) => set({ jumps: jumps.map((x, k) => (k === ji ? { ...x, if: c! } : x)) })} />
          <label className="field" style={{ marginTop: 8 }}><span>Тогда перейти</span>
            <select className="input" value={j.goTo} onChange={(e) => set({ jumps: jumps.map((x, k) => (k === ji ? { ...x, goTo: e.target.value } : x)) })}>
              {!targets.some((t) => t.value === j.goTo) && <option value={j.goTo}>{j.goTo}</option>}
              {targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>
      ))}
      <div>
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const firstQ = page.questions.find((q) => q.type !== 'info');
          set({ jumps: [...jumps, { if: firstQ ? { q: firstQ.id, op: 'answered' } : { q: '', op: 'answered' }, goTo: SCREENOUT }] });
        }}>+ Правило перехода</button>
      </div>

      <details>
        <summary className="section-title" style={{ cursor: 'pointer' }}>Скрипты страницы {page.scripts && Object.values(page.scripts).some(Boolean) ? '●' : ''}</summary>
        <ScriptsEditor level="page" value={page.scripts} onChange={(s) => set({ scripts: s })} />
      </details>
    </div>
  );
}
