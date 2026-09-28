// Дерево квот: вложенная квота считает только тех, кто подходит и под условия всех родителей.
import type { Condition, Quota } from './types.ts';

/** Квота из дерева с полным условием (свои условия + условия родителей) */
export interface FlatQuota {
  id: string;
  title?: string;
  limit: number;
  /** Полное условие: all [родители…, своё] */
  if: Condition;
  /** Уровень вложенности: 0 — верхний */
  depth: number;
  parentId?: string;
}

/** Все квоты дерева по порядку (родитель перед детьми) */
export function flatQuotas(list: Quota[] | undefined): FlatQuota[] {
  const out: FlatQuota[] = [];
  const walk = (items: Quota[], chain: Condition[], depth: number, parentId?: string) => {
    for (const q of items) {
      const conds = [...chain, q.if];
      out.push({ id: q.id, ...(q.title ? { title: q.title } : {}), limit: q.limit, if: conds.length === 1 ? q.if : { all: conds }, depth, ...(parentId ? { parentId } : {}) });
      if (q.children?.length) walk(q.children, conds, depth + 1, q.id);
    }
  };
  walk(list ?? [], [], 0);
  return out;
}

/** Сумма лимитов вложенных квот первого уровня */
export const childrenSum = (q: Quota): number => (q.children ?? []).reduce((s, c) => s + c.limit, 0);
