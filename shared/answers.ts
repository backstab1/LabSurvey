import { resolveOptions, resolveRows } from './logic.ts';
import type { Answer, Option, Question, RespondentContext } from './types.ts';

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

function otherError(opt: Option | undefined, a: Answer): string | null {
  if (opt?.other && !a.o?.[String(opt.code)]?.trim()) return `Укажите ваш вариант для «${opt.text}»`;
  return null;
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

  if (empty) return required ? 'Пожалуйста, ответьте на вопрос' : null;
  const v = a!.v;

  switch (q.type) {
    case 'single':
    case 'dropdown': {
      if (typeof v !== 'number') return 'Некорректный ответ';
      const opt = resolveOptions(ctx, q, 0, false).find((o) => o.code === v);
      if (!opt) return 'Выберите вариант из списка';
      return otherError(opt, a!);
    }
    case 'multi': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'number')) return 'Некорректный ответ';
      if (new Set(v).size !== v.length) return 'Некорректный ответ';
      const opts = resolveOptions(ctx, q, 0, false);
      const chosen = v.map((c) => opts.find((o) => o.code === c));
      if (chosen.some((o) => !o)) return 'Выберите варианты из списка';
      if (v.length > 1 && chosen.some((o) => o!.exclusive)) {
        return `Вариант «${chosen.find((o) => o!.exclusive)!.text}» нельзя сочетать с другими`;
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
      if (required && !v.trim()) return 'Пожалуйста, ответьте на вопрос';
      if (q.inputType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return 'Введите корректный e-mail';
      if (q.inputType === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) return 'Введите время в формате ЧЧ:ММ';
      if (q.maxLength && v.length > q.maxLength) return `Не более ${q.maxLength} символов`;
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
  }
  return null;
}

function validateMatrix(
  ctx: RespondentContext,
  q: Extract<Question, { type: 'matrix' }>,
  a: Answer | undefined,
  required: boolean,
): string | null {
  const rows = resolveRows(ctx, q);
  const v = (a?.v ?? {}) as Record<string, number | number[]>;
  if (typeof v !== 'object' || Array.isArray(v)) return 'Некорректный ответ';
  const colCodes = new Set(q.columns.map((c) => c.code));
  let answeredRows = 0;
  const missing: string[] = [];

  for (const key of Object.keys(v)) {
    if (!rows.some((r) => String(r.code) === key)) return 'Некорректный ответ';
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
