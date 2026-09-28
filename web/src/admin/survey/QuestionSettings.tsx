// Вкладка «Настройки» диалога вопроса: обязательность, порядок, проверки, качество…
import { type ReactNode } from 'react';
import { ConditionField } from './ConditionEditor.tsx';
import { blockOf } from '../../../../shared/logic.ts';
import { Flag, Segmented } from '../common.tsx';
import { CHOICE_TYPES, settingsOf, type MatrixQuestion, type Question, type Survey } from '../../../../shared/types.ts';
import type { Patch } from './AdvancedEditors.tsx';

export function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="block">
      <div className="sub-title">{title}{note && <span className="muted"> {note}</span>}</div>
      {children}
    </div>
  );
}

/** Вкладка «Настройки»: флажки и мелкие параметры вопроса; on — включённые (для счётчика на вкладке) */
export function questionSettings(def: Survey, q: Question, set: (p: Patch) => void): { body: ReactNode[]; on: string[] } {
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
        <span>Сколько мест заполнить<small className="muted"> (пусто – все варианты)</small></span>
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
        <span>Варианты в колонки<small className="muted"> (на телефоне – одна)</small></span>
        <Segmented value={String(cols)} onChange={(v) => set({ columnCount: v === '1' ? undefined : Number(v) })}
          options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
      </div>,
    );
  }
  if (q.type === 'single' || q.type === 'multi') flag('showOtherAlways', 'Отключить скрытие полей с открытыми значениями', 'Поле видно сразу, ввод текста отмечает вариант');
  if (q.type === 'single' || q.type === 'multi') {
    flag('search', 'Добавить строку поиска', 'Поле поиска над вариантами – для длинных списков');
    if (q.options.some((o) => o.group) || q.collapseGroups) flag('collapseGroups', 'Показывать группы в свёрнутом виде', 'Респондент раскрывает группу нажатием');
  }
  if (q.type === 'single' || q.type === 'multi' || q.type === 'matrix') flag('hideMarker', 'Скрыть маркер выбора', 'Без кружков и квадратиков: выбор подсвечивается');
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
  // ---- Качество ответов ----
  if (answerable) {
    group('Качество ответов');
    if (q.attention) on.push(q.attention.onFail === 'screenout' ? 'Контрольный: отсев' : 'Контрольный вопрос');
    body.push(
      <div key="attention" className="flag-line stack" style={{ alignItems: 'stretch', gap: 6 }}>
        <span>Контрольный вопрос<small className="muted"> – правильный ответ; при ошибке анкета помечается как подозрительная</small></span>
        <ConditionField def={def} value={q.attention?.correct} self={q.id} placeholder={`пусто – не проверять; например, ${q.id} = 3`}
          onChange={(c) => set({ attention: c ? { correct: c, ...(q.attention?.onFail ? { onFail: q.attention.onFail } : {}) } : undefined })} />
        {q.attention && (
          <Segmented value={q.attention.onFail ?? 'flag'} onChange={(v) => set({ attention: { correct: q.attention!.correct, ...(v === 'screenout' ? { onFail: 'screenout' as const } : {}) } })}
            options={[{ value: 'flag', label: 'Пометить' }, { value: 'screenout', label: 'Отсеять' }]} />
        )}
      </div>,
    );
    if (q.type === 'matrix') {
      if (q.straightline) on.push(q.straightline === 'screenout' ? 'Прямолинейные: отсев' : 'Прямолинейные: пометка');
      body.push(
        <div key="straightline" className="flag-line">
          <span>Одинаковый ответ во всех строках<small className="muted"> (от 3 строк)</small></span>
          <Segmented value={q.straightline ?? 'off'} onChange={(v) => set({ straightline: v === 'off' ? undefined : v as 'flag' | 'screenout' })}
            options={[{ value: 'off', label: 'Не проверять' }, { value: 'flag', label: 'Пометить' }, { value: 'screenout', label: 'Отсеять' }]} />
        </div>,
      );
    }
  }
  if (answerable && q.required !== false) textLine('requiredMessage', 'Сообщение, если нет ответа', 'Пожалуйста, ответьте на вопрос', () => 'Своё сообщение');
  if (answerable || q.type === 'info') {
    if (!answerable) group('Отображение');
    if (blockOf(def, q.id)?.order) flag('fixed', 'Оставить на месте при перемешивании блока', 'Блок перемешивается для каждого респондента');
    flag('hideBack', 'Скрыть кнопку «Назад»');
    flag('hideFinish', 'Скрыть кнопку «Завершить»');
  }

  return { body, on };
}
