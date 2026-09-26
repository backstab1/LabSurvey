import { answerRows, groupOf, resolveOptions } from './logic.ts';
import { conjointDesign, conjointShape, maxdiffDesign } from './choiceDesign.ts';
import type { Answer, Option, Question, RespondentContext } from './types.ts';

/** Имя сохранённого файла: ID (12 знаков) и расширение */
export const FILE_ID_RE = /^[a-z0-9]{12}\.(jpg|png|gif|webp|heic|pdf|docx|xlsx|pptx)$/;
/** Ответ на загрузку файла — ID файлов через запятую; исходные имена — в o[ID] */
export const fileIds = (v: unknown): string[] => (typeof v === 'string' && v ? v.split(',') : []);

export function isRequired(q: Question): boolean {
  if (q.type === 'info' || q.type === 'hidden') return false;
  return q.required !== false;
}

export function isEmptyAnswer(a: Answer | undefined): boolean {
  if (!a) return true;
  const v = a.v;
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** Нормализует телефон. Возвращает +7XXXXXXXXXX / +XXXXXXXX или null */
export function normalizePhone(raw: string, format: 'ru' | 'international' = 'ru'): string | null {
  const digits = raw.replace(/\D/g, '');
  if (format === 'ru') {
    let d = digits;
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    if (d.length !== 10) return null;
    return '+7' + d;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function formatDate(s: string): string {
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

/** Проверка по шаблону анкеты; некорректный шаблон не блокирует респондента */
function safeTest(pattern: string, value: string): boolean {
  try { return new RegExp(`^(?:${pattern})$`, 'u').test(value); } catch { return true; }
}

/** Проверка открытого значения варианта: обязательность и тип (число, дата, время) */
export function otherValueError(opt: Option, raw: string | undefined): string | null {
  const t = raw?.trim() ?? '';
  if (!t) return opt.otherOptional ? null : `Укажите ваш вариант для «${opt.text}»`;
  switch (opt.otherType) {
    case 'number': {
      const n = Number(t.replace(',', '.'));
      if (!isFinite(n)) return `«${opt.text}»: введите число`;
      if (!opt.otherDecimals && !Number.isInteger(n)) return `«${opt.text}»: введите целое число`;
      return null;
    }
    case 'date':
      return isValidDate(t) ? null : `«${opt.text}»: введите корректную дату`;
    case 'time':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? null : `«${opt.text}»: введите время в формате ЧЧ:ММ`;
    default:
      return null;
  }
}

function otherError(opt: Option | undefined, a: Answer): string | null {
  if (!opt?.other) return null;
  return otherValueError(opt, a.o?.[String(opt.code)]);
}

/**
 * Проверяет ответ на видимый вопрос. Возвращает текст ошибки или null.
 * Используется и в браузере, и на сервере.
 */
export function validateAnswer(ctx: RespondentContext, q: Question, a: Answer | undefined): string | null {
  if (q.type === 'info') return null;
  if (q.type === 'hidden') {
    if (!a) return null;
    if (typeof a.v === 'string') return a.v.length <= 2000 ? null : 'Слишком длинное значение';
    return typeof a.v === 'number' && isFinite(a.v) ? null : 'Скрытая переменная: только число или строка';
  }
  const empty = isEmptyAnswer(a);
  const required = isRequired(q);

  if (q.type === 'matrix') return validateMatrix(ctx, q, a, required);

  if (empty) return required ? (q.requiredMessage || (q.type === 'slider' ? 'Передвиньте ползунок' : 'Пожалуйста, ответьте на вопрос')) : null;
  const v = a!.v;

  switch (q.type) {
    case 'single':
    case 'dropdown': {
      if (typeof v !== 'number') return 'Некорректный ответ';
      const opt = resolveOptions(ctx, q, 0, false).find((o) => o.code === v && !o.group);
      if (!opt) return 'Выберите вариант из списка';
      return otherError(opt, a!);
    }
    case 'multi': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'number')) return 'Некорректный ответ';
      if (new Set(v).size !== v.length) return 'Некорректный ответ';
      const opts = resolveOptions(ctx, q, 0, false);
      const chosen = v.map((c) => opts.find((o) => o.code === c && !o.group));
      if (chosen.some((o) => !o)) return 'Выберите варианты из списка';
      if (v.length > 1 && chosen.some((o) => o!.exclusive)) {
        return `Вариант «${chosen.find((o) => o!.exclusive)!.text}» нельзя сочетать с другими`;
      }
      for (const o of chosen) {
        if (!o!.groupExclusive) continue;
        const group = groupOf(opts, o!.code);
        if (v.some((c) => c !== o!.code && group.includes(c))) return `Вариант «${o!.text}» нельзя сочетать с другими вариантами группы`;
      }
      const onlyExclusive = chosen.length === 1 && chosen[0]!.exclusive;
      if (!onlyExclusive) {
        if (q.minSelected && v.length < q.minSelected) return `Выберите не менее ${q.minSelected} вариантов`;
        if (q.maxSelected && v.length > q.maxSelected) return `Выберите не более ${q.maxSelected} вариантов`;
      }
      for (const o of chosen) {
        const e = otherError(o, a!);
        if (e) return e;
      }
      return null;
    }
    case 'ranking': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'number') || new Set(v).size !== v.length) return 'Некорректный ответ';
      const opts = resolveOptions(ctx, q, 0, false);
      if (v.some((c) => !opts.some((o) => o.code === c))) return 'Выберите варианты из списка';
      const need = Math.min(q.rankCount ?? opts.length, opts.length);
      if (v.length !== need) return need === opts.length ? 'Расставьте все варианты по порядку' : `Выберите ${need} первых мест`;
      return null;
    }
    case 'text': {
      if (typeof v !== 'string') return 'Некорректный ответ';
      if (required && !v.trim()) return q.requiredMessage || 'Пожалуйста, ответьте на вопрос';
      if (q.inputType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return 'Введите корректный e-mail';
      if (q.inputType === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) return 'Введите время в формате ЧЧ:ММ';
      if (q.maxLength && v.length > q.maxLength) return `Не более ${q.maxLength} символов`;
      if (q.minLength && v.trim().length < q.minLength) return `Не менее ${q.minLength} символов`;
      if (q.pattern && (q.inputType ?? 'text') === 'text' && !safeTest(q.pattern, v.trim())) return q.patternMessage || 'Ответ в неверном формате';
      return null;
    }
    case 'number': {
      if (typeof v !== 'number' || !isFinite(v)) return 'Введите число';
      const dec = q.decimals ?? 0;
      const factor = 10 ** dec;
      if (Math.abs(Math.round(v * factor) - v * factor) > 1e-6) {
        return dec === 0 ? 'Введите целое число' : `Не более ${dec} знаков после запятой`;
      }
      if (q.min !== undefined && v < q.min) return `Значение не может быть меньше ${q.min}`;
      if (q.max !== undefined && v > q.max) return `Значение не может быть больше ${q.max}`;
      return null;
    }
    case 'scale': {
      if (typeof v !== 'number') return 'Некорректный ответ';
      const inScale = Number.isInteger(v) && v >= q.from && v <= q.to;
      const extra = q.extraOptions?.some((o) => o.code === v);
      return inScale || extra ? null : 'Выберите значение на шкале';
    }
    case 'date': {
      if (typeof v !== 'string' || !isValidDate(v)) return 'Введите корректную дату';
      if (q.min && v < q.min) return `Дата не может быть раньше ${formatDate(q.min)}`;
      if (q.max && v > q.max) return `Дата не может быть позже ${formatDate(q.max)}`;
      return null;
    }
    case 'phone': {
      if (typeof v !== 'string') return 'Некорректный ответ';
      if (!normalizePhone(v, q.format)) {
        return q.format === 'international'
          ? 'Введите номер в международном формате: + и 8–15 цифр'
          : 'Введите номер в формате +7 XXX XXX-XX-XX';
      }
      return null;
    }
    case 'slider': {
      if (typeof v !== 'number' || !isFinite(v)) return 'Передвиньте ползунок';
      if (v < q.min || v > q.max) return 'Значение вне шкалы';
      const step = q.step ?? 1;
      const k = (v - q.min) / step;
      if (Math.abs(k - Math.round(k)) > 1e-6) return 'Значение вне шкалы';
      return null;
    }
    case 'sum': {
      if (typeof v !== 'object' || Array.isArray(v) || v === null) return 'Некорректный ответ';
      const codes = new Set(q.options.filter((o) => !o.hidden).map((o) => String(o.code)));
      let total = 0;
      for (const [k, x] of Object.entries(v)) {
        if (!codes.has(k) || typeof x !== 'number' || !isFinite(x) || x < 0) return 'Введите неотрицательные числа';
        total += x;
      }
      const need = q.total ?? 100;
      const unit = q.unit ?? '%';
      const fmt = (n: number) => `${Math.round(n * 100) / 100}${unit === '%' ? '%' : ` ${unit}`}`;
      if ((q.mode ?? 'exact') === 'exact' && Math.abs(total - need) > 1e-6) return `Сумма должна быть ${fmt(need)}, сейчас ${fmt(total)}`;
      if (q.mode === 'max' && total > need + 1e-6) return `Сумма не может быть больше ${fmt(need)}, сейчас ${fmt(total)}`;
      return null;
    }
    case 'file': {
      const ids = fileIds(v);
      if (typeof v !== 'string' || !ids.length || ids.some((id) => !FILE_ID_RE.test(id)) || new Set(ids).size !== ids.length) return 'Некорректный ответ';
      if (ids.length > (q.maxFiles ?? 1)) return `Не больше ${q.maxFiles ?? 1} файлов`;
      return null;
    }
    case 'hotspot': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'number') || new Set(v).size !== v.length) return 'Некорректный ответ';
      const codes = new Set(q.options.filter((o) => !o.hidden).map((o) => o.code));
      if (v.some((c) => !codes.has(c))) return 'Некорректный ответ';
      if (q.minSelected && v.length < q.minSelected) return `Отметьте не меньше ${q.minSelected} мест на картинке`;
      if (q.maxSelected && v.length > q.maxSelected) return `Отметьте не больше ${q.maxSelected} мест на картинке`;
      return null;
    }
    case 'maxdiff': {
      if (typeof v !== 'object' || Array.isArray(v) || v === null) return 'Некорректный ответ';
      const design = maxdiffDesign(q, ctx.seed);
      const answers = v as Record<string, unknown>;
      if (Object.keys(answers).some((k) => !(Number(k) >= 1 && Number(k) <= design.length))) return 'Некорректный ответ';
      for (let i = 0; i < design.length; i++) {
        const pick = answers[String(i + 1)];
        if (pick === undefined) return design.length > 1 ? `Ответьте во всех наборах (набор ${i + 1} из ${design.length})` : 'Выберите ответы';
        if (!Array.isArray(pick) || pick.length !== 2 || !pick.every((c) => design[i].includes(c as number))) return 'Некорректный ответ';
        if (pick[0] === pick[1]) return `Набор ${i + 1}: один и тот же вариант не может быть и самым, и наименее важным`;
      }
      return null;
    }
    case 'conjoint': {
      if (typeof v !== 'object' || Array.isArray(v) || v === null) return 'Некорректный ответ';
      const { tasks, alternatives } = conjointShape(q);
      const answers = v as Record<string, unknown>;
      if (Object.keys(answers).some((k) => !(Number(k) >= 1 && Number(k) <= tasks))) return 'Некорректный ответ';
      for (let t = 1; t <= tasks; t++) {
        const c = answers[String(t)];
        if (c === undefined) return tasks > 1 ? `Сделайте выбор во всех заданиях (задание ${t} из ${tasks})` : 'Сделайте выбор';
        if (!Number.isInteger(c) || (c as number) < (q.none ? 0 : 1) || (c as number) > alternatives) return 'Некорректный ответ';
      }
      // Дизайн строится по ID ответа — проверка, что он доступен (вопрос не сломан)
      if (!conjointDesign(q, ctx.seed).length) return 'Некорректный вопрос';
      return null;
    }
  }
  return null;
}

