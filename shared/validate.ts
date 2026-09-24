import { END, OPTION_TYPES, SCREENOUT, type Condition, type Question, type Survey } from './types.ts';

export interface Issue {
  /** Где проблема: «Q3», «P2 → переход 1», «settings» */
  where: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Имена служебных переменных выгрузки — не могут быть ID вопросов */
export const RESERVED_IDS = new Set([
  'resp_id', 'status', 'started_at', 'completed_at', 'duration_sec', 'ip', 'user_agent', 'is_test', 'version',
].map((s) => s.toLowerCase()));

const TYPES = new Set(['single', 'multi', 'dropdown', 'ranking', 'text', 'number', 'scale', 'matrix', 'date', 'phone', 'info', 'hidden']);
const SCRIPT_KEYS = {
  survey: ['init'],
  question: ['onShow', 'onChange', 'validate'],
} as const;

function checkScripts(scripts: unknown, level: keyof typeof SCRIPT_KEYS, where: string, err: (w: string, m: string) => void) {
  if (scripts === undefined) return;
  if (!isObj(scripts)) return err(where, 'scripts: ожидается объект');
  const allowed: readonly string[] = SCRIPT_KEYS[level];
  for (const [k, code] of Object.entries(scripts)) {
    if (!allowed.includes(k)) err(where, `scripts.${k}: неизвестный хук, допустимы ${allowed.join(', ')}`);
    else if (typeof code !== 'string') err(where, `scripts.${k}: ожидается строка с JS-кодом`);
    else {
      try { new Function('sl', code); } catch (e) { err(where, `scripts.${k}: синтаксическая ошибка — ${(e as Error).message}`); }
    }
  }
}
const OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn',
  'contains', 'notContains', 'containsAny', 'containsAll', 'answered', 'notAnswered',
]);
const BEFORE_ACTIONS = ['hideOptions', 'showOnlyOptions', 'hideOptionsFrom', 'skipIfFewer', 'answer', 'setValue'] as const;
const AFTER_ACTIONS = ['goTo', 'end', 'screenout', 'setValue', 'error'] as const;
const ARRAY_OPS = new Set(['in', 'notIn', 'containsAny', 'containsAll']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

export function validateSurvey(input: unknown): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (where: string, message: string) => errors.push({ where, message });
  const warn = (where: string, message: string) => warnings.push({ where, message });

  if (!isObj(input)) {
    err('анкета', 'Ожидается JSON-объект');
    return { ok: false, errors, warnings };
  }
  const s = input as unknown as Survey;
  if (s.formatVersion !== 2) err('formatVersion', 'Должно быть 2');
  if (typeof s.title !== 'string' || !s.title.trim()) err('title', 'Укажите название анкеты');
  if (s.settings !== undefined && !isObj(s.settings)) err('settings', 'Ожидается объект');
  else if (s.settings) validateSettings(s.settings, err, warn);
  if (s.css !== undefined && typeof s.css !== 'string') err('css', 'Ожидается строка');
  checkScripts(s.scripts, 'survey', 'анкета', err);
  if (!Array.isArray(s.blocks) || s.blocks.length === 0) {
    err('blocks', 'Нужен хотя бы один блок с вопросами');
    return { ok: false, errors, warnings };
  }

  // Порядок вопросов. Каждый вопрос — отдельный экран, поэтому page = pos
  const qIndex = new Map<string, { page: number; pos: number; q: Question }>();
  const blockStart = new Map<string, number>();
  let pos = 0;

  s.blocks.forEach((b, bi) => {
    const bw = `блок ${bi + 1}`;
    if (!isObj(b)) return err(bw, 'Ожидается объект');
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) err(bw, 'ID блока: латиница, цифры и _, начинается с буквы');
    else if (blockStart.has(b.id)) err(b.id, 'ID блока повторяется');
    else if (b.id === END || b.id === SCREENOUT) err(b.id, 'Это зарезервированное имя');
    else blockStart.set(b.id, pos);
    if (!Array.isArray(b.questions)) return err(b.id ?? bw, 'Нужен массив questions');
    if (b.questions.length === 0) warn(b.id ?? bw, 'Пустой блок');

    b.questions.forEach((q, qi) => {
      const qw = isObj(q) && typeof q.id === 'string' ? q.id : `${b.id ?? bw} → вопрос ${qi + 1}`;
      if (!isObj(q)) return err(qw, 'Ожидается объект');
      if (typeof q.id !== 'string' || !ID_RE.test(q.id)) {
        err(qw, 'ID вопроса: латиница, цифры и _, начинается с буквы, до 32 символов');
      } else if (RESERVED_IDS.has(q.id.toLowerCase())) {
        err(qw, `ID «${q.id}» зарезервирован для служебной переменной`);
      } else if ([...qIndex.keys()].some((k) => k.toLowerCase() === q.id.toLowerCase())) {
        err(qw, 'ID вопроса повторяется (регистр букв не учитывается)');
      } else {
        qIndex.set(q.id, { page: pos, pos, q: q as Question });
        pos++;
      }
      if (!TYPES.has(q.type)) return err(qw, `Неизвестный тип «${String(q.type)}»`);
      if (typeof q.text !== 'string' || (!q.text.trim() && q.type !== 'info' && q.type !== 'hidden')) err(qw, 'Нужен текст вопроса');
      checkScripts(q.scripts, 'question', qw, err);
      validateQuestion(q as Question, qw, err, warn);
    });
  });
  for (const id of blockStart.keys()) {
    if (qIndex.has(id)) err(id, 'ID блока совпадает с ID вопроса — переходы станут неоднозначными');
  }

  // Ссылки: условия, переносы, переходы, пайпинг
  const checkRef = (where: string, id: string, current: { page: number; pos: number } | null, samePageOk: boolean) => {
    const ref = qIndex.get(id);
    if (!ref) {
      err(where, `Ссылка на несуществующий вопрос «${id}»`);
      return undefined;
    }
    if (current && ref.q.type !== 'hidden') {
      const later = ref.page > current.page || (ref.page === current.page && (!samePageOk || ref.pos >= current.pos));
      if (later) warn(where, `Ссылка на вопрос «${id}», который идёт позже — на момент показа ответа ещё не будет`);
    }
    return ref.q;
  };

  const checkCondition = (c: Condition, where: string, current: { page: number; pos: number } | null, samePageOk: boolean) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return err(where, 'Условие должно быть объектом');
    if ('all' in c || 'any' in c) {
      const list = (c as { all?: Condition[]; any?: Condition[] }).all ?? (c as { any: Condition[] }).any;
      if (!Array.isArray(list) || list.length === 0) return err(where, 'all/any: нужен непустой массив условий');
      list.forEach((x) => checkCondition(x, where, current, samePageOk));
      return;
    }
    if ('not' in c) return checkCondition(c.not, where, current, samePageOk);
    if (!OPS.has(c.op)) return err(where, `Неизвестный оператор «${String(c.op)}»`);
    if (c.param !== undefined) {
      if (typeof c.param !== 'string' || !c.param) err(where, 'param: укажите имя параметра ссылки');
    } else if (typeof c.q !== 'string') {
      return err(where, 'Условие: укажите q (ID вопроса) или param');
    } else {
      const ref = checkRef(where, c.q, current, samePageOk);
      if (ref) {
        if (ref.type === 'info') err(where, `«${c.q}» — информационный блок, у него нет ответа`);
        if (c.row !== undefined) {
          if (ref.type !== 'matrix') err(where, `row можно указывать только для матрицы, а «${c.q}» — ${ref.type}`);
        } else if (ref.type === 'matrix' && c.op !== 'answered' && c.op !== 'notAnswered') {
          err(where, `Для матрицы «${c.q}» укажите row — код строки`);
        }
      }
    }
    const needsValue = c.op !== 'answered' && c.op !== 'notAnswered';
    if (needsValue && c.value === undefined) err(where, `Оператору «${c.op}» нужно value`);
    else if (needsValue && (c.value === '' || (Array.isArray(c.value) && c.value.length === 0))) err(where, 'Укажите значение в условии');
    if (ARRAY_OPS.has(c.op) && !Array.isArray(c.value)) err(where, `Оператору «${c.op}» нужен массив в value`);
  };

  for (const b of s.blocks) {
    if (!isObj(b) || !Array.isArray(b.questions)) continue;
    for (const q of b.questions) {
      const info = qIndex.get(q?.id);
      if (!info || !isObj(q)) continue;
      if (q.showIf) checkCondition(q.showIf, `${q.id} → условие показа`, info, true);
      const from = (q as { optionsFrom?: { question: string; filter: string } }).optionsFrom
        ?? (q as { rowsFrom?: { question: string; filter: string } }).rowsFrom;
      if (from) {
        if (!isObj(from) || typeof from.question !== 'string') err(q.id, 'optionsFrom/rowsFrom: укажите question');
        else {
          const src = checkRef(`${q.id} → перенос вариантов`, from.question, info, true);
          if (src && !OPTION_TYPES.includes(src.type)) {
            err(q.id, `Перенос возможен только из вопросов с вариантами, а «${src.id}» — ${src.type}`);
          }
          if (!['selected', 'notSelected', 'all'].includes(from.filter)) {
            err(q.id, 'filter переноса: selected, notSelected или all');
          }
        }
      }
      for (const t of [q.text, q.hint]) checkPiping(t, q.id, info);
      checkActions(q as Question, info, info.pos);
    }
  }

  function checkActions(q: Question, info: { page: number; pos: number }, pi: number) {
    const acts = (q as { actions?: unknown }).actions;
    if (acts === undefined) return;
    if (!isObj(acts)) return err(q.id, 'actions: ожидается объект {before, after}');
    for (const phase of ['before', 'after'] as const) {
      const list = (acts as Record<string, unknown>)[phase];
      if (list === undefined) continue;
      if (!Array.isArray(list)) { err(q.id, `actions.${phase}: ожидается массив`); continue; }
      (list as any[]).forEach((a: any, i: number) => {
        const where = `${q.id} → ${phase === 'before' ? 'перед показом' : 'после ответа'} ${i + 1}`;
        if (!a || typeof a !== 'object' || Array.isArray(a)) return err(where, 'Ожидается объект {do, ...}');
        const allowed: readonly string[] = phase === 'before' ? BEFORE_ACTIONS : AFTER_ACTIONS;
        if (!allowed.includes(a.do)) return err(where, `Действие «${a.do}» недоступно ${phase === 'before' ? 'перед показом' : 'после ответа'}`);
        if (a.if !== undefined) checkCondition(a.if, where, phase === 'before' ? info : { page: pi, pos: Infinity }, true);
        switch (a.do) {
          case 'hideOptions':
          case 'showOnlyOptions':
            if (!Array.isArray(a.codes) || !a.codes.every(isInt)) err(where, 'codes: массив кодов');
            if (!OPTION_TYPES.includes(q.type)) err(where, 'У вопроса нет вариантов');
            break;
          case 'hideOptionsFrom':
            if (typeof a.question !== 'string') err(where, 'Укажите question');
            else checkRef(where, a.question, info, true);
            if (!OPTION_TYPES.includes(q.type)) err(where, 'У вопроса нет вариантов');
            break;
          case 'skipIfFewer':
            if (!isInt(a.n) || a.n < 1) err(where, 'n: целое ≥ 1');
            break;
          case 'setValue': {
            const t = typeof a.target === 'string' ? qIndex.get(a.target) : undefined;
            if (!t) err(where, 'target: укажите скрытую переменную');
            else if (t.q.type !== 'hidden') err(where, `«${a.target}» — не скрытая переменная`);
            if (a.value === undefined) err(where, 'Укажите value');
            break;
          }
          case 'goTo': {
            const t = typeof a.target === 'string' ? qIndex.get(a.target)?.pos ?? blockStart.get(a.target) : undefined;
            if (t === undefined) err(where, `Нет вопроса или блока «${a.target}»`);
            else if (t <= pi) warn(where, 'Переход назад — возможен бесконечный цикл');
            break;
          }
          case 'error':
            if (a.message !== undefined && typeof a.message !== 'string') err(where, 'message: строка');
            if (a.if === undefined) warn(where, 'Ошибка без условия не даст пройти вопрос');
            break;
        }
      });
    }
  }

  function checkPiping(text: unknown, where: string, current: { page: number; pos: number }) {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/\{\{\s*([A-Za-z]\w*)(?:\.(\w+))?\s*\}\}/g)) {
      if (m[1] === 'param' || m[1] === 'resp_id') continue;
      if (!qIndex.has(m[1])) warn(where, `Подстановка {{${m[1]}}}: такого вопроса нет`);
      else checkRef(`${where} → подстановка`, m[1], current, true);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

const BOOL_SETTINGS = ['showProgress', 'allowBack', 'allowEarlyFinish', 'showQuestionNumbers', 'enterSubmits', 'autoNext', 'noPaste', 'allowRetake'];
const TEXT_SETTINGS = [
  'completeMessage', 'screenoutMessage', 'earlyFinishMessage', 'closedMessage', 'password', 'footerText',
  'nextLabel', 'backLabel', 'submitLabel', 'earlyFinishLabel',
];
const URL_SETTINGS = ['redirectComplete', 'redirectScreenout', 'redirectEarlyFinish', 'logoUrl'];

function validateSettings(st: Record<string, unknown>, err: (w: string, m: string) => void, warn: (w: string, m: string) => void) {
  const w = (k: string) => `settings.${k}`;
  for (const k of BOOL_SETTINGS) if (st[k] !== undefined && typeof st[k] !== 'boolean') err(w(k), 'Ожидается true или false');
  for (const k of TEXT_SETTINGS) if (st[k] !== undefined && typeof st[k] !== 'string') err(w(k), 'Ожидается строка');
  for (const k of URL_SETTINGS) {
    if (st[k] === undefined) continue;
    if (typeof st[k] !== 'string' || !/^https?:\/\/\S+$/i.test(st[k] as string)) err(w(k), 'Адрес должен начинаться с http:// или https://');
  }
  for (const k of ['openFrom', 'closeAt']) {
    if (st[k] !== undefined && (typeof st[k] !== 'string' || isNaN(Date.parse(st[k] as string)))) err(w(k), 'Ожидается дата и время (ISO 8601)');
  }
  if (typeof st.openFrom === 'string' && typeof st.closeAt === 'string' && Date.parse(st.openFrom) >= Date.parse(st.closeAt)) {
    err(w('closeAt'), 'Окончание сбора раньше начала');
  }
  if (st.maxResponses !== undefined && (!isInt(st.maxResponses) || st.maxResponses < 1)) err(w('maxResponses'), 'Целое число ≥ 1');
  if (st.accentColor !== undefined && (typeof st.accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(st.accentColor))) {
    err(w('accentColor'), 'Цвет в формате #RRGGBB');
  }
  if (st.allowRetake && st.maxResponses) warn(w('allowRetake'), 'При повторном прохождении один человек может занять несколько мест в лимите ответов');
}

function validateOptions(list: unknown, where: string, name: string, err: (w: string, m: string) => void, allowEmpty = false) {
  if (!Array.isArray(list)) return err(where, `Нужен массив ${name}`);
  if (list.length === 0 && !allowEmpty) return err(where, `${name}: нужен хотя бы один вариант`);
  const codes = new Set<number>();
  list.forEach((o, i) => {
    if (!isObj(o)) return err(where, `${name}[${i + 1}]: ожидается объект {code, text}`);
    if (!isInt(o.code)) err(where, `${name}[${i + 1}]: code должен быть целым числом`);
    else if (codes.has(o.code)) err(where, `${name}: код ${o.code} повторяется`);
    else codes.add(o.code);
    if (typeof o.text !== 'string' || !o.text.trim()) err(where, `${name}[${i + 1}]: нужен текст`);
    for (const k of ['other', 'exclusive', 'fixed', 'hidden']) {
      if (o[k] !== undefined && typeof o[k] !== 'boolean') err(where, `${name}[${i + 1}].${k}: true или false`);
    }
  });
  if (list.length > 0 && list.every((o) => isObj(o) && o.hidden === true) && !allowEmpty) err(where, `${name}: все варианты скрыты`);
}

function validateQuestion(
  q: Question,
  w: string,
  err: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
) {
  for (const k of ['requiredMessage', 'note', 'placeholder', 'suffix', 'patternMessage'] as const) {
    const v = (q as unknown as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'string') err(w, `${k}: ожидается строка`);
  }
  if ('columnCount' in q && q.columnCount !== undefined && (!isInt(q.columnCount) || q.columnCount < 1 || q.columnCount > 4)) {
    err(w, 'columnCount: от 1 до 4');
  }
  switch (q.type) {
    case 'single':
    case 'dropdown':
    case 'multi':
      validateOptions(q.options, w, 'options', err, !!q.optionsFrom);
      if (q.order !== undefined && q.order !== 'random' && q.order !== 'rotate') err(w, 'order: random или rotate');
      if (q.type === 'multi') {
        if (q.minSelected !== undefined && (!isInt(q.minSelected) || q.minSelected < 1)) err(w, 'minSelected: целое ≥ 1');
        if (q.maxSelected !== undefined && (!isInt(q.maxSelected) || q.maxSelected < 1)) err(w, 'maxSelected: целое ≥ 1');
        if (q.minSelected && q.maxSelected && q.minSelected > q.maxSelected) err(w, 'minSelected больше maxSelected');
      } else if (Array.isArray(q.options) && q.options.some((o) => o?.exclusive)) {
        warn(w, 'exclusive имеет смысл только в вопросах multi');
      }
      break;
    case 'ranking':
      validateOptions(q.options, w, 'options', err, !!q.optionsFrom);
      if (Array.isArray(q.options) && q.options.some((o) => o?.other || o?.exclusive)) warn(w, 'В ранжировании «другое» и «эксклюзив» не используются');
      if (q.rankCount !== undefined && (!isInt(q.rankCount) || q.rankCount < 1)) err(w, 'rankCount: целое ≥ 1');
      if (q.order !== undefined && q.order !== 'random' && q.order !== 'rotate') err(w, 'order: random или rotate');
      break;
    case 'scale':
      if (!isInt(q.from) || !isInt(q.to)) err(w, 'from и to — целые числа');
      else if (q.from >= q.to) err(w, 'from должно быть меньше to');
      else if (q.to - q.from > 20) err(w, 'Шкала не может быть длиннее 21 точки');
      if (q.labels !== undefined && !isObj(q.labels)) err(w, 'labels: объект {"1": "подпись"}');
      if (q.extraOptions !== undefined) {
        validateOptions(q.extraOptions, w, 'extraOptions', err);
        if (Array.isArray(q.extraOptions) && isInt(q.from) && isInt(q.to)) {
          for (const o of q.extraOptions) {
            if (isInt(o?.code) && o.code >= q.from && o.code <= q.to) err(w, `Код доп. варианта ${o.code} попадает в шкалу`);
          }
        }
      }
      break;
    case 'matrix':
      if (q.mode !== 'single' && q.mode !== 'multi') err(w, 'mode: single или multi');
      validateOptions(q.rows, w, 'rows', err, !!q.rowsFrom);
      validateOptions(q.columns, w, 'columns', err);
      if (q.rowOrder !== undefined && q.rowOrder !== 'random' && q.rowOrder !== 'rotate') err(w, 'rowOrder: random или rotate');
      if (q.carousel && q.progressiveRows) warn(w, 'carousel и progressiveRows вместе не имеют смысла — будет карусель');
      if (Array.isArray(q.columns) && q.columns.some((c) => c?.other)) err(w, '«Другое» в матрице задаётся в строках, а не в столбцах');
      if (q.requiredRows !== undefined && q.requiredRows !== 'all' && q.requiredRows !== 'none'
        && !(isInt(q.requiredRows) && q.requiredRows >= 1)) {
        err(w, 'requiredRows: "all", "none" или целое ≥ 1');
      }
      break;
    case 'number':
      if (q.min !== undefined && typeof q.min !== 'number') err(w, 'min — число');
      if (q.max !== undefined && typeof q.max !== 'number') err(w, 'max — число');
      if (typeof q.min === 'number' && typeof q.max === 'number' && q.min > q.max) err(w, 'min больше max');
      if (q.decimals !== undefined && (!isInt(q.decimals) || q.decimals < 0 || q.decimals > 6)) err(w, 'decimals: от 0 до 6');
      break;
    case 'text':
      if (q.maxLength !== undefined && (!isInt(q.maxLength) || q.maxLength < 1)) err(w, 'maxLength: целое ≥ 1');
      if (q.inputType !== undefined && !['text', 'email', 'time'].includes(q.inputType)) err(w, 'inputType: text, email или time');
      if (q.minLength !== undefined && (!isInt(q.minLength) || q.minLength < 1)) err(w, 'minLength: целое ≥ 1');
      if (isInt(q.minLength) && isInt(q.maxLength) && q.minLength > q.maxLength) err(w, 'minLength больше maxLength');
      if (q.pattern !== undefined) {
        if (typeof q.pattern !== 'string' || !q.pattern) err(w, 'pattern: регулярное выражение');
        else {
          try { new RegExp(q.pattern, 'u'); } catch (e) { err(w, `pattern: ${(e as Error).message}`); }
          if (q.inputType && q.inputType !== 'text') warn(w, 'pattern работает только для обычного текста');
        }
      }
      break;
    case 'date':
      for (const k of ['min', 'max'] as const) {
        if (q[k] !== undefined && (typeof q[k] !== 'string' || !DATE_RE.test(q[k]!))) err(w, `${k}: формат YYYY-MM-DD`);
      }
      break;
    case 'phone':
      if (q.format !== undefined && q.format !== 'ru' && q.format !== 'international') err(w, 'format: ru или international');
      break;
    case 'hidden':
      if (q.valueType !== undefined && q.valueType !== 'number' && q.valueType !== 'string') err(w, 'valueType: number или string');
      if (q.fromParam !== undefined && (typeof q.fromParam !== 'string' || !q.fromParam)) err(w, 'fromParam: имя параметра ссылки');
      break;
  }
}
