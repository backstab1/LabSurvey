import { useEffect, useRef, useState } from 'react';
import { compact } from './common.tsx';
import type { Option } from '../../../shared/types.ts';

/**
 * Список вариантов. Быстрый ввод: Enter — новый вариант, Backspace в пустом — удалить,
 * вставка нескольких строк — несколько вариантов («97. Другое» задаёт код).
 */
export function OptionsEditor({ options, onChange, allowOther, allowExclusive, quickAdd, placeholder = 'Вариант', emptyHint }: {
  options: Option[];
  onChange: (o: Option[]) => void;
  allowOther?: boolean;
  allowExclusive?: boolean;
  /** Быстрые кнопки «Другое» / «Затрудняюсь» */
  quickAdd?: boolean;
  placeholder?: string;
  emptyHint?: string;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [bulk, setBulk] = useState<string | null>(null);

  useEffect(() => {
    if (focusIdx === null) return;
    inputs.current[focusIdx]?.focus();
    setFocusIdx(null);
  }, [focusIdx, options.length]);

  const regularCodes = options.filter((o) => o.code < 90).map((o) => o.code);
  const nextCode = (taken = new Set(options.map((o) => o.code))) => {
    let c = regularCodes.length ? Math.max(...regularCodes) + 1 : 1;
    while (taken.has(c)) c++;
    return c;
  };

  const setAt = (i: number, patch: Partial<Option>) => onChange(options.map((o, k) => (k === i ? compact({ ...o, ...patch }) : o)));
  const insertAfter = (i: number, items: Option[]) => {
    const next = options.slice();
    next.splice(i + 1, 0, ...items);
    onChange(next);
    setFocusIdx(i + items.length);
  };
  const remove = (i: number) => onChange(options.filter((_, k) => k !== i));
  const move = (i: number, dir: -1 | 1) => {
    const next = options.slice();
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };

  const parseLines = (text: string, taken: Set<number>): Option[] => {
    const re = /^(\d+)[.)\t:-]\s*(.+)$/;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    lines.forEach((l) => { const m = l.match(re); if (m) taken.add(Number(m[1])); });
    return lines.map((l) => {
      const m = l.match(re);
      if (m) return { code: Number(m[1]), text: m[2] };
      const code = nextCode(taken);
      taken.add(code);
      return { code, text: l };
    });
  };

  if (bulk !== null) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <textarea className="input" rows={Math.max(6, bulk.split('\n').length + 1)} autoFocus value={bulk} onChange={(e) => setBulk(e.target.value)}
          placeholder={'По одному варианту в строке.\nКод можно указать в начале: «97. Другое»'} />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={() => {
            const old = new Map(options.map((o) => [o.code, o]));
            // Флаги «другое»/«эксклюзив» сохраняются у вариантов с теми же кодами
            onChange(parseLines(bulk, new Set()).map((o) => ({ ...old.get(o.code), ...o })));
            setBulk(null);
          }}>Готово</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setBulk(null)}>Отмена</button>
        </div>
      </div>
    );
  }

  return (
    <div className="options-editor">
      {options.length === 0 && emptyHint && <p className="muted small">{emptyHint}</p>}
      {options.map((o, i) => (
        <div key={i} className="opt-row">
          <input className="opt-code" type="number" title="Код ответа" value={o.code}
            onChange={(e) => setAt(i, { code: Number(e.target.value) })} />
          <input ref={(el) => { inputs.current[i] = el; }} className="opt-text" value={o.text} placeholder={placeholder}
            onChange={(e) => setAt(i, { text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                insertAfter(i, [{ code: nextCode(), text: '' }]);
              } else if (e.key === 'Backspace' && o.text === '' && options.length > 1) {
                e.preventDefault();
                remove(i);
                setFocusIdx(Math.max(0, i - 1));
              } else if (e.key === 'ArrowDown') {
                inputs.current[i + 1]?.focus();
              } else if (e.key === 'ArrowUp') {
                inputs.current[i - 1]?.focus();
              }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (!text.includes('\n')) return;
              e.preventDefault();
              const taken = new Set(options.map((x) => x.code));
              const items = parseLines(text, taken);
              if (o.text === '') {
                // Пустая строка заменяется первой вставленной
                const next = options.slice();
                next.splice(i, 1, ...items.map((it, k) => (k === 0 ? { ...it, code: o.code } : it)));
                onChange(next);
                setFocusIdx(i + items.length - 1);
              } else insertAfter(i, items);
            }} />
          {allowOther && (
            <button type="button" className={`chip${o.other ? ' on' : ''}`} title="Поле «укажите»"
              onClick={() => setAt(i, { other: o.other ? undefined : true })}>другое</button>
          )}
          {allowExclusive && (
            <button type="button" className={`chip${o.exclusive ? ' on' : ''}`} title="Снимает остальные варианты"
              onClick={() => setAt(i, { exclusive: o.exclusive ? undefined : true })}>искл.</button>
          )}
          <span className="row-tools">
            <button type="button" className="icon-btn" title="Выше" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="icon-btn" title="Ниже" disabled={i === options.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="icon-btn" title="Удалить" onClick={() => remove(i)}>✕</button>
          </span>
        </div>
      ))}
      <div className="opt-actions">
        <button type="button" className="btn-link" onClick={() => insertAfter(options.length - 1, [{ code: nextCode(), text: '' }])}>+ вариант</button>
        {quickAdd && !options.some((o) => o.other) && (
          <button type="button" className="btn-link" onClick={() => onChange([...options, { code: options.some((o) => o.code === 97) ? nextCode() : 97, text: 'Другое', other: true }])}>+ «Другое»</button>
        )}
        {quickAdd && !options.some((o) => o.code === 99) && (
          <button type="button" className="btn-link" onClick={() => onChange([...options, compact({ code: 99, text: 'Затрудняюсь ответить', exclusive: allowExclusive || undefined })])}>+ «Затрудняюсь»</button>
        )}
        <button type="button" className="btn-link" onClick={() => setBulk(options.map((o) => `${o.code}. ${o.text}`).join('\n'))}>списком</button>
        {options.filter((o) => o.code < 90).some((o, i) => o.code !== i + 1) && (
          <button type="button" className="btn-link" title="Обычные варианты получат коды 1, 2, 3… по порядку; коды 90+ не меняются"
            onClick={() => {
              if (!window.confirm('Перенумеровать коды по порядку? Условия и действия, ссылающиеся на старые коды, нужно будет проверить.')) return;
              let n = 0;
              onChange(options.map((o) => (o.code < 90 ? { ...o, code: ++n } : o)));
            }}>коды по порядку</button>
        )}
      </div>
    </div>
  );
}