function validateMatrix(
  ctx: RespondentContext,
  q: Extract<Question, { type: 'matrix' }>,
  a: Answer | undefined,
  required: boolean,
): string | null {
  const rows = answerRows(ctx, q);
  const v = (a?.v ?? {}) as Record<string, number | number[]>;
  if (typeof v !== 'object' || Array.isArray(v)) return 'Некорректный ответ';
  const colCodes = new Set(q.columns.map((c) => c.code));
  let answeredRows = 0;
  const missing: string[] = [];

  for (const key of Object.keys(v)) {
    if (!rows.some((r) => String(r.code) === key)) return 'Некорректный ответ';
  }
  // Общий для всей таблицы столбец: отмечен сразу во всех строках и ни с чем не сочетается
  for (const col of q.columns.filter((c) => c.shared)) {
    const has = (rv: number | number[] | undefined) => (Array.isArray(rv) ? rv.includes(col.code) : rv === col.code);
    const marked = rows.filter((r) => has(v[String(r.code)]));
    if (!marked.length) continue;
    const plain = rows.filter((r) => !r.other);
    const alone = (rv: number | number[] | undefined) => (Array.isArray(rv) ? rv.length === 1 : true);
    if (plain.some((r) => !has(v[String(r.code)]) || !alone(v[String(r.code)]))) return `Вариант «${col.text}» относится ко всей таблице`;
  }

  for (const row of rows) {
    const key = String(row.code);
    const rv = v[key];
    const has = rv !== undefined && (!Array.isArray(rv) || rv.length > 0);
    if (has) {
      const vals = Array.isArray(rv) ? rv : [rv];
      if (q.mode === 'single' && Array.isArray(rv)) return 'Некорректный ответ';
      if (vals.some((c) => !colCodes.has(c))) return 'Некорректный ответ';
    }
    const otherText = a?.o?.[key]?.trim();
    if (row.other) {
      // Строка «Другое» необязательна, но текст и оценка должны идти вместе
      if (has && !otherText) return `Укажите ваш вариант в строке «${row.text}»`;
      if (!has && otherText) return `Дайте ответ в строке «${otherText}»`;
      if (has) answeredRows++;
      continue;
    }
    if (has) answeredRows++;
    else missing.push(row.text);
  }

  const mode = required ? (q.requiredRows ?? 'all') : 'none';
  if (mode === 'all' && missing.length > 0) {
    return missing.length === 1
      ? `Дайте ответ в строке «${missing[0]}»`
      : `Дайте ответ во всех строках (осталось: ${missing.length})`;
  }
  if (typeof mode === 'number' && answeredRows < mode) {
    return `Заполните не менее ${mode} строк`;
  }
  return null;
}

