import { useState } from 'react';
import { Modal, Segmented, compact } from './common.tsx';
import { OptionsEditor } from './OptionsEditor.tsx';
import { allQuestions, allRows } from '../../../shared/logic.ts';
import { loopChain, possibleItems } from '../../../shared/loops.ts';
import type { Block, LoopSpec, Question, Survey } from '../../../shared/types.ts';

const SOURCE_TYPES = new Set(['single', 'multi', 'dropdown', 'ranking', 'matrix', 'number']);

/** Вопросы, по которым можно построить цикл этого блока: раньше блока, вне чужих циклов (или в цепочке своих) */
function sourceCandidates(def: Survey, block: Block): Question[] {
  const bi = def.blocks.indexOf(block);
  const ancestors = new Set<string>();
  for (let cur: Block | undefined = block; cur?.parent; cur = def.blocks.find((b) => b.id === cur!.parent)) ancestors.add(cur.parent);
  return def.blocks.slice(0, Math.max(0, bi)).flatMap((b) => {
    // Блок вне циклов — всегда; блок внутри цикла — только если наш блок вложен в тот же цикл
    const ok = (!b.parent && !b.loop) || ancestors.has(b.id) || (b.parent !== undefined && ancestors.has(b.parent));
    return ok ? b.questions.filter((q) => SOURCE_TYPES.has(q.type)) : [];
  });
}

/** Описание цикла одной строкой: «по выбранным в Q1», «по списку (3)» */
export function describeLoop(def: Survey, block: Block): string {
  const l = block.loop;
  if (!l) return '';
  const src = l.question ? allQuestions(def).find((q) => q.id === l.question) : undefined;
  const base = l.items ? `по списку (${l.items.length})`
    : src?.type === 'number' ? `по числу из ${l.question}`
      : `по ${l.filter === 'all' ? 'всем' : l.filter === 'notSelected' ? 'невыбранным' : 'выбранным'} в ${l.question}`;
  const extra = [l.order === 'random' ? 'случайно' : l.order === 'rotate' ? 'ротация' : '', l.max ? `не больше ${l.max}` : ''].filter(Boolean);
  return `↻ цикл ${base}${extra.length ? ` · ${extra.join(', ')}` : ''}`;
}

