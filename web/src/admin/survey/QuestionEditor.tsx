import { useState } from 'react';
import { ConjointBody, FileBody, HotspotBody, MaxDiffBody, SliderBody } from './AdvancedEditors.tsx';
import { ConditionField } from './ConditionEditor.tsx';
import { ActionsEditor } from './ActionsEditor.tsx';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { RichText, pipeTargets } from '../RichText.tsx';
import { OptionsListDialog, listSummary, type CarryProps, type ListFeatures } from './OptionsListDialog.tsx';
import { CALC_FUNCTIONS, parseCalc } from '../../../../shared/calc.ts';
import { allIds } from '../../../../shared/refactor.ts';
import { ID_RE, RESERVED_IDS } from '../../../../shared/validate.ts';
import { Menu, Modal, NumField, Segmented, compact, copyText } from '../common.tsx';
import { newQuestion } from './Builder.tsx';
import { TypeIcon } from './TypeIcon.tsx';
import {
  CHOICE_TYPES, CONSENT_LABEL, KIND_GROUPS, KIND_LABELS, kindOf, type Action, type Option, type OptionsFrom, type Question, type QuestionKind, type Survey,
} from '../../../../shared/types.ts';
import { Block, questionSettings } from './QuestionSettings.tsx';
import type { Patch } from './AdvancedEditors.tsx';
/** Смена типа с сохранением всего, что можно перенести */
function convert(q: Question, kind: QuestionKind): Question {
  const fresh = newQuestion(kind, q.id) as any;
  const type = fresh.type as Question['type'];
  const old = q as any;
  const keep = {
    id: q.id, text: q.text || fresh.text, hint: q.hint, required: q.required, showIf: q.showIf, scripts: q.scripts, actions: q.actions,
    hideBack: q.hideBack, hideFinish: q.hideFinish, requiredMessage: q.requiredMessage, note: q.note, fixed: q.fixed,
    prefillParam: q.prefillParam, prefillSkip: q.prefillSkip,
  };
  // rows у открытого вопроса — высота поля (число), а не строки матрицы
  const opts: Option[] | undefined = Array.isArray(old.options) ? old.options : Array.isArray(old.rows) ? old.rows : undefined;
  if (CHOICE_TYPES.includes(type) && opts?.length) {
    return compact({
      ...fresh, ...keep, order: old.order ?? old.rowOrder, optionsFrom: old.optionsFrom ?? old.rowsFrom,
      options: opts.map((o) => compact({ ...o, exclusive: type === 'multi' ? o.exclusive : undefined, other: type === 'ranking' ? undefined : o.other })),
    }) as Question;
  }
  if (type === 'matrix' && q.type === 'matrix') {
    // Смена вида матрицы (таблица, карточки, дифференциал): строки и столбцы остаются
    const rows = fresh.view === 'differential' ? q.rows : q.rows.map((r) => compact({ ...r, right: undefined }));
    return compact({ ...q, rows, view: fresh.view, mode: fresh.view === 'differential' ? 'single' : q.mode }) as Question;
  }
  if (type === 'matrix' && opts?.length) {
    return compact({ ...fresh, ...keep, rows: opts.map((o) => compact({ ...o, exclusive: undefined })), rowsFrom: old.optionsFrom ?? old.rowsFrom }) as Question;
  }
  return compact({ ...fresh, ...keep }) as Question;
}

interface Props {
  def: Survey;
  q: Question;
  prevId?: string;
  position: string;
  onChange: (q: Question) => void;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onNav: (dir: -1 | 1) => void;
  hasPrev: boolean;
  hasNext: boolean;
  onCreateVar: () => string;
  /** Смена ID с обновлением всех ссылок на вопрос */
  onRename: (newId: string) => void;
  onPreview: () => void;
}

type Tab = 'main' | 'actions' | 'scripts' | 'settings';
/** Вкладка сохраняется при переходе ‹ › между вопросами */
let lastTab: Tab = 'main';

