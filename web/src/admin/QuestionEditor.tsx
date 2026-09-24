import { useState, type ReactNode } from 'react';
import { ConditionEditor, defaultCondition, describeCondition } from './ConditionEditor.tsx';
import { ActionsEditor, actionKinds, describeActions, newAction } from './ActionsEditor.tsx';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { OptionsEditor } from './OptionsEditor.tsx';
import { QuestionPreview } from './preview.tsx';
import { allQuestions, blockOf } from '../../../shared/logic.ts';
import { CALC_FUNCTIONS, parseCalc } from '../../../shared/calc.ts';
import { allIds } from '../../../shared/refactor.ts';
import { ID_RE, RESERVED_IDS } from '../../../shared/validate.ts';
import { Flag, Menu, Modal, NumField, Section, Segmented, compact } from './common.tsx';
import { newQuestion, TYPE_ICONS } from './Builder.tsx';
import {
  CHOICE_TYPES, OPTION_TYPES, QUESTION_TYPE_LABELS, settingsOf, type Action, type MatrixQuestion, type Option, type OptionsFrom, type Question, type QuestionType, type Survey,
} from '../../../shared/types.ts';

/** Смена типа с сохранением всего, что можно перенести */
function convert(q: Question, type: QuestionType): Question {
  const fresh = newQuestion(type, q.id) as any;
  const old = q as any;
  const keep = {
    id: q.id, text: q.text || fresh.text, hint: q.hint, required: q.required, showIf: q.showIf, scripts: q.scripts, actions: q.actions,
    hideBack: q.hideBack, hideFinish: q.hideFinish, requiredMessage: q.requiredMessage, note: q.note, fixed: q.fixed,
    prefillParam: q.prefillParam, prefillSkip: q.prefillSkip,
  };
  const opts: Option[] | undefined = old.options ?? old.rows;
  if (CHOICE_TYPES.includes(type) && opts?.length) {
    return compact({
      ...fresh, ...keep, order: old.order ?? old.rowOrder, optionsFrom: old.optionsFrom ?? old.rowsFrom,
      options: opts.map((o) => compact({ ...o, exclusive: type === 'multi' ? o.exclusive : undefined, other: type === 'ranking' ? undefined : o.other })),
    }) as Question;
  }
  if (type === 'matrix' && opts?.length) {
    return compact({ ...fresh, ...keep, rows: opts.map((o) => compact({ ...o, exclusive: undefined })), rowsFrom: old.optionsFrom }) as Question;
  }
  return compact({ ...fresh, ...keep }) as Question;
}

