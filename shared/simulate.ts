// Случайные допустимые ответы — для тестового заполнения анкеты.
import { answerRows, resolveOptions } from './logic.ts';
import { validateAnswer } from './answers.ts';
import { conjointShape, maxdiffDesign } from './choiceDesign.ts';
import type { Answer, Question, RespondentContext } from './types.ts';

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const shuffle = <T>(arr: T[]): T[] => arr.map((x) => [Math.random(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const between = (min: number, max: number) => min + Math.random() * (max - min);

function candidate(ctx: RespondentContext, q: Question): Answer | undefined {
  switch (q.type) {
    case 'single':
    case 'dropdown': {
      const o = pick(resolveOptions(ctx, q));
      return o ? { v: o.code, ...(o.other ? { o: { [o.code]: 'Тестовый вариант' } } : {}) } : undefined;
    }
    case 'multi': {
      const opts = resolveOptions(ctx, q);
      if (Math.random() < 0.1) {
        const ex = opts.find((o) => o.exclusive);
        if (ex) return { v: [ex.code] };
      }
      const regular = shuffle(opts.filter((o) => !o.exclusive));
      const min = q.minSelected ?? 1;
      const max = Math.min(q.maxSelected ?? regular.length, regular.length);
      const chosen = regular.slice(0, Math.max(min, Math.ceil(between(min - 0.01, max))));
      if (!chosen.length) return undefined;
      const o: Record<string, string> = {};
      for (const c of chosen) if (c.other) o[c.code] = 'Тестовый вариант';
      return { v: chosen.map((c) => c.code), ...(Object.keys(o).length ? { o } : {}) };
    }
    case 'ranking': {
      const opts = shuffle(resolveOptions(ctx, q));
      return { v: opts.slice(0, Math.min(q.rankCount ?? opts.length, opts.length)).map((o) => o.code) };
    }
    case 'text':
      if (q.inputType === 'email') return { v: `test${Math.floor(Math.random() * 1000)}@example.com` };
      if (q.inputType === 'time') return { v: `${String(Math.floor(between(8, 22))).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}` };
      return { v: pick(['Тестовый ответ', 'Всё понравилось', 'Нет комментариев', 'Хотелось бы дешевле']).slice(0, q.maxLength ?? 1000) };
    case 'number': {
      const dec = q.decimals ?? 0;
      const n = between(q.min ?? 1, q.max ?? Math.max((q.min ?? 1) + 99, 100));
      return { v: Number(n.toFixed(dec)) };
    }
    case 'scale': {
      const points = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
      const extra = (q.extraOptions ?? []).map((o) => o.code);
      return { v: Math.random() < 0.05 && extra.length ? pick(extra) : pick(points) };
    }
    case 'matrix': {
      const v: Record<string, number | number[]> = {};
      for (const r of answerRows(ctx, q)) {
        if (r.other) continue;
        v[r.code] = q.mode === 'multi' ? [pick(q.columns).code] : pick(q.columns).code;
      }
      return { v };
    }
    case 'date': {
      const from = q.min ? Date.parse(q.min) : Date.now() - 365 * 86400_000;
      const to = q.max ? Date.parse(q.max) : Date.now();
      return { v: new Date(between(from, Math.max(from, to))).toISOString().slice(0, 10) };
    }
    case 'phone':
      return { v: q.format === 'international' ? '+4915112345678' : `+7916${String(Math.floor(between(1000000, 9999999)))}` };
    case 'slider': {
      const step = q.step ?? 1;
      const steps = Math.floor((q.max - q.min) / step);
      return { v: Number((q.min + Math.floor(Math.random() * (steps + 1)) * step).toFixed(6)) };
    }
    case 'sum': {
      const items = q.options.filter((o) => !o.hidden);
      const total = q.total ?? 100;
      const weights = items.map(() => Math.random());
      const w = weights.reduce((a, b) => a + b, 0);
      const parts = weights.map((x) => Math.floor((x / w) * total));
      parts[0] += total - parts.reduce((a, b) => a + b, 0);
      return { v: Object.fromEntries(items.map((o, i) => [String(o.code), parts[i]])) };
    }
    case 'hotspot': {
      const items = shuffle(q.options.filter((o) => !o.hidden));
      const min = q.minSelected ?? 1;
      const max = Math.min(q.maxSelected ?? items.length, items.length);
      return { v: items.slice(0, Math.max(min, Math.ceil(between(min - 0.01, max)))).map((o) => o.code) };
    }
    case 'maxdiff': {
      const v: Record<string, number[]> = {};
      maxdiffDesign(q, ctx.seed).forEach((set, i) => {
        const s = shuffle(set);
        v[String(i + 1)] = [s[0], s[1]];
      });
      return { v };
    }
    case 'conjoint': {
      const { tasks, alternatives } = conjointShape(q);
      const v: Record<string, number> = {};
      for (let t = 1; t <= tasks; t++) v[String(t)] = q.none && Math.random() < 0.1 ? 0 : 1 + Math.floor(Math.random() * alternatives);
      return { v };
    }
    default:
      return undefined;
  }
}

/** Случайный ответ, проходящий встроенную проверку (или undefined для необязательного вопроса) */
export function randomAnswer(ctx: RespondentContext, q: Question): Answer | undefined {
  if (q.type === 'info' || q.type === 'hidden') return undefined;
  if (q.required === false && Math.random() < 0.3) return undefined;
  for (let i = 0; i < 10; i++) {
    const a = candidate(ctx, q);
    if (a && !validateAnswer(ctx, q, a)) return a;
  }
  return undefined;
}
