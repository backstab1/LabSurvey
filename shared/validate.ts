import { calcRefs, parseCalc } from './calc.ts';
import { LOOP_REF, expandAllLoops, hasLoops, loopChain } from './loops.ts';
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
  'loop', 'loop1', 'loop2', 'loop3', 'loop4', 'loop5',
  'resp_id', 'status', 'speeder', 'started_at', 'completed_at', 'duration_sec', 'ip', 'user_agent', 'is_test', 'version',
].map((s) => s.toLowerCase()));

const TYPES = new Set([
  'single', 'multi', 'dropdown', 'ranking', 'text', 'number', 'scale', 'matrix', 'date', 'phone', 'info', 'hidden',
  'slider', 'sum', 'file', 'hotspot', 'maxdiff', 'conjoint',
]);
const SCRIPT_KEYS = {
  survey: ['init'],
  question: ['beforeShow', 'onShow', 'onChange', 'validate'],
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
const BEFORE_ACTIONS = ['skip', 'hideOptions', 'showOnlyOptions', 'hideOptionsFrom', 'skipIfFewer', 'answer', 'setValue'] as const;
const AFTER_ACTIONS = ['goTo', 'skipQuestion', 'markAnswered', 'end', 'screenout', 'setValue', 'error'] as const;
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
  checkRandomBlocks(s, err, warn);

  // Циклы: структура и копии вопросов (FREQ_1, RATE_1_2), на которые можно ссылаться снаружи
  const instances = new Map<string, { page: number; pos: number; q: Question }>();
  if (hasLoops(s) && checkLoops(s, qIndex, blockStart, err, warn)) {
    try {
      const baseIds = new Set([...qIndex.keys(), ...blockStart.keys()].map((x) => x.toLowerCase()));
      // Вопросы вне циклов в развёрнутой анкете — те же объекты; копии повторов — новые
      const originals = new Set(s.blocks.flatMap((b) => b.questions));
      for (const b of expandAllLoops(s).blocks) {
        for (const q of b.questions) {
          if (originals.has(q)) continue;
          if (baseIds.has(q.id.toLowerCase())) { err(q.id, `Копия вопроса в цикле получает ID «${q.id}», а такой ID уже есть в анкете`); continue; }
          let stem = q.id;
          while (!qIndex.has(stem) && /_\d+$/.test(stem)) stem = stem.replace(/_\d+$/, '');
          const info = qIndex.get(stem);
          if (info) instances.set(q.id, { ...info, q });
        }
      }
    } catch { /* развёртка при ошибках структуры не нужна */ }
  }
  // Сколько циклов вокруг проверяемого вопроса (для LOOP-условий и {{loop}})
  let curLoops = 0;

  // Ссылки: условия, переносы, переходы, пайпинг
  const checkRef = (where: string, id: string, current: { page: number; pos: number } | null, samePageOk: boolean) => {
    const ref = qIndex.get(id) ?? instances.get(id);
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
    } else if (LOOP_REF.test(c.q)) {
      // Код текущего повтора цикла
      const level = Number(c.q.slice(4) || curLoops);
      if (!curLoops) err(where, `${c.q} можно использовать только в вопросах внутри цикла`);
      else if (level < 1 || level > curLoops) err(where, `${c.q}: у вопроса всего ${curLoops} уровн${curLoops === 1 ? 'ь' : 'я'} цикла`);
      if (['contains', 'notContains', 'containsAll', 'answered', 'notAnswered'].includes(c.op) || c.row !== undefined) {
        err(where, `${c.q}: сравнивайте код повтора операторами = ≠ > < или «из списка»`);
      }
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
    curLoops = hasLoops(s) ? loopChain(s, b).length : 0;
    if (!curLoops && typeof b.title === 'string' && /\{\{\s*loop/.test(b.title)) warn(b.id, '{{loop}} в заголовке блока вне цикла');
    for (const q of b.questions) {
      const info = qIndex.get(q?.id);
      if (!info || !isObj(q)) continue;
      if (q.showIf) checkCondition(q.showIf, `${q.id} → условие показа`, info, true);
      const att = (q as { attention?: unknown }).attention;
      if (att !== undefined) {
        if (!isObj(att) || att.correct === undefined) err(q.id, 'attention: укажите correct — условие правильного ответа');
        else {
          checkCondition(att.correct as Condition, `${q.id} → контрольный вопрос`, null, true);
          if (att.onFail !== undefined && att.onFail !== 'flag' && att.onFail !== 'screenout') err(q.id, 'attention.onFail: flag или screenout');
        }
        if (q.type === 'info' || q.type === 'hidden') err(q.id, 'Контрольным может быть только вопрос с ответом');
      }
      const sl = (q as { straightline?: unknown }).straightline;
      if (sl !== undefined) {
        if (q.type !== 'matrix') err(q.id, 'straightline работает только у матрицы');
        else if (sl !== 'flag' && sl !== 'screenout') err(q.id, 'straightline: flag или screenout');
      }
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
      const calc = (q as { calc?: unknown }).calc;
      if (calc !== undefined) {
        if (q.type !== 'hidden') err(q.id, 'calc работает только у скрытой переменной');
        else if (typeof calc !== 'string' || !calc.trim()) err(q.id, 'calc: формула-строка');
        else {
          try {
            for (const id of calcRefs(parseCalc(calc))) if (!qIndex.has(id)) err(`${q.id} → формула`, `Нет вопроса «${id}»`);
          } catch (e) { err(`${q.id} → формула`, (e as Error).message); }
          if ((q as { fromParam?: string }).fromParam) warn(q.id, 'У переменной и формула, и параметр ссылки — формула перезапишет значение');
        }
      }
      checkActions(q as Question, info, info.pos);
    }
  }

  // Квоты: условия могут ссылаться на любые вопросы и параметры ссылки
  if (s.quotas !== undefined) {
    if (!Array.isArray(s.quotas)) err('quotas', 'Ожидается массив');
    else {
      const seen = new Set<string>();
      s.quotas.forEach((qt, i) => {
        const w = `квота ${isObj(qt) && typeof qt.id === 'string' ? qt.id : i + 1}`;
        if (!isObj(qt)) return err(w, 'Ожидается объект {id, if, limit}');
        if (typeof qt.id !== 'string' || !ID_RE.test(qt.id)) err(w, 'id: латиница, цифры и _, начинается с буквы');
        else if (seen.has(qt.id.toLowerCase())) err(w, 'id квоты повторяется');
        else seen.add(qt.id.toLowerCase());
        if (qt.title !== undefined && typeof qt.title !== 'string') err(w, 'title: строка');
        if (!isInt(qt.limit) || qt.limit < 0) err(w, 'limit: целое ≥ 0');
        if (qt.if === undefined) err(w, 'Укажите условие if');
        else { curLoops = 0; checkCondition(qt.if, w, null, true); }
      });
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
          case 'skipQuestion':
          case 'markAnswered': {
            const t = typeof a.target === 'string' ? qIndex.get(a.target) : undefined;
            if (!t) err(where, `Нет вопроса «${a.target ?? ''}»`);
            else if (t.q.type === 'info' || t.q.type === 'hidden') err(where, `«${a.target}» — ${t.q.type === 'info' ? 'информационный блок' : 'скрытая переменная'}, пропускать нечего`);
            else if (t.pos <= pi) err(where, 'Пропустить можно только вопрос, который идёт дальше');
            if (a.do === 'markAnswered' && (a.value === undefined || a.value === '')) err(where, 'Укажите value — какой ответ записать');
            break;
          }
          case 'goTo': {
            const t = typeof a.target === 'string' ? qIndex.get(a.target)?.pos ?? blockStart.get(a.target) : undefined;
            if (t === undefined) err(where, `Нет вопроса или блока «${a.target}»`);
            else if (t <= pi) warn(where, 'Переход назад — возможен бесконечный цикл');
            break;
          }
          case 'end':
          case 'screenout':
            if (a.message !== undefined && typeof a.message !== 'string') err(where, 'message: строка');
            if (a.redirect !== undefined && (typeof a.redirect !== 'string' || !/^https?:\/\/\S+$/i.test(a.redirect))) {
              err(where, 'redirect: адрес должен начинаться с http:// или https://');
            }
            break;
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
      const lm = m[1].match(/^loop(\d?)$/);
      if (lm) {
        const level = Number(lm[1] || curLoops);
        if (!curLoops) warn(where, `{{${m[1]}}} работает только внутри цикла`);
        else if (level < 1 || level > curLoops) warn(where, `{{${m[1]}}}: у вопроса всего ${curLoops} уровн${curLoops === 1 ? 'ь' : 'я'} цикла`);
        continue;
      }
      if (!qIndex.has(m[1]) && !instances.has(m[1])) warn(where, `Подстановка {{${m[1]}}}: такого вопроса нет`);
      else checkRef(`${where} → подстановка`, m[1], current, true);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

const LOOP_SOURCE_TYPES = new Set(['single', 'multi', 'dropdown', 'ranking', 'matrix', 'number']);

/** Структура циклов; true — можно разворачивать */
function checkLoops(
  s: Survey, qIndex: Map<string, { pos: number; q: Question }>, blockStart: Map<string, number>,
  err: (w: string, m: string) => void, warn: (w: string, m: string) => void,
): boolean {
  let ok = true;
  const e = (w: string, m: string) => { ok = false; err(w, m); };
  const blocks = s.blocks.filter(isObj);
  const index = new Map(blocks.map((b, i) => [b.id, i]));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const isDescendant = (b: Survey['blocks'][number], ancestor: string) => {
    const seen = new Set<string>();
    let cur = b;
    while (cur?.parent && !seen.has(cur.id)) {
      if (cur.parent === ancestor) return true;
      seen.add(cur.id);
      cur = byId.get(cur.parent)!;
    }
    return false;
  };
  blocks.forEach((b, i) => {
    const w = b.id ?? `блок ${i + 1}`;
    if (b.parent !== undefined) {
      const p = typeof b.parent === 'string' ? byId.get(b.parent) : undefined;
      if (!p) return e(w, `parent: нет блока «${String(b.parent)}»`);
      if (!p.loop) return e(w, `parent: блок «${p.id}» не цикл — вкладывать можно только в цикл`);
      if (index.get(p.id)! >= i) return e(w, 'Вложенный блок должен идти после своего цикла');
      // Между циклом и вложенным блоком — только его же вложенные блоки
      for (let k = index.get(p.id)! + 1; k < i; k++) {
        if (!isDescendant(blocks[k], p.id)) return e(w, `Вложенный блок должен идти сразу за циклом «${p.id}» и другими его вложенными блоками`);
      }
      if (loopChain(s, b).length > 3) e(w, 'Не больше трёх уровней вложенных циклов');
    }
    const l = b.loop;
    if (l === undefined) return;
    if (!isObj(l)) return e(w, 'loop: ожидается объект');
    if (!b.questions.length) warn(w, 'Пустой цикл');
    if (!!l.question === !!l.items) return e(w, 'loop: укажите question (вопрос-источник) или items (свой список)');
    if (l.items !== undefined) validateOptions(l.items, `${w} → цикл`, 'items', e);
    if (l.question !== undefined) {
      const src = typeof l.question === 'string' ? qIndex.get(l.question) : undefined;
      if (!src) return e(w, `loop.question: нет вопроса «${String(l.question)}»`);
      if (!LOOP_SOURCE_TYPES.has(src.q.type)) e(w, `Источник цикла — вопрос с вариантами, матрица или число, а «${src.q.id}» — ${src.q.type}`);
      const srcBlock = blocks.find((x) => x.questions.some((q) => q.id === l.question));
      // Источник во вложенном блоке годится, если этот цикл вложен в тот же цикл (или в сам блок-источник) и идёт после него
      const inChain = !!srcBlock && srcBlock.id !== b.id && (isDescendant(b, srcBlock.id)
        || (!!srcBlock.parent && isDescendant(b, srcBlock.parent) && index.get(srcBlock.id)! < i));
      if (srcBlock?.id === b.id) e(w, 'Источник цикла не может быть внутри самого цикла');
      else if (srcBlock?.parent && !inChain) e(w, `Источник «${l.question}» — внутри другого цикла; вложите этот блок в тот цикл`);
      else if (src.pos >= (blockStart.get(b.id) ?? Infinity)) e(w, `Источник «${l.question}» должен идти раньше цикла`);
      if (src.q.type === 'number' && !l.max) warn(w, `Цикл по числу: не больше ${20} повторов — задайте max, если нужно другое`);
      if (l.columns !== undefined && (src.q.type !== 'matrix' || !Array.isArray(l.columns) || !l.columns.every(isInt))) e(w, 'loop.columns: коды столбцов, только для матрицы');
    }
    if (l.filter !== undefined && !['selected', 'notSelected', 'all'].includes(l.filter as string)) e(w, 'loop.filter: selected, notSelected или all');
    if (l.order !== undefined && l.order !== 'random' && l.order !== 'rotate') e(w, 'loop.order: random или rotate');
    if (l.max !== undefined && (!isInt(l.max) || l.max < 1)) e(w, 'loop.max: целое ≥ 1');
    if (b.order) warn(w, 'В цикле вопросы перемешиваются внутри каждого повтора');
  });
  return ok;
}

/** Блоки с перемешиванием: порядок внутри блока у каждого респондента свой */
function checkRandomBlocks(s: Survey, err: (w: string, m: string) => void, warn: (w: string, m: string) => void) {
  for (const b of s.blocks) {
    if (!isObj(b) || !Array.isArray(b.questions)) continue;
    const bw = typeof b.id === 'string' ? b.id : 'блок';
    for (const q of b.questions) {
      if (isObj(q) && q.fixed !== undefined && typeof q.fixed !== 'boolean') err(q.id ?? bw, 'fixed: true или false');
    }
    if (b.order === undefined) continue;
    if (b.order !== 'random' && b.order !== 'rotate') { err(bw, 'order блока: random или rotate'); continue; }
    const movable = b.questions.filter((q) => isObj(q) && !q.fixed && q.type !== 'hidden');
    if (movable.length < 2) warn(bw, 'В блоке с перемешиванием меньше двух незакреплённых вопросов — перемешивать нечего');
    // Ссылки между перемешиваемыми вопросами: ответа на «соседа» к моменту показа может ещё не быть
    const ids = new Set(movable.map((q) => q.id));
    for (const q of movable) {
      const { id, ...rest } = q as Question;
      const json = JSON.stringify(rest);
      for (const other of ids) {
        if (other === id) continue;
        const re = new RegExp(`"(q|question|target)":"${other}"|\\{\\{\\s*${other}[.}\\s]`);
        if (re.test(json)) {
          warn(id, `Ссылается на «${other}» из того же блока с перемешиванием — порядок у респондентов разный, ответа может ещё не быть. Закрепите оба вопроса или вынесите их из блока`);
        }
      }
    }
  }
}

const BOOL_SETTINGS = ['showProgress', 'allowBack', 'allowEarlyFinish', 'showQuestionNumbers', 'enterSubmits', 'autoNext', 'noPaste', 'allowRetake', 'inviteOnly'];
const TEXT_SETTINGS = [
  'completeMessage', 'screenoutMessage', 'earlyFinishMessage', 'closedMessage', 'overquotaMessage', 'timeoutMessage', 'password', 'footerText',
  'nextLabel', 'backLabel', 'submitLabel', 'earlyFinishLabel',
];
const URL_SETTINGS = ['redirectComplete', 'redirectScreenout', 'redirectEarlyFinish', 'redirectOverquota', 'logoUrl'];

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
  for (const k of ['maxResponses', 'maxStartsPerIpHour', 'minDurationSec', 'timeLimitMin']) {
    if (st[k] !== undefined && (!isInt(st[k]) || (st[k] as number) < 1)) err(w(k), 'Целое число ≥ 1');
  }
  if (st.uniqueParam !== undefined && (typeof st.uniqueParam !== 'string' || !/^[\w.-]{1,50}$/.test(st.uniqueParam))) {
    err(w('uniqueParam'), 'Имя параметра ссылки: латиница, цифры, _ . -');
  }
  if (st.accentColor !== undefined && (typeof st.accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(st.accentColor))) {
    err(w('accentColor'), 'Цвет в формате #RRGGBB');
  }
  if (st.allowRetake && st.maxResponses) warn(w('allowRetake'), 'При повторном прохождении один человек может занять несколько мест в лимите ответов');
}

const OPTION_FLAGS = [
  'other', 'exclusive', 'fixed', 'hidden', 'otherMultiline', 'otherDecimals', 'otherOptional', 'hideText', 'noExport', 'noExportOther',
  'group', 'groupHidden', 'groupExclusive', 'alwaysShow', 'noLoop', 'bottom', 'shared',
];

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
    for (const k of OPTION_FLAGS) {
      if (o[k] !== undefined && typeof o[k] !== 'boolean') err(where, `${name}[${i + 1}].${k}: true или false`);
    }
    if (o.otherType !== undefined && !['number', 'date', 'time'].includes(o.otherType as string)) err(where, `${name}[${i + 1}].otherType: number, date или time`);
    if ((o.otherType !== undefined || o.otherMultiline || o.otherOptional || o.otherDecimals) && !o.other) err(where, `${name}[${i + 1}]: настройки открытого значения без other: true`);
    if (o.script !== undefined) {
      if (typeof o.script !== 'string') err(where, `${name}[${i + 1}].script: строка с JS-кодом`);
      else try { new Function('sl', o.script); } catch (e) { err(where, `${name}[${i + 1}].script: синтаксическая ошибка — ${(e as Error).message}`); }
    }
    if (o.group && (o.other || o.exclusive)) err(where, `${name}[${i + 1}]: заголовок группы не может быть «другим» или исключающим`);
    if (o.score !== undefined && (typeof o.score !== 'number' || !isFinite(o.score))) err(where, `${name}[${i + 1}].score: число`);
    if (o.image !== undefined && (typeof o.image !== 'string' || !/^(https?:\/\/|\/)\S+$/i.test(o.image))) err(where, `${name}[${i + 1}].image: адрес картинки https://…`);
  });
  if (list.length > 0 && list.every((o) => isObj(o) && (o.hidden === true || o.group === true)) && !allowEmpty) err(where, `${name}: все варианты скрыты или это заголовки групп`);
}

function validateQuestion(
  q: Question,
  w: string,
  err: (w: string, m: string) => void,
  warn: (w: string, m: string) => void,
) {
  if (q.prefillParam !== undefined && (typeof q.prefillParam !== 'string' || !/^[\w.-]{1,50}$/.test(q.prefillParam))) {
    err(w, 'prefillParam: имя параметра ссылки (латиница, цифры, _ . -)');
  }
  if (q.prefillSkip && !q.prefillParam) warn(w, 'prefillSkip без prefillParam ничего не делает');
  if (q.prefillParam && (q.type === 'matrix' || q.type === 'ranking' || q.type === 'info' || q.type === 'hidden')) {
    warn(w, `Предзаполнение из ссылки не работает для типа ${q.type}${q.type === 'hidden' ? ' — используйте fromParam' : ''}`);
  }
  for (const k of ['requiredMessage', 'note', 'placeholder', 'suffix', 'patternMessage'] as const) {
    const v = (q as unknown as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'string') err(w, `${k}: ожидается строка`);
  }
  if ('columnCount' in q && q.columnCount !== undefined && (!isInt(q.columnCount) || q.columnCount < 1 || q.columnCount > 4)) {
    err(w, 'columnCount: от 1 до 4');
  }
  for (const k of ['search', 'collapseGroups', 'hideMarker'] as const) {
    const v = (q as unknown as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'boolean') err(w, `${k}: true или false`);
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
      if (q.display !== undefined && !['buttons', 'stars', 'smileys'].includes(q.display)) err(w, 'display: buttons, stars или smileys');
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
      if (Array.isArray(q.rows) && q.rows.some((r) => r?.group && r.groupExclusive)) err(w, 'groupExclusive в строках матрицы не действует');
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
      if (q.rows !== undefined && (!isInt(q.rows) || q.rows < 2 || q.rows > 20)) err(w, 'rows: от 2 до 20');
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
    case 'slider': {
      if (typeof q.min !== 'number' || typeof q.max !== 'number' || !isFinite(q.min) || !isFinite(q.max)) { err(w, 'min и max — числа'); break; }
      if (q.min >= q.max) err(w, 'min должно быть меньше max');
      if (q.step !== undefined && (typeof q.step !== 'number' || q.step <= 0 || q.step > q.max - q.min)) err(w, 'step: положительное число не больше диапазона');
      if (q.start !== undefined && (typeof q.start !== 'number' || q.start < q.min || q.start > q.max)) err(w, 'start: число от min до max');
      for (const k of ['minLabel', 'maxLabel', 'midLabel', 'unit'] as const) if (q[k] !== undefined && typeof q[k] !== 'string') err(w, `${k}: строка`);
      break;
    }
    case 'sum':
      validateOptions(q.options, w, 'options', err);
      if (Array.isArray(q.options) && q.options.some((o) => o?.other || o?.exclusive || o?.group)) err(w, 'В распределении суммы нет «другого», исключающих вариантов и групп');
      if (q.total !== undefined && (typeof q.total !== 'number' || q.total <= 0)) err(w, 'total: положительное число');
      if (q.mode !== undefined && q.mode !== 'exact' && q.mode !== 'max') err(w, 'mode: exact или max');
      if (q.unit !== undefined && typeof q.unit !== 'string') err(w, 'unit: строка');
      break;
    case 'file':
      if (q.accept !== undefined && q.accept !== 'image' && q.accept !== 'any') err(w, 'accept: image или any');
      if (q.maxFiles !== undefined && (!isInt(q.maxFiles) || q.maxFiles < 1 || q.maxFiles > 10)) err(w, 'maxFiles: от 1 до 10');
      if (q.maxSizeMb !== undefined && (typeof q.maxSizeMb !== 'number' || q.maxSizeMb <= 0 || q.maxSizeMb > 20)) err(w, 'maxSizeMb: до 20');
      break;
    case 'hotspot':
      if (typeof q.image !== 'string' || !/^(https?:\/\/|\/)\S+$/i.test(q.image)) err(w, 'image: адрес картинки https://… или /…');
      validateOptions(q.options, w, 'options', err);
      if (Array.isArray(q.options)) {
        q.options.forEach((o, i) => {
          const a = o?.area;
          const ok = isObj(a) && [a.x, a.y, a.w, a.h].every((n) => typeof n === 'number' && n >= 0 && n <= 100) && a.w > 0 && a.h > 0
            && a.x + a.w <= 100.01 && a.y + a.h <= 100.01;
          if (!ok) err(w, `options[${i + 1}].area: {x, y, w, h} в процентах картинки (0–100)`);
        });
      }
      if (q.minSelected !== undefined && (!isInt(q.minSelected) || q.minSelected < 1)) err(w, 'minSelected: целое ≥ 1');
      if (q.maxSelected !== undefined && (!isInt(q.maxSelected) || q.maxSelected < 1)) err(w, 'maxSelected: целое ≥ 1');
      break;
    case 'maxdiff': {
      validateOptions(q.options, w, 'options', err);
      if (Array.isArray(q.options) && q.options.some((o) => o?.other || o?.exclusive || o?.group)) err(w, 'В MaxDiff нет «другого», исключающих вариантов и групп');
      const n = Array.isArray(q.options) ? q.options.filter((o) => !o?.hidden).length : 0;
      if (n < 3) err(w, 'MaxDiff: нужно хотя бы 3 варианта');
      if (q.perSet !== undefined && (!isInt(q.perSet) || q.perSet < 2 || q.perSet > 7)) err(w, 'perSet: от 2 до 7');
      else if (isInt(q.perSet) && q.perSet > n) err(w, 'perSet больше числа вариантов');
      if (q.sets !== undefined && (!isInt(q.sets) || q.sets < 1 || q.sets > 40)) err(w, 'sets: от 1 до 40');
      else if (n >= 3 && isInt(q.sets) && q.sets * (q.perSet ?? 4) < n) warn(w, 'Наборов мало: не каждый вариант будет показан');
      for (const k of ['bestLabel', 'worstLabel'] as const) if (q[k] !== undefined && typeof q[k] !== 'string') err(w, `${k}: строка`);
      break;
    }
    case 'conjoint':
      if (!Array.isArray(q.attributes) || q.attributes.length < 2) { err(w, 'attributes: нужно хотя бы 2 атрибута'); break; }
      {
        const ids = new Set<string>();
        q.attributes.forEach((a, i) => {
          const aw = `${w} → атрибут ${isObj(a) && typeof a.id === 'string' ? a.id : i + 1}`;
          if (!isObj(a)) return err(aw, 'Ожидается {id, text, levels}');
          if (typeof a.id !== 'string' || !ID_RE.test(a.id)) err(aw, 'id: латиница, цифры и _, начинается с буквы');
          else if (ids.has(a.id.toLowerCase())) err(aw, 'id атрибута повторяется');
          else ids.add(a.id.toLowerCase());
          if (typeof a.text !== 'string' || !a.text.trim()) err(aw, 'Нужно название атрибута');
          validateOptions(a.levels, aw, 'levels', err);
          if (Array.isArray(a.levels) && a.levels.filter((l) => !l?.hidden).length < 2) err(aw, 'Нужно хотя бы 2 уровня');
          for (const k of ['header', 'fixed'] as const) if (a[k] !== undefined && typeof a[k] !== 'boolean') err(aw, `${k}: true или false`);
          if (a.fixed && Array.isArray(a.levels) && a.levels.filter((l) => !l?.hidden).length !== (q.alternatives ?? 3)) {
            err(aw, `Закреплённый атрибут: уровней должно быть столько же, сколько карточек в задании (${q.alternatives ?? 3})`);
          }
        });
        if (q.attributes.filter((a) => isObj(a) && a.header).length > 1) err(w, 'Заголовком карточки может быть только один атрибут');
        if (q.attributes.every((a) => isObj(a) && a.fixed)) err(w, 'Хотя бы один атрибут должен меняться (не закреплённый)');
      }
      if (q.tasks !== undefined && (!isInt(q.tasks) || q.tasks < 1 || q.tasks > 30)) err(w, 'tasks: от 1 до 30');
      if (q.alternatives !== undefined && (!isInt(q.alternatives) || q.alternatives < 2 || q.alternatives > 5)) err(w, 'alternatives: от 2 до 5');
      if (q.none !== undefined && (typeof q.none !== 'string' || !q.none.trim())) err(w, 'none: текст варианта «Ничего из этого»');
      break;
    case 'hidden':
      if (q.valueType !== undefined && q.valueType !== 'number' && q.valueType !== 'string') err(w, 'valueType: number или string');
      if (q.fromParam !== undefined && (typeof q.fromParam !== 'string' || !q.fromParam)) err(w, 'fromParam: имя параметра ссылки');
      break;
  }
}

const PANEL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PANEL_URL_KEYS = ['redirectComplete', 'redirectScreenout', 'redirectOverquota', 'redirectEarlyFinish'] as const;
/** Параметры ссылки, которые занимает сам опрос */
const RESERVED_LINK_PARAMS = new Set(['preview', 'new', 'rid', 'test', 'survey', 'start', 'panel', 'inv', 'inv_id']);

/** Проверка панелей проекта; возвращает список ошибок (пусто — всё в порядке) */
export function validatePanels(panels: unknown): string[] {
  if (!Array.isArray(panels)) return ['panels: ожидается массив'];
  const errors: string[] = [];
  const seen = new Set<string>();
  panels.forEach((p: Record<string, unknown>, i) => {
    const where = `Панель ${typeof p?.id === 'string' && p.id ? p.id : i + 1}`;
    if (!p || typeof p !== 'object') return errors.push(`${where}: некорректное описание`);
    if (typeof p.id !== 'string' || !PANEL_ID_RE.test(p.id)) errors.push(`${where}: код — латиница, цифры, _ и -, до 40 символов`);
    else if (seen.has(p.id.toLowerCase())) errors.push(`${where}: такой код уже есть`);
    else seen.add(p.id.toLowerCase());
    if (p.title !== undefined && typeof p.title !== 'string') errors.push(`${where}: название должно быть строкой`);
    if (p.idParam !== undefined) {
      if (typeof p.idParam !== 'string' || !/^[\w.-]{1,50}$/.test(p.idParam)) errors.push(`${where}: параметр ID — латиница, цифры, _ . -`);
      else if (RESERVED_LINK_PARAMS.has(p.idParam)) errors.push(`${where}: параметр «${p.idParam}» занят опросом`);
    }
    if (p.idMacro !== undefined && (typeof p.idMacro !== 'string' || p.idMacro.length > 100)) errors.push(`${where}: макрос ID — строка до 100 символов`);
    if (p.limit !== undefined && (!Number.isInteger(p.limit) || (p.limit as number) < 1)) errors.push(`${where}: лимит — целое число от 1`);
    for (const k of PANEL_URL_KEYS) {
      if (p[k] !== undefined && (typeof p[k] !== 'string' || !/^https?:\/\/\S+$/i.test(p[k] as string))) {
        errors.push(`${where}: редирект должен начинаться с http:// или https://`);
      }
    }
  });
  return errors;
}