type Patch = Record<string, unknown>;

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

  return (
    <Modal wide onClose={onClose}
      title={<><span className="type-icon">{TYPE_ICONS[q.type]}</span> {q.id} <span className="muted" style={{ fontWeight: 400 }}>· {position}</span></>}
      actions={<>
        <button className="icon-btn" title="Предыдущий вопрос" disabled={!hasPrev} onClick={() => onNav(-1)}>‹</button>
        <button className="icon-btn" title="Следующий вопрос" disabled={!hasNext} onClick={() => onNav(1)}>›</button>
        <Menu items={[
          { label: 'Предпросмотр с этого вопроса', onClick: onPreview },
          { label: 'Дублировать', onClick: onDuplicate },
          { label: 'Копировать (JSON)', onClick: () => navigator.clipboard.writeText(JSON.stringify(q, null, 2)) },
          { label: 'Удалить вопрос', onClick: onDelete, danger: true },
        ]} />
        <button className="btn btn-primary btn-sm" onClick={onClose}>Готово</button>
      </>}>
      <div className="qdialog">
        <div className="stack">
          <div className="qhead">
            <label className="field grow"><span>Тип</span>
              <select className="input" value={q.type} onChange={(e) => onChange(convert(q, e.target.value as QuestionType))}>
                {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => (
                  <option key={t} value={t}>{TYPE_ICONS[t]}  {QUESTION_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 130 }}><span>ID / переменная</span>
              <input className={`input mono${idError ? ' invalid' : ''}`} value={idDraft} title="Все ссылки на вопрос обновятся автоматически"
                onChange={(e) => setIdDraft(e.target.value)} onBlur={commitId}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitId(); } if (e.key === 'Escape') { setIdDraft(q.id); setIdError(''); } }} />
              {idError && <span className="field-error">{idError}</span>}
            </label>
            {answerable && (
              <label className="switch" title="Без ответа нельзя перейти дальше">
                <input type="checkbox" checked={q.required !== false} onChange={(e) => set({ required: e.target.checked ? undefined : false })} />
                <span>Обязательный</span>
              </label>
            )}
          </div>

          <label className="field">
            <span>{q.type === 'hidden' ? 'Подпись для выгрузки' : q.type === 'info' ? 'Текст' : 'Текст вопроса'}</span>
            <textarea className="input autogrow" rows={Math.min(8, Math.max(2, q.text.split('\n').length))} value={q.text} autoFocus={!q.text}
              placeholder={q.type === 'hidden' ? 'Например: ID панелиста' : 'Введите вопрос. Подставить ответ: {{Q1}}'}
              onChange={(e) => set({ text: e.target.value })} />
            {q.type !== 'hidden' && <span className="field-help">**жирный**, *курсив*, [ссылка](https://…), ![картинка](https://…), ответ на вопрос — {'{{Q1}}'}</span>}
          </label>
          {answerable && (showHint ? (
            <label className="field"><span>Подсказка под вопросом</span>
              <input className="input" value={q.hint ?? ''} autoFocus={!q.hint} onChange={(e) => set({ hint: e.target.value || undefined })} />
            </label>
          ) : null)}
          {showNote && (
            <label className="field"><span>Комментарий для команды (респондент не видит)</span>
              <textarea className="input note-input" rows={2} value={q.note ?? ''} autoFocus={!q.note}
                placeholder="Например: из ТЗ заказчика, согласовать формулировку" onChange={(e) => set({ note: e.target.value || undefined })} />
            </label>
          )}
          {(!showHint && answerable) || !showNote ? (
            <div className="row" style={{ gap: 14 }}>
              {answerable && !showHint && <button className="btn-link" style={{ padding: 0 }} onClick={() => setShowHint(true)}>+ подсказка</button>}
              {!showNote && <button className="btn-link" style={{ padding: 0 }} onClick={() => setShowNote(true)}>+ комментарий для команды</button>}
            </div>
          ) : null}

          <TypeBody q={q} set={set} />

          <div className="sections">
            {q.type !== 'hidden' && <ActionsBlock def={def} q={q} prevId={prevId} set={set} onCreateVar={onCreateVar} />}
            <SettingsSection def={def} q={q} set={set} />
          </div>
        </div>

        <aside className="qdialog-preview">
          <div className="preview-label">Так увидит респондент</div>
          <div className="phone">
            <QuestionPreview key={JSON.stringify(q)} def={def} q={q} interactive />
          </div>
        </aside>
      </div>
    </Modal>
  );
}

/** Одно правило в блоке «Действия»: заголовок, крестик и содержимое */
function Rule({ title, onRemove, children }: { title: string; onRemove: () => void; children: ReactNode }) {
  return (
    <div className="rule">
      <div className="rule-head">
        <span className="rule-title">{title}</span>
        <button className="icon-btn" title="Убрать" onClick={onRemove}>✕</button>
      </div>
      {children}
    </div>
  );
}

/**
 * «Действия»: что происходит перед показом вопроса и после ответа.
 * Показывается только то, что настроено; всё остальное — в меню «+ Добавить».
 */