export function LoopDialog({ def, block, onSave, onClose }: {
  def: Survey; block: Block; onSave: (loop: LoopSpec | undefined) => void; onClose: () => void;
}) {
  const candidates = sourceCandidates(def, block);
  const [spec, setSpec] = useState<LoopSpec>(() => block.loop ?? (candidates.length
    ? { question: candidates.filter((q) => q.type === 'multi').at(-1)?.id ?? candidates[candidates.length - 1].id }
    : { items: [{ code: 1, text: '' }] }));
  const set = (patch: Partial<LoopSpec>) => setSpec((s) => compact({ ...s, ...patch }));
  const mode = spec.items ? 'items' : 'question';
  const src = spec.question ? candidates.find((q) => q.id === spec.question) : undefined;
  const depth = loopChain(def, block).length + (block.loop ? 0 : 1);
  const preview = possibleItems(def, { ...block, loop: spec });

  return (
    <Modal wide onClose={onClose} title={`Цикл: блок «${block.title || block.id}»`}
      actions={<>
        {block.loop && <button className="btn btn-secondary btn-sm" onClick={() => onSave(undefined)}>Убрать цикл</button>}
        <button className="btn btn-primary btn-sm" disabled={mode === 'question' ? !src : !spec.items?.some((i) => i.text.trim())}
          onClick={() => onSave(spec)}>Готово</button>
      </>}>
      <div className="stack loop-dialog">
        <p className="muted small" style={{ margin: 0 }}>
          Вопросы блока повторяются для каждого элемента. Копии получают ID по коду элемента: <code>Q5</code> → <code>Q5_3</code>
          {depth > 1 && <> (во вложенном цикле — <code>Q5_3_2</code>)</>} — так они и называются в выгрузке.
        </p>
        <Segmented value={mode} onChange={(v) => setSpec(v === 'items'
          ? compact({ ...spec, question: undefined, filter: undefined, columns: undefined, items: [{ code: 1, text: '' }] })
          : compact({ ...spec, items: undefined, question: candidates.at(-1)?.id }))}
          options={[{ value: 'question', label: 'По ответам на вопрос' }, { value: 'items', label: 'По своему списку' }]} />

        {mode === 'question' ? (
          candidates.length === 0 ? (
            <div className="warn-box">Перед этим блоком нет вопросов с вариантами, матриц или числовых вопросов.</div>
          ) : (
            <>
              <label className="field"><span>Вопрос-источник</span>
                <select className="input" value={spec.question ?? ''} onChange={(e) => set({ question: e.target.value, columns: undefined })}>
                  {candidates.map((q) => <option key={q.id} value={q.id}>{q.id} · {q.text.slice(0, 60)}</option>)}
                </select>
              </label>
              {src?.type === 'number' ? (
                <p className="muted small" style={{ margin: 0 }}>Повторов — столько, сколько ответил респондент (1, 2, 3…), но не больше предела ниже.</p>
              ) : (
                <div className="flag-line">
                  <span>{src?.type === 'matrix' ? 'Строки' : 'Варианты'}</span>
                  <Segmented value={spec.filter ?? 'selected'} onChange={(v) => set({ filter: v === 'selected' ? undefined : v })}
                    options={[
                      { value: 'selected', label: src?.type === 'matrix' ? 'с ответом' : 'выбранные' },
                      { value: 'notSelected', label: src?.type === 'matrix' ? 'без ответа' : 'невыбранные' },
                      { value: 'all', label: 'все' },
                    ]} />
                </div>
              )}
              {src?.type === 'matrix' && (spec.filter ?? 'selected') !== 'all' && (
                <div className="flag-line">
                  <span>Только строки, где отмечено<small className="muted"> (пусто — любой ответ)</small></span>
                  <div className="multi-pick">
                    {src.columns.map((c) => {
                      const on = spec.columns?.includes(c.code) ?? false;
                      return (
                        <label key={c.code} className={on ? 'on' : ''}>
                          <input type="checkbox" style={{ display: 'none' }} checked={on} onChange={() => {
                            const next = on ? (spec.columns ?? []).filter((x) => x !== c.code) : [...(spec.columns ?? []), c.code];
                            set({ columns: next.length ? next : undefined });
                          }} />
                          {c.text}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )
        ) : (
          <div className="block">
            <div className="sub-title">Элементы цикла</div>
            <OptionsEditor options={spec.items ?? []} onChange={(items) => set({ items })} placeholder="Элемент" />
          </div>
        )}

        <div className="flag-line">
          <span>Порядок повторов</span>
          <Segmented value={spec.order ?? 'fixed'} onChange={(v) => set({ order: v === 'fixed' ? undefined : v })}
            options={[{ value: 'fixed', label: src?.type === 'ranking' ? 'по местам' : 'как в списке' }, { value: 'random', label: 'случайный' }, { value: 'rotate', label: 'ротация' }]} />
        </div>
        <div className="flag-line">
          <span>{src?.type === 'number' ? 'Предел повторов' : 'Не больше повторов'}<small className="muted"> {spec.order === 'random' ? '(случайные N)' : '(первые N)'}</small></span>
          <input className="input mini" type="number" min={1} placeholder={src?.type === 'number' ? '20' : 'все'} value={spec.max ?? ''}
            onChange={(e) => set({ max: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
        </div>

        <div className="loop-help">
          <div className="sub-title">В вопросах блока</div>
          <ul>
            <li><code>{'{{loop}}'}</code> — текст текущего элемента, <code>{'{{loop.code}}'}</code> — его код{depth > 1 && <>; <code>{'{{loop1}}'}</code> — элемент внешнего цикла</>}.</li>
            <li>Ссылки на вопросы этого же блока (условия, подстановки, перенос) относятся к текущему повтору.</li>
            <li>Условие «↻ повтор цикла» — показать вопрос только для некоторых элементов.</li>
            <li>После цикла на конкретный повтор ссылаются по ID копии: <code>{'{{'}{block.questions[0]?.id ?? 'Q5'}_{preview[0]?.code ?? 1}{'}}'}</code>.</li>
            <li>Вложенный цикл: блок после этого → меню блока → «Вложить в цикл».</li>
          </ul>
        </div>
        {preview.length > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            Возможные элементы: {preview.slice(0, 12).map((i) => `${i.code} ${i.text}`).join(' · ')}{preview.length > 12 ? ` · …ещё ${preview.length - 12}` : ''}
          </p>
        )}
        {src?.type === 'matrix' && <span className="muted small">Строк в матрице: {allRows(def, src).length}</span>}
      </div>
    </Modal>
  );
}

/** Заголовок для конструктора: подстановки цикла — как [элемент] */
export function shownTitle(title: string | undefined): string {
  return (title ?? '').replace(/\{\{\s*loop(\d?)(\.code)?\s*\}\}/g, (_m, n: string, code: string) => `[${code ? 'код ' : ''}элемент${n ? ` ур. ${n}` : ''}]`);
}
