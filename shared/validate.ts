import { END, SCREENOUT, type Condition, type Question, type Survey } from './types.ts';

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

const TYPES = new Set(['single', 'multi', 'dropdown', 'text', 'number', 'scale', 'matrix', 'date', 'phone', 'info', 'hidden']);
const SCRIPT_KEYS = {
  survey: ['init'],
  page: ['onShow', 'onSubmit'],
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
  if (s.formatVersion !== 1) err('formatVersion', 'Должно быть 1');
  if (typeof s.title !== 'string' || !s.title.trim()) err('title', 'Укажите название анкеты');
  if (s.settings !== undefined && !isObj(s.settings)) err('settings', 'Ожидается объект');
  if (s.css !== undefined && typeof s.css !== 'string') err('css', 'Ожидается строка');
  checkScripts(s.scripts, 'survey', 'анкета', err);
  if (!Array.isArray(s.pages) || s.pages.length === 0) {
    err('pages', 'Нужна хотя бы одна страница');
    return { ok: false, errors, warnings };
  }

  // Порядок вопросов: id → { страница, позиция }
  const qIndex = new Map<string, { page: number; pos: number; q: Question }>();
  const pageIds = new Map<string, number>();
  let pos = 0;

  s.pages.forEach((p, pi) => {
    const pw = `страница ${pi + 1}`;
    if (!isObj(p)) return err(pw, 'Ожидается объект');
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) err(pw, 'ID страницы: латиница, цифры и _, начинается с буквы');
    else if (pageIds.has(p.id)) err(p.id, 'ID страницы повторяется');
    else if (p.id === END || p.id === SCREENOUT) err(p.id, 'Это зарезервированное имя');
    else pageIds.set(p.id, pi);
    if (!Array.isArray(p.questions)) return err(p.id ?? pw, 'Нужен массив questions');
    if (p.questions.length === 0) warn(p.id ?? pw, 'Пустая страница — она будет пропущена');
    checkScripts(p.scripts, 'page', p.id ?? pw, err);

    p.questions.forEach((q, qi) => {
      const qw = isObj(q) && typeof q.id === 'string' ? q.id : `${p.id ?? pw} → вопрос ${qi + 1}`;
      if (!isObj(q)) return err(qw, 'Ожидается объект');
      if (typeof q.id !== 'string' || !ID_RE.test(q.id)) {
        err(qw, 'ID вопроса: латиница, цифры и _, начинается с буквы, до 32 символов');
      } else if (RESERVED_IDS.has(q.id.toLowerCase())) {
        err(qw, `ID «${q.id}» зарезервирован для служебной переменной`);
      } else if ([...qIndex.keys()].some((k) => k.toLowerCase() === q.id.toLowerCase())) {
        err(qw, 'ID вопроса повторяется (регистр букв не учитывается)');
      } else {
        qIndex.set(q.id, { page: pi, pos: pos++, q: q as Question });
      }
      if (!TYPES.has(q.type)) return err(qw, `Неизвестный тип «${String(q.type)}»`);
      if (typeof q.text !== 'string' || (!q.text.trim() && q.type !== 'info' && q.type !== 'hidden')) err(qw, 'Нужен текст вопроса');
      checkScripts(q.scripts, 'question', qw, err);
      validateQuestion(q as Question, qw, err, warn);
    });
  });

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
    if (ARRAY_OPS.has(c.op) && !Array.isArray(c.value)) err(where, `Оператору «${c.op}» нужен массив в value`);
  };

  s.pages.forEach((p, pi) => {
    if (!isObj(p) || !Array.isArray(p.questions)) return;
    if (p.showIf) checkCondition(p.showIf, `${p.id} → условие показа`, { page: pi, pos: Infinity }, false);
    p.questions.forEach((q) => {
      const info = qIndex.get(q?.id);
      if (!info || !isObj(q)) return;
      if (q.showIf) checkCondition(q.showIf, `${q.id} → условие показа`, info, true);
      const from = (q as { optionsFrom?: { question: string; filter: string } }).optionsFrom
        ?? (q as { rowsFrom?: { question: string; filter: string } }).rowsFrom;
      if (from) {
        if (!isObj(from) || typeof from.question !== 'string') err(q.id, 'optionsFrom/rowsFrom: укажите question');
        else {
          const src = checkRef(`${q.id} → перенос вариантов`, from.question, info, true);
          if (src && !['single', 'multi', 'dropdown', 'matrix'].includes(src.type)) {
            err(q.id, `Перенос возможен только из вопросов с вариантами, а «${src.id}» — ${src.type}`);
          }
          if (!['selected', 'notSelected', 'all'].includes(from.filter)) {
            err(q.id, 'filter переноса: selected, notSelected или all');
          }
        }
      }
      for (const t of [q.text, q.hint]) checkPiping(t, q.id, info);
    });
    (p.jumps ?? []).forEach((j, ji) => {
      const where = `${p.id} → переход ${ji + 1}`;
      if (!isObj(j)) return err(where, 'Ожидается объект {if, goTo}');
      if (!j.if) err(where, 'Нужно условие if');
      else checkCondition(j.if, where, { page: pi, pos: Infinity }, true);
      if (j.goTo !== END && j.goTo !== SCREENOUT) {
        const t = pageIds.get(j.goTo);
        if (t === undefined) err(where, `goTo: нет страницы «${j.goTo}» (или используйте END / SCREENOUT)`);
        else if (t <= pi) warn(where, 'Переход назад — возможен бесконечный цикл');
      }
    });
  });

  function checkPiping(text: unknown, where: string, current: { page: number; pos: number }) {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/\{\{\s*([A-Za-z]\w*)(?:\.(\w+))?\s*\}\}/g)) {
      if (m[1] === 'param') continue;
      if (!qIndex.has(m[1])) warn(where, `Подстановка {{${m[1]}}}: такого вопроса нет`);
      else checkRef(`${where} → подстановка`, m[1], current, true);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
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
  });
}

function validateQuestion(
  q: Question,
  w: string,
  err: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
) {
  switch (q.type) {
    case 'single':
    case 'dropdown':
    case 'multi':
      validateOptions(q.options, w, 'options', err, !!q.optionsFrom);
      if (q.type === 'multi') {
        if (q.minSelected !== undefined && (!isInt(q.minSelected) || q.minSelected < 1)) err(w, 'minSelected: целое ≥ 1');
        if (q.maxSelected !== undefined && (!isInt(q.maxSelected) || q.maxSelected < 1)) err(w, 'maxSelected: целое ≥ 1');
        if (q.minSelected && q.maxSelected && q.minSelected > q.maxSelected) err(w, 'minSelected больше maxSelected');
      } else if (Array.isArray(q.options) && q.options.some((o) => o?.exclusive)) {
        warn(w, 'exclusive имеет смысл только в вопросах multi');
      }
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
