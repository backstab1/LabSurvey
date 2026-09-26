import { ImageField } from './ImageField.tsx';
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
  /** Открытое значение-число, дата, время, многострочное, пустое */
  openTypes?: boolean;
  /** Заголовки групп (и «блокирующий в группе» при exclusive) */
  groups?: boolean;
  /** «Исключить поле при выгрузке» — у варианта есть свои переменные */
  noExport?: boolean;
  /** «Отключить выгрузку открытого значения» */
  noExportOther?: boolean;
  /** «Всегда отображается», «Запрещено использовать в циклах» */
  logic?: boolean;
  /** «Расположить в первой колонке внизу» */
  bottom?: boolean;
  /** «Проверка ответа скриптами» */
  script?: boolean;
  /** «Скрыть текст варианта» */
  hideText?: boolean;
  /** «Общий для всей таблицы» (столбцы матрицы) */
  shared?: boolean;
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
                <div key={i} className={`list-item${isOpen ? ' open' : ''}${o.hidden ? ' is-hidden' : ''}${o.group ? ' is-group' : ''}`}>
                  <div className="list-row" role="row" onClick={() => { setOpen(isOpen ? null : i); setTab('main'); }}>
                    <span className={`list-code mono${dupCodes.has(o.code) ? ' dup' : ''}`} title={dupCodes.has(o.code) ? 'Код повторяется' : undefined}>{o.code}</span>
                    <span className="list-text">{o.text || <span className="muted">{placeholder}</span>}</span>
                    <span className="list-marks">
                      {o.group && <span className="mark">группа{o.groupHidden ? ' (скрыт)' : ''}</span>}
                      {o.other && <span className="mark">открытое{o.otherType === 'number' ? ' число' : o.otherType === 'date' ? ' дата' : o.otherType === 'time' ? ' время' : ''}</span>}
                      {o.exclusive && <span className="mark">искл.</span>}
                      {o.groupExclusive && <span className="mark">искл. в группе</span>}
                      {o.alwaysShow && <span className="mark">всегда</span>}
                      {o.bottom && <span className="mark">внизу</span>}
                      {o.noExport && <span className="mark" title="Исключить поле при выгрузке">без выгрузки</span>}
                      {o.script && <span className="mark">JS</span>}
                      {o.shared && <span className="mark">на всю таблицу</span>}
                      {o.fixed && <span className="mark" title="Не подлежит рандомизации">📌</span>}
                      {o.hidden && <span className="mark">скрыт</span>}
                      {o.image && <img className="list-thumb" src={o.image} alt="" title="Картинка" />}
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
                            <div className="list-image-field">
                              <ImageField value={o.image} onChange={(image) => setAt(i, { image })} />
                            </div>
                          )}
                        </div>
                      ) : (
                        <OptionSettings o={o} features={features} set={(p) => setAt(i, p)} />
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

/** Настройки варианта — флажки как в Survey Studio; недоступные в текущем состоянии — серые */
function OptionSettings({ o, features: f, set }: { o: Option; features: ListFeatures; set: (p: Partial<Option>) => void }) {
  const [showScript, setShowScript] = useState(!!o.script);
  const isGroup = !!o.group;
  const open = !!o.other && !isGroup;
  const textOpen = open && !o.otherType;
  const clearOpen = { other: undefined, otherType: undefined, otherMultiline: undefined, otherDecimals: undefined, otherOptional: undefined, noExportOther: undefined };
  const left = [
    f.other && f.openTypes && <Flag key="on" label="С открытым значением (число)" disabled={isGroup} checked={open && o.otherType === 'number'}
      onChange={(v) => set(v ? { other: true, otherType: 'number', otherMultiline: undefined } : clearOpen)} />,
    f.other && <Flag key="ot" label="С открытым значением (текст)" disabled={isGroup} checked={open && o.otherType !== 'number'}
      hint={f.openTypes ? undefined : 'Рядом с вариантом поле «укажите»'}
      onChange={(v) => set(v ? { other: true, otherType: undefined, otherDecimals: undefined } : clearOpen)} />,
    f.other && f.openTypes && <Flag key="ml" label="Многострочный текст" disabled={!textOpen} checked={textOpen && !!o.otherMultiline}
      onChange={(v) => set({ otherMultiline: v || undefined })} />,
    f.exclusive && <Flag key="ex" label="Блокирующий / исключающий" hint="Выбор снимает остальные варианты" disabled={isGroup} checked={!!o.exclusive}
      onChange={(v) => set({ exclusive: v || undefined, groupExclusive: undefined })} />,
    f.exclusive && f.groups && <Flag key="gex" label="Блокирующий в группе" hint="Снимает остальные варианты своей группы" disabled={isGroup || !!o.exclusive}
      checked={!!o.groupExclusive} onChange={(v) => set({ groupExclusive: v || undefined })} />,
    f.logic && <Flag key="al" label="Всегда отображается" hint="Действия «скрыть варианты» его не скрывают" disabled={isGroup} checked={!!o.alwaysShow}
      onChange={(v) => set({ alwaysShow: v || undefined })} />,
    f.flags && <Flag key="fx" label="Не подлежит рандомизации / ротации" hint="Остаётся на своём месте" disabled={isGroup} checked={!!o.fixed}
      onChange={(v) => set({ fixed: v || undefined })} />,
    f.logic && <Flag key="nl" label="Запрещено использовать в циклах" hint="Не становится повтором цикла" disabled={isGroup} checked={!!o.noLoop}
      onChange={(v) => set({ noLoop: v || undefined })} />,
    f.noExport && <Flag key="ne" label="Исключить поле при выгрузке" disabled={isGroup} checked={!!o.noExport}
      onChange={(v) => set({ noExport: v || undefined })} />,
    f.noExportOther && <Flag key="neo" label="Отключить выгрузку открытого значения" disabled={!open} checked={open && !!o.noExportOther}
      onChange={(v) => set({ noExportOther: v || undefined })} />,
    f.groups && <Flag key="g" label="Заголовок группы" hint="Не выбирается; объединяет варианты ниже до следующего заголовка" checked={isGroup}
      onChange={(v) => set(v ? { ...clearOpen, group: true, exclusive: undefined, groupExclusive: undefined, bottom: undefined, script: undefined, score: undefined } : { group: undefined, groupHidden: undefined })} />,
    f.groups && <Flag key="gh" label="Скрыть заголовок группы" hint="Группа остаётся для перемешивания и блокировки" disabled={!isGroup} checked={isGroup && !!o.groupHidden}
      onChange={(v) => set({ groupHidden: v || undefined })} />,
  ].filter(Boolean);
  const right = [
    f.flags && <Flag key="h" label="Скрыть в режиме респондента" hint="Код остаётся в выгрузке и условиях" checked={!!o.hidden}
      onChange={(v) => set({ hidden: v || undefined })} />,
    f.other && f.openTypes && <Flag key="dec" label="Разрешить ввод дробных чисел" disabled={!(open && o.otherType === 'number')} checked={open && !!o.otherDecimals}
      onChange={(v) => set({ otherDecimals: v || undefined })} />,
    f.other && f.openTypes && <Flag key="opt" label="Разрешить пустые открытые значения" disabled={!open} checked={open && !!o.otherOptional}
      onChange={(v) => set({ otherOptional: v || undefined })} />,
    f.hideText && <Flag key="ht" label="Скрыть текст варианта" hint="Например, вариант-картинка" disabled={isGroup} checked={!!o.hideText}
      onChange={(v) => set({ hideText: v || undefined })} />,
    f.bottom && <Flag key="b" label="Расположить в первой колонке внизу" hint="Всегда последним, под колонками" disabled={isGroup} checked={!!o.bottom}
      onChange={(v) => set({ bottom: v || undefined })} />,
    f.script && <Flag key="sc" label="Проверка ответа скриптами" hint="JS при «Далее», если вариант выбран" disabled={isGroup} checked={showScript || !!o.script}
      onChange={(v) => { setShowScript(v); if (!v) set({ script: undefined }); }} />,
    f.other && f.openTypes && <Flag key="d" label="Использовать выбор даты" disabled={!open || o.otherType === 'number'} checked={open && o.otherType === 'date'}
      onChange={(v) => set({ otherType: v ? 'date' : undefined, otherMultiline: undefined })} />,
    f.other && f.openTypes && <Flag key="t" label="Использовать выбор времени" disabled={!open || o.otherType === 'number'} checked={open && o.otherType === 'time'}
      onChange={(v) => set({ otherType: v ? 'time' : undefined, otherMultiline: undefined })} />,
    f.shared && <Flag key="sh" label="Общий для всей таблицы" hint="Один вариант под таблицей, отмечает все строки" checked={!!o.shared}
      onChange={(v) => set({ shared: v || undefined })} />,
  ].filter(Boolean);
  if (!left.length && !right.length) return <p className="muted small" style={{ margin: 0 }}>У вариантов этого списка нет настроек.</p>;
  let scriptError = '';
  if (o.script) { try { new Function('sl', o.script); } catch (e) { scriptError = (e as Error).message; } }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="list-flags">
        <div className="flags">{left}</div>
        <div className="flags">{right}</div>
      </div>
      {(showScript || o.script) && !isGroup && (
        <label className="field"><span>Скрипт проверки: вернуть строку — это текст ошибки. <code>sl.value</code> — открытое значение, <code>sl.get("Q1")</code> — ответы</span>
          <textarea className="input mono" rows={3} spellCheck={false} value={o.script ?? ''} placeholder='if (Number(sl.value) > 100) return "Не больше 100";'
            onChange={(e) => set({ script: e.target.value || undefined })} />
          {scriptError && <span className="field-error">Синтаксическая ошибка: {scriptError}</span>}
        </label>
      )}
    </div>
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