/** Приводит ответ к каноническому виду перед сохранением (телефон, пустые «Другое») */
export function normalizeAnswer(q: Question, a: Answer): Answer {
  const out: Answer = { v: a.v };
  if (q.type === 'phone' && typeof a.v === 'string') out.v = normalizePhone(a.v, q.format) ?? a.v;
  if (q.type === 'text' && typeof a.v === 'string') out.v = a.v.trim();
  // Распределение суммы: пустые поля — не ответ
  if (q.type === 'sum' && a.v && typeof a.v === 'object' && !Array.isArray(a.v)) {
    out.v = Object.fromEntries(Object.entries(a.v).filter(([, x]) => typeof x === 'number' && isFinite(x)));
  }
  // Файлы: имена храним только для приложенных
  if (q.type === 'file') {
    const ids = new Set(fileIds(a.v));
    const o = Object.fromEntries(Object.entries(a.o ?? {}).filter(([k, t]) => ids.has(k) && typeof t === 'string').map(([k, t]) => [k, t.slice(0, 200)]));
    return Object.keys(o).length ? { ...out, o } : out;
  }
  if (a.o) {
    const selected = new Set<string>();
    if (typeof a.v === 'number') selected.add(String(a.v));
    else if (Array.isArray(a.v)) a.v.forEach((c) => selected.add(String(c)));
    else if (typeof a.v === 'object' && a.v) Object.keys(a.v).forEach((k) => selected.add(k));
    const o: Record<string, string> = {};
    for (const [k, t] of Object.entries(a.o)) if (selected.has(k) && t.trim()) o[k] = t.trim();
    if (Object.keys(o).length) out.o = o;
  }
  return out;
}
