// Формат анкеты SurveyLAB (formatVersion 2). Подробное описание: docs/survey-format.md
// Анкета — последовательность вопросов (один вопрос на экран), сгруппированных в блоки.
// Вся логика задаётся на вопросах: условие показа и действия перед показом / после ответа.

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

export interface SurveyScripts {
  /** Глобальный скрипт: выполняется при каждой загрузке страницы до остальных. Функции можно класть в sl.shared */
  init?: string;
}

/**
 * Действия — логика без программирования (как в Survey Studio).
 * Выполняются по порядку; у каждого может быть условие `if`.
 */
export type BeforeActionKind =
  | 'hideOptions'      // скрыть варианты (строки матрицы) с кодами codes
  | 'showOnlyOptions'  // показать только варианты с кодами codes
  | 'hideOptionsFrom'  // скрыть варианты, выбранные (filter: selected) или невыбранные в вопросе question
  | 'skipIfFewer'      // не показывать вопрос, если видимых вариантов (строк) меньше n
  | 'answer'           // отметить ответ value и не показывать вопрос; без value — единственный видимый вариант
  | 'setValue';        // записать value в скрытую переменную target

export type AfterActionKind =
  | 'goTo'             // перейти к вопросу или странице target
  | 'end'              // завершить анкету
  | 'screenout'        // отсеять респондента
  | 'setValue'         // записать value в скрытую переменную target
  | 'error';           // не пускать дальше, показать message

export interface Action {
  if?: Condition;
  do: BeforeActionKind | AfterActionKind;
  codes?: number[];
  question?: string;
  filter?: 'selected' | 'notSelected';
  n?: number;
  target?: string;
  /** Для setValue строка может содержать подстановки {{Q1}} */
  value?: number | string | number[];
  message?: string;
}

export interface QuestionActions {
  before?: Action[];
  after?: Action[];
}

interface QuestionBase {
  /** Уникальный ID = имя переменной в выгрузке: латиница, цифры, _, начинается с буквы */
  id: string;
  text: string;
  hint?: string;
  /** По умолчанию true (кроме info) */
  required?: boolean;
  showIf?: Condition;
  actions?: QuestionActions;
  scripts?: QuestionScripts;
  /** Скрыть кнопку «Назад», пока вопрос на экране */
  hideBack?: boolean;
  /** Скрыть кнопку «Завершить досрочно», пока вопрос на экране */
  hideFinish?: boolean;
}

/** Порядок вариантов: random — перемешать, rotate — циклический сдвиг с сохранением порядка */
export type OptionOrder = 'random' | 'rotate';

interface ChoiceBase extends QuestionBase {
  options: Option[];
  optionsFrom?: OptionsFrom;
  /** Устаревший синоним order: "random" */
  randomize?: boolean;
  order?: OptionOrder;
  /** Поле «укажите» видно всегда, а не только после выбора варианта */
  showOtherAlways?: boolean;
}

export interface ChoiceQuestion extends ChoiceBase {
  type: 'single' | 'dropdown';
  /** Автопереход на следующую страницу после выбора (если на странице один вопрос) */
  autoNext?: boolean;
}

export interface MultiQuestion extends ChoiceBase {
  type: 'multi';
  minSelected?: number;
  maxSelected?: number;
}

/** Ранжирование: респондент расставляет варианты по местам (1 — самое важное) */
export interface RankingQuestion extends ChoiceBase {
  type: 'ranking';
  /** Сколько мест нужно заполнить; по умолчанию — все варианты */
  rankCount?: number;
}

export interface TextQuestion extends QuestionBase {
  type: 'text';
  multiline?: boolean;
  maxLength?: number;
  /** text — обычный текст, email — адрес почты, time — время ЧЧ:ММ */
  inputType?: 'text' | 'email' | 'time';
  /** Запретить вставку из буфера обмена */
  noPaste?: boolean;
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
  autoNext?: boolean;
}

export interface MatrixQuestion extends QuestionBase {
  type: 'matrix';
  /** single — один ответ в строке, multi — несколько */
  mode: 'single' | 'multi';
  rows: Option[];
  rowsFrom?: OptionsFrom;
  columns: Option[];
  /** Устаревший синоним rowOrder: "random" */
  randomizeRows?: boolean;
  rowOrder?: OptionOrder;
  /** Перевернуть таблицу: строки — варианты ответа, столбцы — утверждения (только отображение) */
  transpose?: boolean;
  /** Вертикальный текст в заголовках столбцов */
  verticalHeaders?: boolean;
  /** Показывать следующую строку только после ответа на предыдущую */
  progressiveRows?: boolean;
  /** Карусель: по одной строке на экране, после ответа — следующая */
  carousel?: boolean;
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
  | RankingQuestion
  | TextQuestion
  | NumberQuestion
  | ScaleQuestion
  | MatrixQuestion
  | DateQuestion
  | PhoneQuestion
  | InfoBlock
  | HiddenQuestion;

export type QuestionType = Question['type'];

/** Типы со списком вариантов options */
export const CHOICE_TYPES: QuestionType[] = ['single', 'multi', 'dropdown', 'ranking'];
/** Типы, у которых есть варианты или строки (для переноса и действий с вариантами) */
export const OPTION_TYPES: QuestionType[] = [...CHOICE_TYPES, 'matrix'];

export const END = 'END';
export const SCREENOUT = 'SCREENOUT';

/** Правило перехода (внутреннее представление действий goTo / end / screenout) */
export interface JumpRule {
  if?: Condition;
  /** ID вопроса или блока, END (завершить) или SCREENOUT (отсеять) */
  goTo: string;
}

/** Блок — группа вопросов (для порядка и навигации в конструкторе; своей логики нет) */
export interface Block {
  id: string;
  /** Заголовок блока; если задан — показывается респонденту над вопросами блока */
  title?: string;
  questions: Question[];
}

/**
 * Экран опроса — внутреннее понятие движка: сейчас каждый вопрос показывается на отдельном экране,
 * ID экрана = ID вопроса. В формате анкеты экранов нет.
 */
export interface Page {
  id: string;
  questions: Question[];
  showIf?: Condition;
  jumps?: JumpRule[];
  scripts?: { onShow?: string; onSubmit?: string };
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
  formatVersion: 2;
  title: string;
  description?: string;
  settings?: SurveySettings;
  /** Свои стили для страницы опроса */
  css?: string;
  scripts?: SurveyScripts;
  blocks: Block[];
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
  ranking: 'Ранжирование',
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
