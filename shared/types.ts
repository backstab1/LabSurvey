// Формат анкеты SurveyLAB (formatVersion 1). Подробное описание: docs/survey-format.md

export type Code = number;

export interface Option {
  code: Code;
  text: string;
  /** Показывает поле «укажите» рядом с вариантом */
  other?: boolean;
  /** Для multi: выбор этого варианта снимает все остальные */
  exclusive?: boolean;
}

/** Перенос вариантов из другого вопроса (single/multi/dropdown или строки матрицы) */
export interface OptionsFrom {
  question: string;
  /** selected — только выбранные, notSelected — невыбранные, all — все */
  filter: 'selected' | 'notSelected' | 'all';
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | SimpleCondition;

export type ConditionOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'notIn'
  | 'contains' | 'notContains' | 'containsAny' | 'containsAll'
  | 'answered' | 'notAnswered';

export interface SimpleCondition {
  /** ID вопроса */
  q?: string;
  /** Код строки — только для матриц */
  row?: Code;
  /** Параметр ссылки (?src=vk) вместо вопроса */
  param?: string;
  op: ConditionOp;
  value?: unknown;
}

/**
 * Клиентские скрипты (JS). Выполняются в браузере респондента, получают объект `sl`
 * (см. docs/survey-format.md → «Скрипты»). Сервер их не выполняет и всегда сам проверяет ответы.
 */
export interface QuestionScripts {
  /** При показе вопроса */
  onShow?: string;
  /** При каждом изменении ответа */
  onChange?: string;
  /** Доп. проверка перед «Далее»: вернуть строку — это текст ошибки */
  validate?: string;
}

export interface PageScripts {
  onShow?: string;
  /** Перед отправкой страницы: вернуть строку — отправка отменяется с этим сообщением */
  onSubmit?: string;
}

export interface SurveyScripts {
  /** Глобальный скрипт: выполняется при каждой загрузке страницы до остальных. Функции можно класть в sl.shared */
  init?: string;
}

interface QuestionBase {
  /** Уникальный ID = имя переменной в выгрузке: латиница, цифры, _, начинается с буквы */
  id: string;
  text: string;
  hint?: string;
  /** По умолчанию true (кроме info) */
  required?: boolean;
  showIf?: Condition;
  scripts?: QuestionScripts;
}

export interface ChoiceQuestion extends QuestionBase {
  type: 'single' | 'dropdown';
  options: Option[];
  optionsFrom?: OptionsFrom;
  randomize?: boolean;
}

export interface MultiQuestion extends QuestionBase {
  type: 'multi';
  options: Option[];
  optionsFrom?: OptionsFrom;
  randomize?: boolean;
  minSelected?: number;
  maxSelected?: number;
}

export interface TextQuestion extends QuestionBase {
  type: 'text';
  multiline?: boolean;
  maxLength?: number;
}

export interface NumberQuestion extends QuestionBase {
  type: 'number';
  min?: number;
  max?: number;
  /** Число знаков после запятой, по умолчанию 0 (только целые) */
  decimals?: number;
}

export interface ScaleQuestion extends QuestionBase {
  type: 'scale';
  from: number;
  to: number;
  /** Подписи отдельных точек: {"1": "Совсем не согласен", "5": "Полностью согласен"} */
  labels?: Record<string, string>;
  /** Дополнительные варианты вне шкалы, например {code: 99, text: "Затрудняюсь ответить"} */
  extraOptions?: Option[];
}

export interface MatrixQuestion extends QuestionBase {
  type: 'matrix';
  /** single — один ответ в строке, multi — несколько */
  mode: 'single' | 'multi';
  rows: Option[];
  rowsFrom?: OptionsFrom;
  columns: Option[];
  randomizeRows?: boolean;
  /** all — обязательны все строки, none — ни одна, число — минимум заполненных строк */
  requiredRows?: 'all' | 'none' | number;
}

export interface DateQuestion extends QuestionBase {
  type: 'date';
  /** YYYY-MM-DD */
  min?: string;
  max?: string;
}

export interface PhoneQuestion extends QuestionBase {
  type: 'phone';
  /** ru — +7 и 10 цифр, international — + и 8–15 цифр */
  format?: 'ru' | 'international';
}

export interface InfoBlock extends QuestionBase {
  type: 'info';
}

/**
 * Скрытая переменная: не показывается, значение задаёт скрипт (sl.set) или параметр ссылки.
 * Аналог «скрипта подготовки»: группа квоты, ячейка теста, вычисленный индекс.
 */
export interface HiddenQuestion extends QuestionBase {
  type: 'hidden';
  /** Взять значение из параметра ссылки (?panel_id=...) */
  fromParam?: string;
  /** Тип значения в выгрузке */
  valueType?: 'number' | 'string';
}

export type Question =
  | ChoiceQuestion
  | MultiQuestion
  | TextQuestion
  | NumberQuestion
  | ScaleQuestion
  | MatrixQuestion
  | DateQuestion
  | PhoneQuestion
  | InfoBlock
  | HiddenQuestion;

export type QuestionType = Question['type'];

export const END = 'END';
export const SCREENOUT = 'SCREENOUT';

export interface JumpRule {
  if: Condition;
  /** ID страницы, END (завершить) или SCREENOUT (отсеять) */
  goTo: string;
}

export interface Page {
  id: string;
  title?: string;
  showIf?: Condition;
  questions: Question[];
  scripts?: PageScripts;
  /** Переходы после страницы: срабатывает первое подходящее правило */
  jumps?: JumpRule[];
}

export interface SurveySettings {
  showProgress?: boolean;
  allowBack?: boolean;
  /** Кнопка «Завершить» — респондент может досрочно закончить опрос */
  allowEarlyFinish?: boolean;
  completeMessage?: string;
  screenoutMessage?: string;
  earlyFinishMessage?: string;
  closedMessage?: string;
}

export interface Survey {
  formatVersion: 1;
  title: string;
  description?: string;
  settings?: SurveySettings;
  /** Свои стили для страницы опроса */
  css?: string;
  scripts?: SurveyScripts;
  pages: Page[];
}

// ---- Ответы ----

export type AnswerValue = number | number[] | string | Record<string, number | number[]>;

export interface Answer {
  v: AnswerValue;
  /** Тексты «Другое»: ключ — код варианта (или код строки матрицы) */
  o?: Record<string, string>;
}

export type Answers = Record<string, Answer>;

export interface RespondentContext {
  answers: Answers;
  params: Record<string, string>;
  /** Зерно для рандомизации — стабильно для одного респондента */
  seed: string;
  survey: Survey;
}

export const DEFAULT_SETTINGS: Required<SurveySettings> = {
  showProgress: true,
  allowBack: true,
  allowEarlyFinish: false,
  completeMessage: 'Спасибо! Ваши ответы сохранены.',
  screenoutMessage: 'Спасибо за интерес! К сожалению, вы не подходите под условия этого опроса.',
  earlyFinishMessage: 'Опрос завершён. Спасибо за уделённое время!',
  closedMessage: 'Опрос закрыт.',
};

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single: 'Один ответ',
  multi: 'Несколько ответов',
  dropdown: 'Выпадающий список',
  text: 'Открытый текст',
  number: 'Число',
  scale: 'Шкала / NPS',
  matrix: 'Матрица',
  date: 'Дата',
  phone: 'Телефон',
  info: 'Информационный блок',
  hidden: 'Скрытая переменная',
};
