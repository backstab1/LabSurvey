// MaxDiff и конджойнт: дизайн заданий для респондента. Анализ делается вне SurveyLAB — по выгрузке ответов и дизайна.
// Дизайн строится детерминированно от ID ответа и описания вопроса — сервер и браузер получают одинаковые наборы,
// выгрузка восстанавливает показанное. Поэтому списки вариантов и уровней нельзя менять после начала сбора.
import { hash } from './logic.ts';
import type { ConjointQuestion, MaxDiffQuestion, Option } from './types.ts';

/** Детерминированный генератор случайных чисел (xorshift32) */
function rng(seed: string): () => number {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const shown = (opts: Option[]) => opts.filter((o) => !o.hidden && !o.group);

/** Все перестановки для коротких наборов (до 5), для длинных — 120 случайных */
function permutations(items: number[], rnd: () => number): number[][] {
  if (items.length <= 5) {
    const out: number[][] = [];
    const go = (rest: number[], acc: number[]) => {
      if (!rest.length) { out.push(acc); return; }
      rest.forEach((x, i) => go([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    go(items, []);
    return out;
  }
  return Array.from({ length: 120 }, () => {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  });
}

export function maxdiffShape(q: MaxDiffQuestion) {
  const items = shown(q.options);
  const perSet = Math.max(2, Math.min(q.perSet ?? 4, items.length));
  const sets = Math.max(1, q.sets ?? Math.ceil((3 * items.length) / perSet));
  return { items, perSet, sets };
}

/**
 * Наборы MaxDiff (сбалансированный дизайн на каждого респондента):
 * - частота: каждый вариант показывается одинаковое число раз (±1);
 * - пары: варианты по возможности не встречаются вместе повторно — все варианты связаны сравнениями между собой;
 * - соседние наборы: вариант по возможности не идёт в двух наборах подряд (если это не мешает парам);
 * - позиции: каждый вариант по возможности бывает на разных местах в наборе.
 * Возвращает коды вариантов по наборам (в порядке показа).
 */
export function maxdiffDesign(q: MaxDiffQuestion, seed: string): number[][] {
  const { items, perSet, sets } = maxdiffShape(q);
  const rnd = rng(`${seed}:maxdiff:${q.id}`);
  const count = new Map(items.map((o) => [o.code, 0]));
  const pos = new Map(items.map((o) => [o.code, new Array<number>(perSet).fill(0)]));
  const pair = new Map<string, number>();
  const pk = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
  const out: number[][] = [];
  for (let s = 0; s < sets; s++) {
    const prev = new Set(out[s - 1] ?? []);
    const set: number[] = [];
    while (set.length < perSet) {
      const candidates = items.filter((o) => !set.includes(o.code)).map((o) => ({
        code: o.code,
        // Приоритет: поровну показов → разнообразие пар (иначе варианты распадаются на несравнимые группы) → без соседних повторов
        key: count.get(o.code)! * 1e6 + set.reduce((a, c) => a + (pair.get(pk(c, o.code)) ?? 0), 0) * 1e3
          + (prev.has(o.code) ? 10 : 0) + rnd(),
      }));
      candidates.sort((a, b) => a.key - b.key);
      set.push(candidates[0].code);
    }
    for (const c of set) count.set(c, count.get(c)! + 1);
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) pair.set(pk(set[i], set[j]), (pair.get(pk(set[i], set[j])) ?? 0) + 1);
    // Порядок: перестановка, при которой варианты реже всего повторяют прежние места (до 5 — перебор всех)
    let ordered = set;
    let bestScore = Infinity;
    for (const perm of permutations(set, rnd)) {
      const score = perm.reduce((a, c, p) => a + pos.get(c)![p] ** 2, 0) + rnd() * 0.5;
      if (score < bestScore) { bestScore = score; ordered = perm; }
    }
    ordered.forEach((c, p) => pos.get(c)![p]++);
    out.push(ordered);
  }
  return out;
}

export function conjointShape(q: ConjointQuestion) {
  const attrs = q.attributes.map((a) => ({ ...a, levels: shown(a.levels) })).filter((a) => a.levels.length);
  return { attrs, tasks: Math.max(1, q.tasks ?? 8), alternatives: Math.max(2, q.alternatives ?? 3) };
}

/**
 * Задания конджойнта (сбалансированный случайный дизайн на каждого респондента):
 * - баланс уровней: каждый уровень атрибута показывается одинаковое число раз (±1);
 * - минимальное пересечение: в одном задании уровни атрибута не повторяются, пока уровней хватает на все карточки;
 * - ортогональность: сочетания уровней разных атрибутов подбираются так, чтобы встречаться поровну;
 * - карточки внутри задания не совпадают.
 * Результат: [задание][карточка][атрибут] = код уровня.
 */
export function conjointDesign(q: ConjointQuestion, seed: string): number[][][] {
  const { attrs, tasks, alternatives: K } = conjointShape(q);
  const rnd = rng(`${seed}:conjoint:${q.id}`);
  const count = attrs.map((a) => new Map(a.levels.map((l) => [l.code, 0])));
  const co = new Map<string, number>();
  // Сочетание уровней двух атрибутов (ключ не зависит от порядка атрибутов)
  const ck = (ai: number, la: number, bi: number, lb: number) => (ai < bi ? `${ai}:${la}|${bi}:${lb}` : `${bi}:${lb}|${ai}:${la}`);
  // Сначала закреплённые и заголовок — остальные атрибуты балансируются относительно них (цена внутри каждого сервиса)
  const rank = (i: number) => (attrs[i].fixed ? 0 : attrs[i].header ? 1 : 2);
  const order = attrs.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || a - b);
  const out: number[][][] = [];
  for (let t = 0; t < tasks; t++) {
    let task: number[][] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      const cols: number[][] = []; // [атрибут][карточка]
      const placed: number[] = [];
      for (const ai of order) {
        const a = attrs[ai];
        if (a.fixed) {
          // Карточка k — уровень k
          cols[ai] = a.levels.slice(0, K).map((l) => l.code);
          placed.push(ai);
          continue;
        }
        // Уровни для K карточек: реже показанные первыми, без повторов внутри задания, пока уровней хватает
        const used = new Map<number, number>();
        const chosen: number[] = [];
        for (let k = 0; k < K; k++) {
          const pick = a.levels.map((l) => ({ code: l.code, key: (used.get(l.code) ?? 0) * 1e6 + count[ai].get(l.code)! * 10 + rnd() }))
            .sort((x, y) => x.key - y.key)[0].code;
          used.set(pick, (used.get(pick) ?? 0) + 1);
          chosen.push(pick);
        }
        // Раскладка по карточкам: перебор всех перестановок — та, где сочетания с уже разложенными атрибутами встречались реже
        let best = chosen;
        let bestScore = Infinity;
        for (const perm of permutations(chosen, rnd)) {
          let score = rnd() * 0.5;
          for (let k = 0; k < K; k++) for (const bi of placed) score += co.get(ck(bi, cols[bi][k], ai, perm[k])) ?? 0;
          if (score < bestScore) { bestScore = score; best = perm; }
        }
        cols[ai] = best;
        placed.push(ai);
      }
      task = Array.from({ length: K }, (_, k) => attrs.map((_, ai) => cols[ai][k]));
      const cards = new Set(task.map((c) => c.join('.')));
      if (cards.size === K) break;
    }
    task.forEach((card) => {
      card.forEach((code, ai) => {
        count[ai].set(code, count[ai].get(code)! + 1);
        for (let bi = 0; bi < ai; bi++) co.set(ck(bi, card[bi], ai, code), (co.get(ck(bi, card[bi], ai, code)) ?? 0) + 1);
      });
    });
    out.push(task);
  }
  return out;
}

export interface DesignCheck {
  respondents: number;
  /** Доля показов каждого уровня (в % от всех карточек) и отклонение от равной доли */
  levels: { attr: string; text: string; levels: { text: string; share: number }[]; maxDeviation: number }[];
  /** Сочетания уровней пар атрибутов: сколько раз встретились, разброс в % от ожидаемого */
  pairs: { a: string; b: string; rows: string[]; cols: string[]; counts: number[][]; spread: number }[];
  /** Доля заданий, где уровень атрибута повторился на разных карточках (при достаточном числе уровней должно быть 0) */
  overlap: { attr: string; share: number }[];
  /** Одинаковые карточки в одном задании */
  duplicates: number;
}

/**
 * Проверка дизайна: генерирует задания для n условных респондентов и считает частоты уровней, сочетания пар атрибутов
 * и пересечения внутри заданий. Нужна, чтобы увидеть баланс до запуска.
 */
export function conjointDesignCheck(q: ConjointQuestion, n = 500): DesignCheck {
  const { attrs, alternatives: K } = conjointShape(q);
  const lv = attrs.map((a) => new Map(a.levels.map((l) => [l.code, 0])));
  const pairKeys: [number, number][] = [];
  for (let i = 0; i < attrs.length; i++) for (let j = i + 1; j < attrs.length; j++) pairKeys.push([i, j]);
  const pc = pairKeys.map(([i, j]) => attrs[i].levels.map(() => attrs[j].levels.map(() => 0)));
  const overlap = attrs.map(() => 0);
  let tasksTotal = 0;
  let cards = 0;
  let duplicates = 0;
  for (let r = 0; r < n; r++) {
    for (const task of conjointDesign(q, `check-${r}`)) {
      tasksTotal++;
      if (new Set(task.map((c) => c.join('.'))).size < task.length) duplicates++;
      attrs.forEach((a, ai) => {
        if (new Set(task.map((c) => c[ai])).size < Math.min(K, a.levels.length)) overlap[ai]++;
      });
      for (const card of task) {
        cards++;
        card.forEach((code, ai) => lv[ai].set(code, lv[ai].get(code)! + 1));
        pairKeys.forEach(([i, j], p) => {
          const x = attrs[i].levels.findIndex((l) => l.code === card[i]);
          const y = attrs[j].levels.findIndex((l) => l.code === card[j]);
          pc[p][x][y]++;
        });
      }
    }
  }
  const pct = (x: number, total: number) => Math.round((x / total) * 1000) / 10;
  return {
    respondents: n,
    levels: attrs.map((a, ai) => {
      const shares = a.levels.map((l) => pct(lv[ai].get(l.code)!, cards));
      const even = 100 / a.levels.length;
      return { attr: a.text, text: a.id, levels: a.levels.map((l, i) => ({ text: l.text, share: shares[i] })), maxDeviation: Math.round(Math.max(...shares.map((s) => Math.abs(s - even))) * 10) / 10 };
    }),
    pairs: pairKeys.map(([i, j], p) => {
      const flat = pc[p].flat();
      const expected = cards / (attrs[i].levels.length * attrs[j].levels.length);
      const spread = Math.round(((Math.max(...flat) - Math.min(...flat)) / expected) * 1000) / 10;
      return { a: attrs[i].text, b: attrs[j].text, rows: attrs[i].levels.map((l) => l.text), cols: attrs[j].levels.map((l) => l.text), counts: pc[p], spread };
    }),
    overlap: attrs.map((a, ai) => ({ attr: a.text, share: pct(overlap[ai], tasksTotal) })),
    duplicates,
  };
}