function ActionsBlock({ def, q, prevId, set, onCreateVar }: {
  def: Survey; q: Question; prevId?: string; set: (p: Patch) => void; onCreateVar: () => string;
}) {
  const before = q.actions?.before;
  const after = q.actions?.after;
  const scripts = (q.scripts ?? {}) as Record<string, string | undefined>;
  const [jsBefore, setJsBefore] = useState(!!scripts.onShow);
  const [jsAfter, setJsAfter] = useState(!!(scripts.onChange || scripts.validate));
  const setActions = (phase: 'before' | 'after', list: typeof before) => {
    const next = compact({ ...q.actions, [phase]: list });
    set({ actions: Object.keys(next).length ? next : undefined });
  };
  const addAction = (phase: 'before' | 'after', kind: Action['do']) =>
    setActions(phase, [...(q.actions?.[phase] ?? []), newAction(def, q, phase, kind)]);
  const clearScripts = (keys: string[]) => {
    const next = { ...scripts };
    for (const k of keys) delete next[k];
    set({ scripts: Object.values(next).some(Boolean) ? next : undefined });
  };

  const from = q.type === 'matrix' ? q.rowsFrom : 'optionsFrom' in q ? q.optionsFrom : undefined;
  const fromKey = q.type === 'matrix' ? 'rowsFrom' : 'optionsFrom';
  const idx = allQuestions(def).findIndex((x) => x.id === q.id);
  const sources = allQuestions(def).slice(0, Math.max(0, idx)).filter((x) => OPTION_TYPES.includes(x.type));
  const canCarry = OPTION_TYPES.includes(q.type);
  const what = q.type === 'matrix' ? 'Строки' : 'Варианты';

  const beforeParts = [
    q.showIf && `показывать, если ${describeCondition(def, q.showIf)}`,
    from && `${what.toLowerCase()} из ${from.question}`,
    describeActions(def, q, before),
    scripts.onShow && 'JS',
  ].filter(Boolean);
  const afterParts = [describeActions(def, q, after), (scripts.onChange || scripts.validate) && 'JS'].filter(Boolean);
  const beforeEmpty = !q.showIf && !from && !before?.length && !jsBefore;
  const afterEmpty = !after?.length && !jsAfter;

  return (
    <div className="actions-block">
      <div className="block-title">Действия</div>
      <Section title="Перед показом" active={beforeParts.length > 0} summary={beforeParts.length ? beforeParts.join(' · ') : 'показывать всегда'}>
        {beforeEmpty && <p className="empty-rules">Вопрос показывается всегда.</p>}
        {q.showIf && (
          <Rule title="Показывать вопрос" onRemove={() => set({ showIf: undefined })}>
            <ConditionEditor def={def} value={q.showIf} suggest={prevId} onChange={(c) => set({ showIf: c })} />
          </Rule>
        )}
        {from && (
          <Rule title={`${what} из другого вопроса`} onRemove={() => set({ [fromKey]: undefined })}>
            <CarryForward def={def} self={q.id} value={from} onChange={(v) => set({ [fromKey]: v })} />
          </Rule>
        )}
        <ActionsEditor def={def} q={q} phase="before" value={before} onChange={(v) => setActions('before', v)} onCreateVar={onCreateVar} />
        {jsBefore && (
          <Rule title="JS при показе" onRemove={() => { clearScripts(['onShow']); setJsBefore(false); }}>
            <ScriptsEditor level="question" only={['onShow']} value={q.scripts} onChange={(sc) => set({ scripts: sc })} />
          </Rule>
        )}
        <Menu align="left" className="btn-link add-menu" label="+ Добавить" title="Добавить правило" items={[
          !q.showIf && { label: 'Условие показа', onClick: () => set({ showIf: defaultCondition(def, prevId) }) },
          canCarry && !from && { label: `${what} из другого вопроса`, disabled: !sources.length,
            onClick: () => set({ [fromKey]: { question: sources[sources.length - 1].id, filter: 'selected' } }) },
          { label: 'Действие', onClick: () => {}, group: true },
          ...actionKinds('before', q).map(([k, l]) => ({ label: l, onClick: () => addAction('before', k) })),
          !jsBefore && { label: 'Скрипт', onClick: () => {}, group: true },
          !jsBefore && { label: 'JS-скрипт при показе', onClick: () => setJsBefore(true) },
        ]} />
      </Section>

      {q.type !== 'info' && (
        <Section title="После ответа" active={afterParts.length > 0} summary={afterParts.length ? afterParts.join(' · ') : 'к следующему вопросу'}>
          {afterEmpty && <p className="empty-rules">Дальше — следующий вопрос.</p>}
          <ActionsEditor def={def} q={q} phase="after" value={after} onChange={(v) => setActions('after', v)} onCreateVar={onCreateVar} />
          {jsAfter && (
            <Rule title="JS-скрипты" onRemove={() => { clearScripts(['onChange', 'validate']); setJsAfter(false); }}>
              <ScriptsEditor level="question" only={['onChange', 'validate']} value={q.scripts} onChange={(sc) => set({ scripts: sc })} />
            </Rule>
          )}
          <Menu align="left" className="btn-link add-menu" label="+ Добавить" title="Добавить действие" items={[
            ...actionKinds('after', q).map(([k, l]) => ({ label: l, onClick: () => addAction('after', k) })),
            !jsAfter && { label: 'Скрипт', onClick: () => {}, group: true },
            !jsAfter && { label: 'JS-проверка или реакция на ответ', onClick: () => setJsAfter(true) },
          ]} />
        </Section>
      )}
    </div>
  );
}

