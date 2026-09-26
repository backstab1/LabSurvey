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
  const ck = (ai: number, la: number, bi: number, lb: number) => `${ai}:${la}|${bi}:${lb}`;
  const shuffle = <T>(arr: T[]) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const out: number[][][] = [];
  for (let t = 0; t < tasks; t++) {
    let task: number[][] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      const cols: number[][] = []; // [атрибут][карточка]
      attrs.forEach((a, ai) => {
        // Уровни для K карточек: реже показанные первыми, без повторов внутри задания, пока уровней хватает
        const used = new Map<number, number>();
        const chosen: number[] = [];
        for (let k = 0; k < K; k++) {
          const pick = a.levels.map((l) => ({ code: l.code, key: (used.get(l.code) ?? 0) * 1e6 + count[ai].get(l.code)! * 10 + rnd() }))
            .sort((x, y) => x.key - y.key)[0].code;
          used.set(pick, (used.get(pick) ?? 0) + 1);
          chosen.push(pick);
        }
        // Раскладка по карточкам: из нескольких случайных перестановок — та, где сочетания с прежними атрибутами встречались реже
        let best = shuffle(chosen);
        let bestScore = Infinity;
        for (let tries = 0; tries < (ai ? 12 : 1); tries++) {
          const perm = tries ? shuffle(chosen) : best;
          let score = 0;
          for (let k = 0; k < K; k++) for (let bi = 0; bi < ai; bi++) score += co.get(ck(bi, cols[bi][k], ai, perm[k])) ?? 0;
          if (score < bestScore) { bestScore = score; best = perm; }
        }
        cols.push(best);
      });
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
