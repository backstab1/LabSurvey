// Файл дизайна MaxDiff / конджойнта: что именно показано каждому респонденту и что он выбрал — «длинный» формат,
// одна строка на вариант в наборе (MaxDiff) или на карточку в задании (конджойнт). Для анализа в Excel, R, SPSS, HB.
import { conjointDesign, conjointShape, maxdiffDesign } from './choiceDesign.ts';
import type { ConjointQuestion, MaxDiffQuestion } from './types.ts';
import type { ResponseRecord } from './variables.ts';

export type DesignCell = string | number;

export function designTable(q: MaxDiffQuestion | ConjointQuestion, responses: ResponseRecord[]): DesignCell[][] {
  if (q.type === 'maxdiff') {
    const text = new Map(q.options.map((o) => [o.code, o.text]));
    const rows: DesignCell[][] = [['resp_id', 'set', 'position', 'item_code', 'item', 'best', 'worst']];
    for (const r of responses) {
      const v = r.answers[q.id]?.v as Record<string, number[]> | undefined;
      if (!v || typeof v !== 'object') continue;
      maxdiffDesign(q, r.id).forEach((set, s) => {
        const pick = v[String(s + 1)];
        if (!Array.isArray(pick)) return;
        set.forEach((code, p) => rows.push([r.id, s + 1, p + 1, code, text.get(code) ?? '', pick[0] === code ? 1 : 0, pick[1] === code ? 1 : 0]));
      });
    }
    return rows;
  }
  const { attrs } = conjointShape(q);
  const levelText = attrs.map((a) => new Map(a.levels.map((l) => [l.code, l.text])));
  const rows: DesignCell[][] = [['resp_id', 'task', 'card', ...attrs.flatMap((a) => [a.id, `${a.id}_text`]), 'chosen', ...(q.none ? ['none_chosen'] : [])]];
  for (const r of responses) {
    const v = r.answers[q.id]?.v as Record<string, number> | undefined;
    if (!v || typeof v !== 'object') continue;
    conjointDesign(q, r.id).forEach((task, t) => {
      const choice = v[String(t + 1)];
      if (typeof choice !== 'number') return;
      task.forEach((card, k) => rows.push([
        r.id, t + 1, k + 1, ...card.flatMap((code, ai) => [code, levelText[ai].get(code) ?? '']), choice === k + 1 ? 1 : 0,
        ...(q.none ? [choice === 0 ? 1 : 0] : []),
      ]));
    });
  }
  return rows;
}