const FILTER_LABELS = { selected: 'выбранные', notSelected: 'невыбранные', all: 'все' } as const;

/** Главное содержимое по типу: варианты, строки и столбцы, шкала и т. п. */
function TypeBody({ q, set }: { q: Question; set: (p: Patch) => void }) {
  switch (q.type) {
    case 'ranking':
      return (
        <Block title="Варианты для ранжирования" note={q.optionsFrom ? `+ варианты из ${q.optionsFrom.question}` : undefined}>
          <OptionsEditor options={q.options} onChange={(options) => set({ options })} allowFlags />
        </Block>
      );
    case 'single':
    case 'multi':
    case 'dropdown':
      return (
        <Block title="Варианты ответа" note={q.optionsFrom ? `+ варианты из ${q.optionsFrom.question}` : undefined}>
          <OptionsEditor options={q.options} onChange={(options) => set({ options })} allowOther allowExclusive={q.type === 'multi'} allowFlags allowScores quickAdd />
        </Block>
      );
    case 'matrix':
      return (
        <>
          <Segmented value={q.mode} onChange={(mode) => set({ mode })}
            options={[{ value: 'single', label: 'Один ответ в строке' }, { value: 'multi', label: 'Несколько ответов в строке' }]} />
          <div className="grid2 matrix-editor">
            <Block title="Строки" note={q.rowsFrom ? `+ из ${q.rowsFrom.question}` : undefined}>
              <OptionsEditor options={q.rows} onChange={(rows) => set({ rows })} allowOther allowFlags placeholder="Утверждение" />
            </Block>
            <Block title="Столбцы">
              <OptionsEditor options={q.columns} onChange={(columns) => set({ columns })} placeholder="Ответ" allowScores />
            </Block>
          </div>
        </>
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
          <div className="sub-title">Варианты вне шкалы</div>
          <OptionsEditor options={q.extraOptions ?? []} onChange={(extraOptions) => set({ extraOptions: extraOptions.length ? extraOptions : undefined })}
            emptyHint="Например, «Затрудняюсь ответить»" quickAdd />
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
            Пересчитывается после каждого ответа. Ответ на вопрос — его ID (Q5), + − * / и скобки, сравнения &gt; &lt; == дают 1 или 0.
            Функции: {Object.entries(CALC_FUNCTIONS).map(([f, d]) => `${f}() — ${d}`).join('; ')}. Нет ответа — 0.
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
        {q.calc ? 'Значение — число, попадает в выгрузку и доступно в условиях, квотах и подстановках.'
          : <>Или задайте действием «Записать в переменную» либо скриптом: <code>sl.set("{q.id}", …)</code>. Переменная попадает в выгрузку и доступна в условиях.</>}
      </p>
    </div>
  );
}

const emptyToUndef = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="block">
      <div className="sub-title">{title}{note && <span className="muted"> {note}</span>}</div>
      {children}
    </div>
  );
}

