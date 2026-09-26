import { useEffect, useRef, useState } from 'react';
import { Flag, Modal, Segmented, compact } from './common.tsx';
import { allQuestions } from '../../../shared/logic.ts';
import { OPTION_TYPES, type Option, type OptionsFrom, type Survey } from '../../../shared/types.ts';

/** Что можно настраивать у вариантов этого списка */
export interface ListFeatures {
  /** «С открытым значением» — поле «укажите» */
  other?: boolean;
  /** «Блокирующий / исключающий» (multi) */
  exclusive?: boolean;
  /** «Не подлежит рандомизации» и «Скрыть в режиме респондента» */
  flags?: boolean;
  /** Баллы для формул score() */
  scores?: boolean;
  /** Картинка варианта */
  image?: boolean;
  /** Быстрые кнопки «Другое» / «Затрудняюсь» */
  quickAdd?: boolean;
}

/** Перенос вариантов из другого вопроса — показывается над списком */
export interface CarryProps {
  def: Survey;
  self: string;
  value: OptionsFrom | undefined;
  onChange: (v: OptionsFrom | undefined) => void;
}

/** Краткое содержимое списка для кнопки: «Каждый день, Несколько раз…» */
export function listSummary(options: Option[], from?: OptionsFrom): string {
  const texts = options.map((o) => o.text.trim()).filter(Boolean);
  const head = texts.slice(0, 4).join(', ') + (texts.length > 4 ? ` и ещё ${texts.length - 4}` : '');
  const carry = from ? `+ из ${from.question}` : '';
  return [head || (options.length ? 'варианты без текста' : 'пусто'), carry].filter(Boolean).join(' ');
}

/**
 * Редактор списка вариантов (как в Survey Studio): таблица «Код | Текст», клик по строке раскрывает её —
 * вкладки «Основное» (текст, код, картинка, баллы) и «Настройки» (флажки варианта).
 */
