// Другие виды матрицы: сортировка карточек и семантический дифференциал. Ответ — как у матрицы: {строка: столбец}
import { useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { rich } from './rich.tsx';
import type { MatrixQuestion, Option } from '../../../shared/types.ts';

type Value = Record<string, number | number[]>;

interface Props {
  q: MatrixQuestion;
  rows: Option[];
  columns: Option[];
  v: Value;
  emit: (v: Value) => void;
  /** Общие для всей таблицы варианты («Не знаю ни одного») — под вопросом */
  sharedBlock: ReactNode;
}

const inCol = (x: number | number[] | undefined, col: number) => (Array.isArray(x) ? x.includes(col) : x === col);
const sorted = (x: number | number[] | undefined) => x !== undefined && (!Array.isArray(x) || x.length > 0);

/**
 * Сортировка карточек: карточка на экране, под ней — группы. Нажатие на группу кладёт карточку в неё
 * (на компьютере карточки можно перетаскивать). Разложенные карточки видны в группах — их можно вернуть или переложить.
 */
export function CardSort({ q, rows, columns, v, emit, sharedBlock }: Props) {
  const cards = rows.filter((r) => !r.group);
  const multi = q.mode === 'multi';
  const firstOpen = () => cards.find((c) => !sorted(v[String(c.code)]))?.code ?? null;
  const [current, setCurrent] = useState<number | null>(firstOpen);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const card = cards.find((c) => c.code === current) ?? null;
  const done = cards.filter((c) => sorted(v[String(c.code)])).length;

  const nextAfter = (nv: Value, from: number | null) => {
    const i = cards.findIndex((c) => c.code === from);
    const order = [...cards.slice(i + 1), ...cards.slice(0, Math.max(0, i))];
    return order.find((c) => !sorted(nv[String(c.code)]))?.code ?? null;
  };
  const place = (code: number, col: number) => {
    const key = String(code);
    let nv: Value;
    if (multi) {
      const cur = (v[key] as number[] | undefined) ?? [];
      nv = { ...v, [key]: cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col] };
    } else nv = { ...v, [key]: col };
    emit(nv);
    // Одна группа на карточку — сразу следующая; в режиме «несколько групп» респондент сам нажимает «Дальше»
    if (!multi && code === current) setTimeout(() => setCurrent(nextAfter(nv, code)), 180);
  };
  const unsort = (code: number) => {
    const nv = { ...v };
    delete nv[String(code)];
    emit(nv);
    setCurrent(code);
  };
  const drag = (code: number) => (e: DragEvent) => { e.dataTransfer.setData('text/plain', String(code)); e.dataTransfer.effectAllowed = 'move'; };
  const drop = (col: number) => (e: DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const code = Number(e.dataTransfer.getData('text/plain'));
    if (!cards.some((c) => c.code === code)) return;
    if (!multi) {
      const nv = { ...v, [String(code)]: col };
      emit(nv);
      if (code === current) setCurrent(nextAfter(nv, code));
    } else place(code, col);
  };
  const over = (col: number) => (e: DragEvent) => { e.preventDefault(); setDragOver(col); };
  const face = (c: Option, big = false) => (
    <>
      {c.image && <img className={big ? 'sort-card-img' : 'sort-chip-img'} src={c.image} alt={c.hideText ? c.text : ''} />}
      {!c.hideText && <span>{rich(c.text)}</span>}
    </>
  );

  return (
    <div className="cardsort">
      <div className="sort-progress muted small">Разложено {done} из {cards.length}</div>
      {card ? (
        <div className="sort-current">
          <div className="sort-card" draggable onDragStart={drag(card.code)} aria-live="polite">{face(card, true)}</div>
          <div className="sort-hint muted small">{multi ? 'Отметьте все подходящие группы' : 'Куда отнести эту карточку?'}</div>
          <div className="sort-targets">
            {columns.map((col) => {
              const on = inCol(v[String(card.code)], col.code);
              return (
                <button type="button" key={col.code} className={`sort-target${on ? ' selected' : ''}${dragOver === col.code ? ' over' : ''}`}
                  aria-pressed={on} onClick={() => place(card.code, col.code)} onDragOver={over(col.code)} onDragLeave={() => setDragOver(null)} onDrop={drop(col.code)}>
                  {rich(col.text)}
                </button>
              );
            })}
          </div>
          {multi && (
            <div className="sort-next">
              <button type="button" className="btn btn-secondary btn-sm" disabled={!sorted(v[String(card.code)])}
                onClick={() => setCurrent(nextAfter(v, card.code))}>
                {nextAfter(v, card.code) === null ? 'Готово' : 'Следующая карточка'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="sort-done">{done === cards.length ? 'Все карточки разложены. Их можно переложить: нажмите на карточку в группе.' : 'Выберите карточку, чтобы разложить её.'}</div>
      )}
      <div className="sort-piles">
        {columns.map((col) => {
          const inPile = cards.filter((c) => inCol(v[String(c.code)], col.code));
          return (
            <div key={col.code} className={`sort-pile${dragOver === -col.code - 1 ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(-col.code - 1); }} onDragLeave={() => setDragOver(null)} onDrop={drop(col.code)}>
              <div className="sort-pile-title">{rich(col.text)} <span className="muted">{inPile.length}</span></div>
              <div className="sort-chips">
                {inPile.map((c) => (
                  <span key={c.code} className={`sort-chip${c.code === current ? ' current' : ''}`} draggable onDragStart={drag(c.code)}>
                    <button type="button" className="sort-chip-text" title="Переложить" onClick={() => setCurrent(c.code)}>{face(c)}</button>
                    <button type="button" className="sort-chip-x" aria-label="Вернуть карточку" title="Вернуть" onClick={() => unsort(c.code)}>×</button>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {sharedBlock}
    </div>
  );
}

/** Семантический дифференциал: левый полюс — точки шкалы — правый полюс; на телефоне полюса над точками */
export function Differential({ q, rows, columns, v, emit, sharedBlock }: Props) {
  const pick = (row: number, col: number) => emit({ ...v, [String(row)]: col });
  return (
    <>
      <div className="diff" style={{ '--n': columns.length } as CSSProperties}>
        {rows.map((r) => (r.group ? (r.groupHidden ? null : <div key={`g${r.code}`} className="diff-group">{rich(r.text)}</div>) : (
          <div key={r.code} className={`diff-row${sorted(v[String(r.code)]) ? ' answered' : ' unanswered'}`} role="radiogroup" aria-label={`${r.text} – ${r.right ?? ''}`}>
            <span className="diff-left">{rich(r.text)}</span>
            <span className="diff-points">
              {columns.map((c) => {
                const on = v[String(r.code)] === c.code;
                return (
                  <label key={c.code} className={`diff-point${on ? ' selected' : ''}`} title={c.text}>
                    <input type="radio" name={`${q.id}_${r.code}`} checked={on} onChange={() => pick(r.code, c.code)} />
                    <span className="diff-dot" />
                    <span className="diff-cap">{c.text}</span>
                  </label>
                );
              })}
            </span>
            <span className="diff-right">{rich(r.right ?? '')}</span>
          </div>
        )))}
      </div>
      {sharedBlock}
    </>
  );
}