/** Флажки и мелкие параметры — всё, что не нужно видеть постоянно */
function SettingsSection({ def, q, set }: { def: Survey; q: Question; set: (p: Patch) => void }) {
  const a = q as any;
  const on: string[] = [];
  const body: ReactNode[] = [];
  const flag = (key: string, label: string, hint?: string) => {
    if (a[key]) on.push(label);
    body.push(<Flag key={key} label={label} hint={hint} checked={!!a[key]} onChange={(v) => set({ [key]: v || undefined })} />);
  };
  // Флаг со значением по умолчанию из настроек анкеты: в вопросе хранится только отличие от него
  const inherited = (key: 'autoNext' | 'noPaste', label: string, hint?: string) => {
    const base = !!settingsOf(def)[key];
    const value = a[key] ?? base;
    if (value) on.push(label);
    body.push(<Flag key={key} label={label} hint={hint ?? (base ? 'Включено для всей анкеты в настройках' : undefined)} checked={value}
      onChange={(v) => set({ [key]: v === base ? undefined : v })} />);
  };
  const group = (title: string) => body.push(<div key={`g-${title}`} className="flag-group">{title}</div>);
  const answerable = q.type !== 'info' && q.type !== 'hidden';
  const isChoice = CHOICE_TYPES.includes(q.type);

  if (isChoice || q.type === 'matrix' || q.type === 'number' || q.type === 'text' || q.type === 'scale') group('Логика');
  if (isChoice || q.type === 'matrix') {
    const key = q.type === 'matrix' ? 'rowOrder' : 'order';
    const legacy = q.type === 'matrix' ? (q as MatrixQuestion).randomizeRows : a.randomize;
    const value = a[key] ?? (legacy ? 'random' : 'fixed');
    if (value !== 'fixed') on.push(value === 'random' ? 'Рандомизация' : 'Ротация');
    body.push(
      <div key="order" className="flag-line">
        <span>{q.type === 'matrix' ? 'Порядок строк' : 'Порядок вариантов'}</span>
        <Segmented value={value} onChange={(v) => set({ [key]: v === 'fixed' ? undefined : v, randomize: undefined, randomizeRows: undefined })}
          options={[{ value: 'fixed', label: 'Как есть' }, { value: 'random', label: 'Случайный' }, { value: 'rotate', label: 'Ротация' }]} />
      </div>,
    );
  }
  if (q.type === 'ranking') {
    if (q.rankCount) on.push(`Топ-${q.rankCount}`);
    body.push(
      <div key="rank" className="flag-line">
        <span>Сколько мест заполнить<small className="muted"> (пусто — все варианты)</small></span>
        <input className="input mini" type="number" min={1} placeholder="все" value={q.rankCount ?? ''}
          onChange={(e) => set({ rankCount: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
      </div>,
    );
  }
  if (q.type === 'multi') {
    if (q.minSelected || q.maxSelected) on.push(`Выбор ${q.minSelected ?? 1}–${q.maxSelected ?? '∞'}`);
    body.push(
      <div key="minmax" className="flag-line">
        <span>Сколько можно выбрать</span>
        <div className="row" style={{ gap: 6 }}>
          <input className="input mini" type="number" placeholder="от" value={q.minSelected ?? ''} onChange={(e) => set({ minSelected: e.target.value ? Number(e.target.value) : undefined })} />
          <input className="input mini" type="number" placeholder="до" value={q.maxSelected ?? ''} onChange={(e) => set({ maxSelected: e.target.value ? Number(e.target.value) : undefined })} />
        </div>
      </div>,
    );
  }
  if (q.type === 'matrix') {
    const rr = q.requiredRows ?? 'all';
    if (q.required !== false && rr !== 'all') on.push(rr === 'none' ? 'Строки необязательны' : `Минимум ${rr} строк`);
    body.push(
      <div key="rr" className="flag-line">
        <span>Обязательные строки</span>
        <div className="row" style={{ gap: 6 }}>
          <Segmented value={typeof rr === 'number' ? 'n' : rr} onChange={(v) => set({ requiredRows: v === 'all' ? undefined : v === 'n' ? 1 : v })}
            options={[{ value: 'all', label: 'Все' }, { value: 'n', label: 'Минимум N' }, { value: 'none', label: 'Не обязательно' }]} />
          {typeof rr === 'number' && <input className="input mini" type="number" min={1} value={rr} onChange={(e) => set({ requiredRows: Math.max(1, Number(e.target.value) || 1) })} />}
        </div>
      </div>,
    );
  }
  // Короткое текстовое поле настройки
  const textLine = (key: string, label: string, placeholder?: string, summary?: (v: string) => string) => {
    const v = a[key] as string | undefined;
    if (v && summary) on.push(summary(v));
    body.push(
      <div key={key} className="flag-line">
        <span>{label}</span>
        <input className="input short" placeholder={placeholder} value={v ?? ''} onChange={(e) => set({ [key]: e.target.value || undefined })} />
      </div>,
    );
  };
  if (q.type === 'number') {
    textLine('suffix', 'Единица измерения справа от поля', 'лет, ₽, шт.', (v) => `Ед.: ${v}`);
    textLine('placeholder', 'Подсказка внутри поля', 'например, 25');
    if (q.decimals) on.push(`Дробные (${q.decimals} зн.)`);
    body.push(
      <div key="dec" className="flag-line">
        <Flag label="Разрешить дробные числа" checked={!!q.decimals} onChange={(v) => set({ decimals: v ? 2 : undefined })} />
        {!!q.decimals && <input className="input mini" type="number" min={1} max={6} title="Знаков после запятой" value={q.decimals} onChange={(e) => set({ decimals: Number(e.target.value) || undefined })} />}
      </div>,
    );
  }
  if (q.type === 'text') {
    const it = q.inputType ?? 'text';
    if (it !== 'text') on.push(it === 'email' ? 'E-mail' : 'Время');
    body.push(
      <div key="it" className="flag-line">
        <span>Что вводит респондент</span>
        <Segmented value={it} onChange={(v) => set({ inputType: v === 'text' ? undefined : v, multiline: v === 'text' ? q.multiline : undefined })}
          options={[{ value: 'text', label: 'Текст' }, { value: 'email', label: 'E-mail' }, { value: 'time', label: 'Время' }]} />
      </div>,
    );
    if (q.minLength || q.maxLength) on.push(`${q.minLength ?? 0}–${q.maxLength ?? '∞'} симв.`);
    body.push(
      <div key="ml" className="flag-line">
        <span>Длина ответа, символов</span>
        <div className="row" style={{ gap: 6 }}>
          <input className="input mini" type="number" min={1} placeholder="от" value={q.minLength ?? ''} onChange={(e) => set({ minLength: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
          <input className="input mini" type="number" min={1} placeholder="до" value={q.maxLength ?? ''} onChange={(e) => set({ maxLength: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
        </div>
      </div>,
    );
    if (it === 'text') {
      textLine('pattern', 'Формат ответа (регулярное выражение)', 'например, [А-Яа-яЁё\\s-]+', () => 'Проверка формата');
      if (q.pattern) textLine('patternMessage', 'Сообщение, если формат не подходит', 'Ответ в неверном формате');
    }
    textLine('placeholder', 'Подсказка внутри поля', 'например, Ваш ответ');
    inherited('noPaste', 'Запретить вставку из буфера обмена');
  }
  if (q.type === 'single' || q.type === 'dropdown' || q.type === 'scale') {
    inherited('autoNext', 'Автопереход далее при выборе ответа');
  }

  // ---- Отображение ----
  if (answerable) group('Отображение');
  if (q.type === 'text' && (q.inputType ?? 'text') === 'text') {
    flag('multiline', 'Большое поле для ответа');
    if (q.multiline) {
      body.push(
        <div key="rows" className="flag-line">
          <span>Высота поля, строк</span>
          <input className="input mini" type="number" min={2} max={20} placeholder="4" value={q.rows ?? ''}
            onChange={(e) => set({ rows: e.target.value ? Math.min(20, Math.max(2, Number(e.target.value))) : undefined })} />
        </div>,
      );
    }
  }
  if (q.type === 'single' || q.type === 'multi') {
    const cols = q.columnCount ?? 1;
    if (cols > 1) on.push(`${cols} колонки`);
    body.push(
      <div key="cols" className="flag-line">
        <span>Варианты в колонки<small className="muted"> (на телефоне — одна)</small></span>
        <Segmented value={String(cols)} onChange={(v) => set({ columnCount: v === '1' ? undefined : Number(v) })}
          options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
      </div>,
    );
  }
  if (q.type === 'single' || q.type === 'multi') flag('showOtherAlways', 'Не скрывать поле «Другое»', 'Поле видно сразу, ввод текста отмечает вариант');
  if (q.type === 'matrix') {
    flag('transpose', 'Перевернуть таблицу', 'Строки и столбцы меняются местами');
    flag('verticalHeaders', 'Вертикальный текст в заголовках столбцов');
    flag('progressiveRows', 'Показывать строки по мере ответа');
    flag('carousel', 'Таблица как карусель', 'По одной строке на экране');
  }
  if (answerable && q.type !== 'matrix' && q.type !== 'ranking') {
    group('Предзаполнение');
    textLine('prefillParam', 'Взять ответ из параметра ссылки', 'например, age', (v) => `Из ссылки ?${v}`);
    if (q.prefillParam) flag('prefillSkip', 'Не показывать вопрос, если ответ пришёл из ссылки');
  }
  if (answerable && q.required !== false) textLine('requiredMessage', 'Сообщение, если нет ответа', 'Пожалуйста, ответьте на вопрос', () => 'Своё сообщение');
  if (answerable || q.type === 'info') {
    if (!answerable) group('Отображение');
    if (blockOf(def, q.id)?.order) flag('fixed', 'Оставить на месте при перемешивании блока', 'Блок перемешивается для каждого респондента');
    flag('hideBack', 'Скрыть кнопку «Назад»');
    flag('hideFinish', 'Скрыть кнопку «Завершить»');
  }

  if (body.length === 0) return null;
  return (
    <Section title="Настройки" active={on.length > 0} summary={on.length ? on.join(' · ') : 'по умолчанию'}>
      <div className="flags">{body}</div>
    </Section>
  );
}

function CarryForward({ def, self, value, onChange }: {
  def: Survey; self: string; value: OptionsFrom | undefined; onChange: (v: OptionsFrom | undefined) => void;
}) {
  const sources = allQuestions(def)
    .filter((x) => x.id !== self && OPTION_TYPES.includes(x.type));
  return (
    <div className="row">
      <label className="field grow"><span>Из вопроса</span>
        <select className="input" value={value?.question ?? ''} onChange={(e) => onChange(e.target.value ? { question: e.target.value, filter: value?.filter ?? 'selected' } : undefined)}>
          <option value="">— не переносить —</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.id}{s.text ? ` · ${s.text.slice(0, 50)}` : ''}</option>)}
        </select>
      </label>
      {value && (
        <Segmented value={value.filter} onChange={(filter) => onChange({ ...value, filter })}
          options={[{ value: 'selected', label: 'Выбранные' }, { value: 'notSelected', label: 'Невыбранные' }, { value: 'all', label: 'Все' }]} />
      )}
    </div>
  );
}