export function OptionsListDialog({ title, options, onChange, onClose, features, placeholder = 'Текст варианта', carry }: {
  title: string;
  options: Option[];
  onChange: (o: Option[]) => void;
  onClose: () => void;
  features: ListFeatures;
  placeholder?: string;
  carry?: CarryProps;
}) {
  // Раскрыт первый пустой вариант (новый вопрос) — можно сразу печатать
  const [open, setOpen] = useState<number | null>(() => {
    const i = options.findIndex((o) => !o.text);
    return i >= 0 ? i : null;
  });
  const [tab, setTab] = useState<'main' | 'settings'>('main');
  const [bulk, setBulk] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const textRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open !== null && tab === 'main') textRef.current?.focus(); }, [open, focusTick, tab]);

  const regular = options.filter((o) => o.code < 90).map((o) => o.code);
  const nextCode = (taken = new Set(options.map((o) => o.code))) => {
    let c = regular.length ? Math.max(...regular) + 1 : 1;
    while (taken.has(c)) c++;
    return c;
  };
  const dupCodes = new Set(options.map((o) => o.code).filter((c, i, a) => a.indexOf(c) !== i));

  const setAt = (i: number, patch: Partial<Option>) => onChange(options.map((o, k) => (k === i ? compact({ ...o, ...patch }) : o)));
  const insertAt = (i: number, items: Option[], expand = i) => {
    const next = options.slice();
    next.splice(i, 0, ...items);
    onChange(next);
    setOpen(expand);
    setTab('main');
    setFocusTick((t) => t + 1);
  };
  const remove = (i: number) => {
    onChange(options.filter((_, k) => k !== i));
    setOpen(open === i ? null : open !== null && open > i ? open - 1 : open);
  };
  const move = (i: number, dir: -1 | 1) => {
    const next = options.slice();
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
    if (open === i) setOpen(i + dir); else if (open === i + dir) setOpen(i);
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

  const addOther = () => insertAt(options.length, [{ code: options.some((o) => o.code === 97) ? nextCode() : 97, text: 'Другое', ...(features.other ? { other: true } : {}) }]);
  const addDk = () => insertAt(options.length, [compact({ code: 99, text: 'Затрудняюсь ответить', exclusive: features.exclusive || undefined })]);

  return (
    <Modal size="medium" className="list-modal" onClose={onClose} title={<>{title} <span className="muted" style={{ fontWeight: 400 }}>· {options.length}</span></>}
      actions={<button className="btn btn-primary btn-sm" onClick={onClose}>Готово</button>}>
      {bulk !== null ? (
        <div className="stack" style={{ gap: 8 }}>
          <textarea className="input" rows={Math.max(8, bulk.split('\n').length + 1)} autoFocus value={bulk} onChange={(e) => setBulk(e.target.value)}
            placeholder={'По одному варианту в строке.\nКод можно указать в начале: «97. Другое»'} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => {
              const old = new Map(options.map((o) => [o.code, o]));
              // Настройки вариантов сохраняются у вариантов с теми же кодами
              onChange(parseLines(bulk, new Set()).map((o) => ({ ...old.get(o.code), ...o })));
              setBulk(null);
              setOpen(null);
            }}>Применить</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setBulk(null)}>Отмена</button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <div className="list-toolbar">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => insertAt(options.length, [{ code: nextCode(), text: '' }])}>+ Добавить</button>
            {features.quickAdd && !options.some((o) => o.other || o.code === 97) && <button type="button" className="btn btn-secondary btn-sm" onClick={addOther}>+ «Другое»</button>}
            {features.quickAdd && !options.some((o) => o.code === 99) && <button type="button" className="btn btn-secondary btn-sm" onClick={addDk}>+ «Затрудняюсь»</button>}
            <button type="button" className="btn btn-secondary btn-sm" title="Ввести или вставить все варианты текстом"
              onClick={() => setBulk(options.map((o) => `${o.code}. ${o.text}`).join('\n'))}>Списком</button>
            {options.filter((o) => o.code < 90).some((o, i) => o.code !== i + 1) && (
              <button type="button" className="btn btn-secondary btn-sm" title="Обычные варианты получат коды 1, 2, 3… по порядку; коды 90+ не меняются"
                onClick={() => {
                  if (!window.confirm('Перенумеровать коды по порядку? Условия и действия, ссылающиеся на старые коды, нужно будет проверить.')) return;
                  let n = 0;
                  onChange(options.map((o) => (o.code < 90 ? { ...o, code: ++n } : o)));
                }}>Коды по порядку</button>
            )}
          </div>

          {carry && <CarryForward {...carry} />}

          <div className="list-table" role="table">
            <div className="list-head" role="row">
              <span>Код</span><span>Текст</span><span />
            </div>
            {options.length === 0 && <div className="list-empty muted small">Вариантов нет — нажмите «+ Добавить» или «Списком».</div>}
            {options.map((o, i) => {
              const isOpen = open === i;
              return (
                <div key={i} className={`list-item${isOpen ? ' open' : ''}${o.hidden ? ' is-hidden' : ''}`}>
                  <div className="list-row" role="row" onClick={() => { setOpen(isOpen ? null : i); setTab('main'); }}>
                    <span className={`list-code mono${dupCodes.has(o.code) ? ' dup' : ''}`} title={dupCodes.has(o.code) ? 'Код повторяется' : undefined}>{o.code}</span>
                    <span className="list-text">{o.text || <span className="muted">{placeholder}</span>}</span>
                    <span className="list-marks">
                      {o.other && <span className="mark">открытое</span>}
                      {o.exclusive && <span className="mark">искл.</span>}
                      {o.fixed && <span className="mark" title="Не подлежит рандомизации">📌</span>}
                      {o.hidden && <span className="mark">скрыт</span>}
                      {o.image && <span className="mark" title={o.image}>🖼</span>}
                      {o.score !== undefined && <span className="mark" title="Баллы">{o.score} б.</span>}
                    </span>
                    <span className="list-tools" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="icon-btn" title="Выше" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button type="button" className="icon-btn" title="Ниже" disabled={i === options.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button type="button" className="icon-btn" title="Копировать вариант" onClick={() => insertAt(i + 1, [{ ...o, code: nextCode() }])}>⧉</button>
                      <button type="button" className="icon-btn" title="Удалить" onClick={() => remove(i)}>✕</button>
                    </span>
                  </div>
                  {isOpen && (
                    <div className="list-editor">
                      <div className="tabs list-tabs">
                        <button type="button" className={`tab${tab === 'main' ? ' active' : ''}`} onClick={() => setTab('main')}>Основное</button>
                        <button type="button" className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>Настройки</button>
                      </div>
                      {tab === 'main' ? (
                        <div className="list-main">
                          <label className="field list-code-field"><span>Код</span>
                            <input className={`input mono${dupCodes.has(o.code) ? ' invalid' : ''}`} type="number" value={o.code}
                              onChange={(e) => setAt(i, { code: Number(e.target.value) })} />
                          </label>
                          <label className="field grow"><span>Текст</span>
                            <input ref={textRef} className="input opt-text" value={o.text} placeholder={placeholder}
                              onChange={(e) => setAt(i, { text: e.target.value })}
                              onKeyDown={(e) => {
                                // Enter — следующий вариант (как в быстром вводе), Backspace в пустом — удалить
                                if (e.key === 'Enter') { e.preventDefault(); insertAt(i + 1, [{ code: nextCode(), text: '' }]); }
                                else if (e.key === 'Backspace' && o.text === '' && options.length > 1) {
                                  e.preventDefault();
                                  onChange(options.filter((_, k) => k !== i));
                                  setOpen(Math.max(0, i - 1));
                                  setFocusTick((t) => t + 1);
                                } else if (e.key === 'ArrowDown' && i < options.length - 1) { e.preventDefault(); setOpen(i + 1); }
                                else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); setOpen(i - 1); }
                              }}
                              onPaste={(e) => {
                                const text = e.clipboardData.getData('text');
                                if (!text.includes('\n')) return;
                                e.preventDefault();
                                const items = parseLines(text, new Set(options.map((x) => x.code)));
                                if (o.text === '') {
                                  const next = options.slice();
                                  next.splice(i, 1, ...items.map((it, k) => (k === 0 ? { ...it, code: o.code } : it)));
                                  onChange(next);
                                  setOpen(i + items.length - 1);
                                } else insertAt(i + 1, items, i + items.length);
                              }} />
                          </label>
                          {features.scores && (
                            <label className="field list-code-field"><span>Баллы</span>
                              <input className="input" type="number" value={o.score ?? ''} title="Для формул score(…)"
                                onChange={(e) => setAt(i, { score: e.target.value === '' ? undefined : Number(e.target.value) })} />
                            </label>
                          )}
                          {features.image && (
                            <label className="field list-image-field"><span>Картинка (https://…)</span>
                              <input className="input mono" value={o.image ?? ''} placeholder="необязательно"
                                onChange={(e) => setAt(i, { image: e.target.value.trim() || undefined })} />
                            </label>
                          )}
                        </div>
                      ) : (
                        <div className="flags list-flags">
                          {features.other && <Flag label="С открытым значением (текст)" hint="Рядом с вариантом поле «укажите»" checked={!!o.other} onChange={(v) => setAt(i, { other: v || undefined })} />}
                          {features.exclusive && <Flag label="Блокирующий / исключающий" hint="Выбор снимает остальные варианты" checked={!!o.exclusive} onChange={(v) => setAt(i, { exclusive: v || undefined })} />}
                          {features.flags && <Flag label="Не подлежит рандомизации / ротации" hint="Остаётся на своём месте" checked={!!o.fixed} onChange={(v) => setAt(i, { fixed: v || undefined })} />}
                          {features.flags && <Flag label="Скрыть в режиме респондента" hint="Код остаётся в выгрузке и условиях" checked={!!o.hidden} onChange={(v) => setAt(i, { hidden: v || undefined })} />}
                          {!features.other && !features.exclusive && !features.flags && <p className="muted small" style={{ margin: 0 }}>У вариантов этого списка нет настроек.</p>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Enter в тексте — следующий вариант. Вставка нескольких строк — несколько вариантов («97. Другое» задаёт код).</p>
        </div>
      )}
    </Modal>
  );
}

function CarryForward({ def, self, value, onChange }: CarryProps) {
  const idx = allQuestions(def).findIndex((x) => x.id === self);
  const sources = allQuestions(def).slice(0, Math.max(0, idx)).filter((x) => OPTION_TYPES.includes(x.type));
  if (!sources.length && !value) return null;
  return (
    <div className="carry">
      <span className="small">Добавить варианты из вопроса</span>
      <select className="input" value={value?.question ?? ''}
        onChange={(e) => onChange(e.target.value ? { question: e.target.value, filter: value?.filter ?? 'selected' } : undefined)}>
        <option value="">— не переносить —</option>
        {sources.map((s) => <option key={s.id} value={s.id}>{s.id}{s.text ? ` · ${s.text.slice(0, 50)}` : ''}</option>)}
        {value && !sources.some((s) => s.id === value.question) && <option value={value.question}>{value.question}</option>}
      </select>
      {value && (
        <Segmented value={value.filter} onChange={(filter) => onChange({ ...value, filter })}
          options={[{ value: 'selected', label: 'Выбранные' }, { value: 'notSelected', label: 'Невыбранные' }, { value: 'all', label: 'Все' }]} />
      )}
    </div>
  );
}