export function QuestionDialog({ def, q, prevId, position, onChange, onClose, onDelete, onDuplicate, onNav, hasPrev, hasNext, onCreateVar, onRename, onPreview }: Props) {
  const set = (patch: Patch) => onChange(compact({ ...q, ...patch } as Question));
  const [showHint, setShowHint] = useState(!!q.hint);
  const [showNote, setShowNote] = useState(!!q.note);
  const [idDraft, setIdDraft] = useState(q.id);
  const [idError, setIdError] = useState('');
  const commitId = () => {
    const next = idDraft.trim();
    if (next === q.id) return setIdError('');
    if (!ID_RE.test(next)) return setIdError('Латиница, цифры и _, начинается с буквы');
    if (RESERVED_IDS.has(next.toLowerCase())) return setIdError('Зарезервированное имя');
    if (allIds(def).some((x) => x !== q.id && x.toLowerCase() === next.toLowerCase())) return setIdError('Такой ID уже есть');
    setIdError('');
    onRename(next);
  };
  const answerable = q.type !== 'info' && q.type !== 'hidden';
  const pipes = pipeTargets(def, q.id);
  const settings = questionSettings(def, q, set);
  const actionCount = (q.actions?.before?.length ?? 0) + (q.actions?.after?.length ?? 0);
  const scriptCount = Object.values(q.scripts ?? {}).filter(Boolean).length;
  const tabs: [Tab, string, number][] = [['main', 'Основное', 0]];
  if (q.type !== 'hidden') tabs.push(['actions', 'Действия', actionCount], ['scripts', 'Скрипты', scriptCount]);
  if (settings.body.length) tabs.push(['settings', 'Настройки', settings.on.length]);
  const [tab, setTabState] = useState<Tab>(lastTab);
  const setTab = (t: Tab) => { lastTab = t; setTabState(t); };
  const current = tabs.some(([t]) => t === tab) ? tab : 'main';
  const setActions = (phase: 'before' | 'after', list: Action[] | undefined) => {
    const next = compact({ ...q.actions, [phase]: list });
    set({ actions: Object.keys(next).length ? next : undefined });
  };

  return (
    <Modal size="medium" onClose={onClose}
      title={<><span className="type-icon"><TypeIcon kind={kindOf(q)} /></span> {q.id} <span className="muted" style={{ fontWeight: 400 }}>· {position}</span></>}
      actions={<>
        <button className="icon-btn" title="Предыдущий вопрос" disabled={!hasPrev} onClick={() => onNav(-1)}>‹</button>
        <button className="icon-btn" title="Следующий вопрос" disabled={!hasNext} onClick={() => onNav(1)}>›</button>
        <Menu items={[
          { label: 'Предпросмотр с этого вопроса', onClick: onPreview },
          { label: 'Дублировать', onClick: onDuplicate },
          { label: 'Копировать (JSON)', onClick: () => copyText(JSON.stringify(q, null, 2), `${q.id} скопирован – вставьте через «+» в любой анкете`) },
          { label: 'Удалить вопрос', onClick: onDelete, danger: true },
        ]} />
        <button className="btn btn-primary btn-sm" onClick={onClose}>Готово</button>
      </>}>
      <div className="qdialog">
        <div className="tabs qtabs" role="tablist">
          {tabs.map(([t, label, n]) => (
            <button key={t} type="button" role="tab" aria-selected={current === t} className={`tab${current === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {label}{n > 0 && <span className="tab-count">{n}</span>}
            </button>
          ))}
        </div>

        {current === 'main' && (
          <div className="stack">
            <div className="qhead">
              <label className="field" style={{ width: 130 }}><span>ID / переменная</span>
                <input className={`input mono${idError ? ' invalid' : ''}`} value={idDraft} title="Все ссылки на вопрос обновятся автоматически"
                  onChange={(e) => setIdDraft(e.target.value)} onBlur={commitId}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitId(); } if (e.key === 'Escape' && idDraft !== q.id) { e.preventDefault(); setIdDraft(q.id); setIdError(''); } }} />
                {idError && <span className="field-error">{idError}</span>}
              </label>
              <label className="field grow"><span>Тип</span>
                <select className="input" value={kindOf(q)} onChange={(e) => onChange(convert(q, e.target.value as QuestionKind))}>
                  {KIND_GROUPS.map((g) => (
                    <optgroup key={g.title} label={g.title}>
                      {g.kinds.map((t) => <option key={t} value={t}>{KIND_LABELS[t]}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {answerable && q.type !== 'consent' && (
                <label className="switch" title="Без ответа нельзя перейти дальше">
                  <input type="checkbox" checked={q.required !== false} onChange={(e) => set({ required: e.target.checked ? undefined : false })} />
                  <span>Обязательный</span>
                </label>
              )}
            </div>

            {q.type === 'hidden' ? (
              <label className="field"><span>Подпись для выгрузки</span>
                <input className="input" value={q.text} autoFocus={!q.text} placeholder="Например: ID панелиста" onChange={(e) => set({ text: e.target.value })} />
              </label>
            ) : (
              <div className="field"><span>{q.type === 'info' ? 'Текст' : 'Текст вопроса'}</span>
                <RichText value={q.text} autoFocus={!q.text} pipes={pipes} placeholder={q.type === 'info' ? 'Текст для респондента' : 'Введите вопрос'}
                  onChange={(text) => set({ text })} />
              </div>
            )}
            {answerable && showHint && (
              <div className="field"><span>Подсказка под вопросом</span>
                <RichText multiline={false} value={q.hint ?? ''} autoFocus={!q.hint} pipes={pipes} onChange={(v) => set({ hint: v || undefined })} />
              </div>
            )}
            {showNote && (
              <label className="field"><span>Комментарий для команды (респондент не видит)</span>
                <textarea className="input note-input" rows={2} value={q.note ?? ''} autoFocus={!q.note}
                  placeholder="Например: из ТЗ заказчика, согласовать формулировку" onChange={(e) => set({ note: e.target.value || undefined })} />
              </label>
            )}
            {(!showHint && answerable) || !showNote ? (
              <div className="row add-links">
                {answerable && !showHint && <button type="button" onClick={() => setShowHint(true)}>+ Подсказка под вопросом</button>}
                {!showNote && <button type="button" onClick={() => setShowNote(true)}>+ Комментарий для команды</button>}
              </div>
            ) : null}

            {q.type !== 'hidden' && (
              <div className="field"><span>Условие показа</span>
                <ConditionField def={def} value={q.showIf} self={q.id} suggest={prevId} placeholder="пусто – показывать всегда"
                  onChange={(c) => set({ showIf: c })} />
              </div>
            )}

            <TypeBody def={def} q={q} set={set} />
          </div>
        )}

        {current === 'actions' && (
          <div className="stack">
            <div className="block-title">Перед показом</div>
            <ActionsEditor def={def} q={q} phase="before" value={q.actions?.before} onChange={(v) => setActions('before', v)} onCreateVar={onCreateVar} />
            {q.type !== 'info' && (
              <>
                <div className="block-title">После ответа</div>
                <ActionsEditor def={def} q={q} phase="after" value={q.actions?.after} onChange={(v) => setActions('after', v)} onCreateVar={onCreateVar} />
              </>
            )}
          </div>
        )}

        {current === 'scripts' && (
          <div className="stack">
            <p className="muted small" style={{ margin: 0 }}>JavaScript в браузере респондента, объект <code>sl</code> – см. docs/survey-format.md → «Скрипты». Обычно хватает действий.</p>
            <div className="block-title">Перед показом</div>
            <ScriptsEditor level="question" only={['beforeShow']} value={q.scripts} onChange={(sc) => set({ scripts: sc })} />
            <div className="block-title">Во время показа</div>
            <ScriptsEditor level="question" only={q.type === 'info' ? ['onShow'] : ['onShow', 'onChange']} value={q.scripts} onChange={(sc) => set({ scripts: sc })} />
            {q.type !== 'info' && (
              <>
                <div className="block-title">После ответа</div>
                <ScriptsEditor level="question" only={['validate']} value={q.scripts} onChange={(sc) => set({ scripts: sc })} />
              </>
            )}
          </div>
        )}

        {current === 'settings' && <div className="flags qsettings">{settings.body}</div>}
      </div>
    </Modal>
  );
}

/** Кнопка списка вариантов: название, количество и начало списка */
function ListButton({ title, options, from, onClick }: { title: string; options: Option[]; from?: OptionsFrom; onClick: () => void }) {
  return (
    <button type="button" className="list-btn" onClick={onClick}>
      <span className="list-btn-title">{title}<span className="tab-count">{options.length}</span></span>
      <span className="list-btn-summary">{listSummary(options, from)}</span>
      <span className="list-btn-go">›</span>
    </button>
  );
}
type ListKind = 'options' | 'rows' | 'columns' | 'extra';

/** Главное содержимое по типу: кнопки списков вариантов, строк и столбцов, шкала и т. п. */
function TypeBody({ def, q, set }: { def: Survey; q: Question; set: (p: Patch) => void }) {
  const [list, setList] = useState<ListKind | null>(null);
  const carry = (key: 'optionsFrom' | 'rowsFrom', value: OptionsFrom | undefined): CarryProps =>
    ({ def, self: q.id, value, onChange: (v) => set({ [key]: v }) });
  const dialog = (title: string, options: Option[], key: string, features: ListFeatures, extra: { placeholder?: string; carry?: CarryProps } = {}) => (
    <OptionsListDialog title={`${q.id} · ${title}`} options={options} features={features} onClose={() => setList(null)} {...extra}
      onChange={(o) => set({ [key]: key === 'extraOptions' && !o.length ? undefined : o })} />
  );

  switch (q.type) {
    case 'ranking':
      return (
        <>
          <ListButton title="Список вариантов" options={q.options} from={q.optionsFrom} onClick={() => setList('options')} />
          {list === 'options' && dialog('Список вариантов', q.options, 'options',
            { flags: true, image: true, noExport: true, logic: true, hideText: true }, { carry: carry('optionsFrom', q.optionsFrom) })}
        </>
      );
    case 'single':
    case 'multi':
    case 'dropdown':
      return (
        <>
          <ListButton title="Список ответов" options={q.options} from={q.optionsFrom} onClick={() => setList('options')} />
          {list === 'options' && dialog('Список ответов', q.options, 'options',
            {
              other: true, openTypes: true, exclusive: q.type === 'multi', flags: true, scores: true, image: q.type !== 'dropdown', quickAdd: true,
              groups: true, noExport: q.type === 'multi', noExportOther: true, logic: true, bottom: true, script: true, hideText: q.type !== 'dropdown',
            },
            { carry: carry('optionsFrom', q.optionsFrom) })}
        </>
      );
    case 'matrix': {
      const cards = q.view === 'cards';
      const diff = q.view === 'differential';
      const rowsTitle = cards ? 'Карточки' : diff ? 'Пары противоположностей' : 'Список строк';
      const colsTitle = cards ? 'Группы' : diff ? 'Точки шкалы' : 'Список столбцов';
      return (
        <>
          {!diff && (
            <Segmented value={q.mode} onChange={(mode) => set({ mode })}
              options={cards
                ? [{ value: 'single', label: 'Одна группа на карточку' }, { value: 'multi', label: 'Несколько групп' }]
                : [{ value: 'single', label: 'Один ответ в строке' }, { value: 'multi', label: 'Несколько ответов в строке' }]} />
          )}
          {cards && <p className="muted small" style={{ margin: 0 }}>Респондент видит карточки по одной и относит каждую к группе (на компьютере – ещё и перетаскиванием). В данных – как матрица: переменная на карточку, значение – код группы.</p>}
          {diff && <p className="muted small" style={{ margin: 0 }}>Каждая строка – пара противоположностей: «Дорогой» ↔ «Дешёвый». Точки шкалы – между ними; подписи точек видны под кружками (можно оставить числа 3 2 1 0 1 2 3).</p>}
          <div className="grid2">
            <ListButton title={rowsTitle} options={q.rows} from={q.rowsFrom} onClick={() => setList('rows')} />
            <ListButton title={colsTitle} options={q.columns} onClick={() => setList('columns')} />
          </div>
          {list === 'rows' && dialog(rowsTitle, q.rows, 'rows',
            cards ? { flags: true, noExport: true, logic: true, image: true, hideText: true }
              : diff ? { flags: true, groups: true, noExport: true, logic: true, right: true }
                : { other: true, flags: true, groups: true, noExport: true, noExportOther: true, logic: true, bottom: true, script: true },
            { placeholder: cards ? 'Текст карточки' : diff ? 'Левый полюс' : 'Утверждение', carry: carry('rowsFrom', q.rowsFrom) })}
          {list === 'columns' && dialog(colsTitle, q.columns, 'columns', { scores: true, shared: !diff }, { placeholder: cards ? 'Название группы' : 'Ответ' })}
        </>
      );
    }
    case 'consent':
      return (
        <div className="stack" style={{ gap: 10 }}>
          <label className="field"><span>Текст у галочки</span>
            <input className="input" value={q.label ?? ''} placeholder={CONSENT_LABEL} onChange={(e) => set({ label: e.target.value || undefined })} />
          </label>
          <div className="grid2">
            <label className="field"><span>Кнопка отказа</span>
              <input className="input" value={q.declineLabel ?? ''} placeholder="нет – без согласия дальше не пройти"
                onChange={(e) => set({ declineLabel: e.target.value || undefined, ...(e.target.value ? {} : { declineMessage: undefined }) })} />
              <span className="field-help">Например, «Не даю согласие». Отказ завершает анкету отсевом</span>
            </label>
            <label className="field"><span>Сообщение после отказа</span>
              <input className="input" value={q.declineMessage ?? ''} disabled={!q.declineLabel} placeholder="сообщение об отсеве из настроек"
                onChange={(e) => set({ declineMessage: e.target.value || undefined })} />
            </label>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Текст согласия – в поле «Текст вопроса»: что собираете, зачем, сколько храните, ссылка на политику (<code>[политика](https://…)</code>).
            В выгрузке – переменная со значением 1 (согласен) или 0 (отказ) и время ответа; версия анкеты показывает, какой текст видел респондент.
          </p>
        </div>
      );
    case 'scale':
      return (
        <Block title="Шкала">
          <div className="row" style={{ alignItems: 'end' }}>
            <NumField label="От" width={90} value={q.from} onChange={(v) => set({ from: v ?? 0 })} />
            <NumField label="До" width={90} value={q.to} onChange={(v) => set({ to: v ?? 5 })} />
            <Segmented value={q.from === 0 && q.to === 10 ? 'nps' : q.from === 1 && q.to === 5 ? '5' : q.from === 1 && q.to === 10 ? '10' : ''}
              onChange={(v) => set(v === 'nps' ? { from: 0, to: 10 } : v === '5' ? { from: 1, to: 5 } : { from: 1, to: 10 })}
              options={[{ value: '5', label: '1–5' }, { value: '10', label: '1–10' }, { value: 'nps', label: 'NPS 0–10' }]} />
          </div>
          <div className="grid2" style={{ marginTop: 10 }}>
            <label className="field"><span>Подпись слева</span>
              <input className="input" value={q.labels?.[String(q.from)] ?? ''} placeholder="Совсем не согласен"
                onChange={(e) => set({ labels: emptyToUndef(compact({ ...q.labels, [String(q.from)]: e.target.value || undefined })) })} />
            </label>
            <label className="field"><span>Подпись справа</span>
              <input className="input" value={q.labels?.[String(q.to)] ?? ''} placeholder="Полностью согласен"
                onChange={(e) => set({ labels: emptyToUndef(compact({ ...q.labels, [String(q.to)]: e.target.value || undefined })) })} />
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">Вид</span>
            <Segmented value={q.display ?? 'buttons'} onChange={(v) => set({ display: v === 'buttons' ? undefined : v })}
              options={[{ value: 'buttons', label: 'Числа' }, { value: 'stars', label: '★ Звёзды' }, { value: 'smileys', label: '🙂 Смайлики' }]} />
          </div>
          <div style={{ marginTop: 10 }}>
            <ListButton title="Варианты вне шкалы" options={q.extraOptions ?? []} onClick={() => setList('extra')} />
          </div>
          {list === 'extra' && dialog('Варианты вне шкалы', q.extraOptions ?? [], 'extraOptions', { quickAdd: true }, { placeholder: 'Например, «Затрудняюсь ответить»' })}
        </Block>
      );

    case 'number':
      return (
        <div className="row">
          <NumField label="Минимум" width={140} value={q.min} onChange={(v) => set({ min: v })} />
          <NumField label="Максимум" width={140} value={q.max} onChange={(v) => set({ max: v })} />
        </div>
      );
    case 'date':
      return (
        <div className="row">
          <label className="field"><span>Не раньше</span><input className="input" type="date" value={q.min ?? ''} onChange={(e) => set({ min: e.target.value || undefined })} /></label>
          <label className="field"><span>Не позже</span><input className="input" type="date" value={q.max ?? ''} onChange={(e) => set({ max: e.target.value || undefined })} /></label>
        </div>
      );
    case 'phone':
      return (
        <Segmented value={q.format ?? 'ru'} onChange={(v) => set({ format: v === 'ru' ? undefined : v })}
          options={[{ value: 'ru', label: 'Россия +7' }, { value: 'international', label: 'Международный' }]} />
      );
    case 'hidden':
      return <HiddenBody q={q} set={set} />;
    case 'slider':
      return <SliderBody q={q} set={set} />;
    case 'file':
      return <FileBody q={q} set={set} />;
    case 'hotspot':
      return <HotspotBody q={q} set={set} />;
    case 'sum':
      return (
        <>
          <ListButton title="Между чем распределить" options={q.options} onClick={() => setList('options')} />
          <div className="row" style={{ alignItems: 'end', marginTop: 10, flexWrap: 'wrap' }}>
            <NumField label="Сколько распределить" width={160} placeholder="100" value={q.total} onChange={(v) => set({ total: v })} />
            <label className="field"><span>Единица</span>
              <input className="input" style={{ width: 100 }} placeholder="%" value={q.unit ?? ''} onChange={(e) => set({ unit: e.target.value || undefined })} />
            </label>
            <Segmented value={q.mode ?? 'exact'} onChange={(v) => set({ mode: v === 'exact' ? undefined : v })}
              options={[{ value: 'exact', label: 'Ровно столько' }, { value: 'max', label: 'Не больше' }]} />
          </div>
          {list === 'options' && dialog('Между чем распределить', q.options, 'options', { flags: true, noExport: true, quickAdd: true })}
        </>
      );
    case 'maxdiff':
      return (
        <>
          <MaxDiffBody q={q} set={set} listButton={<ListButton title="Варианты" options={q.options} onClick={() => setList('options')} />} />
          {list === 'options' && dialog('Варианты', q.options, 'options', { flags: true, quickAdd: true })}
        </>
      );
    case 'conjoint':
      return <ConjointBody q={q} set={set} />;
    default:
      return null;
  }
}

/** Скрытая переменная: из ссылки, по формуле или скриптом */
function HiddenBody({ q, set }: { q: Extract<Question, { type: 'hidden' }>; set: (p: Patch) => void }) {
  let calcError = '';
  if (q.calc) { try { parseCalc(q.calc); } catch (e) { calcError = (e as Error).message; } }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="field"><span>Формула (необязательно)</span>
        <input className={`input mono${calcError ? ' invalid' : ''}`} placeholder="например, score(Q1) + score(Q2)" value={q.calc ?? ''}
          onChange={(e) => set({ calc: e.target.value || undefined, valueType: e.target.value ? 'number' : q.valueType })} />
        {calcError ? <span className="field-error">{calcError}</span> : (
          <span className="field-help">
            Пересчитывается после каждого ответа. Ответ на вопрос – его ID (Q5), + − * / и скобки, сравнения &gt; &lt; == дают 1 или 0.
            Функции: {Object.entries(CALC_FUNCTIONS).map(([f, d]) => `${f}() – ${d}`).join('; ')}. Нет ответа – 0.
          </span>
        )}
      </label>
      {!q.calc && (
        <div className="row">
          <Segmented value={q.valueType ?? 'string'} onChange={(v) => set({ valueType: v })}
            options={[{ value: 'string', label: 'Строка' }, { value: 'number', label: 'Число' }]} />
          <label className="field grow"><span>Взять из параметра ссылки</span>
            <input className="input mono" placeholder="например, pid" value={q.fromParam ?? ''} onChange={(e) => set({ fromParam: e.target.value.trim() || undefined })} />
          </label>
        </div>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        {q.calc ? 'Значение – число, попадает в выгрузку и доступно в условиях, квотах и подстановках.'
          : <>Или задайте действием «Записать в переменную» либо скриптом: <code>sl.set("{q.id}", …)</code>. Переменная попадает в выгрузку и доступна в условиях.</>}
      </p>
    </div>
  );
}

const emptyToUndef = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

