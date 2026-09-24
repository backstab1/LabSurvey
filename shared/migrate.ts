// Перевод анкет старых версий формата в текущую (formatVersion 2).
import { END, SCREENOUT, type Action, type Condition, type Survey } from './types.ts';

interface V1Page {
  id: string;
  title?: string;
  showIf?: Condition;
  questions: any[];
  jumps?: { if?: Condition; goTo: string }[];
  scripts?: { onShow?: string; onSubmit?: string };
}

/**
 * formatVersion 1 (страницы) → 2 (блоки, логика на вопросах):
 * страница → блок; условие страницы → условие каждого вопроса;
 * переходы страницы → действия «после ответа» последнего вопроса блока.
 * Возвращает вход без изменений, если он уже в формате 2 или не похож на анкету.
 */
export function migrateSurvey(input: unknown): unknown {
  const s = input as { formatVersion?: number; pages?: V1Page[]; blocks?: unknown };
  if (!s || typeof s !== 'object' || s.blocks !== undefined || !Array.isArray(s.pages)) return input;
  const { pages, ...rest } = s;
  const blocks = pages.map((p) => {
    const questions = (Array.isArray(p?.questions) ? p.questions : []).map((q) => {
      if (!p.showIf) return { ...q };
      return { ...q, showIf: q.showIf ? { all: [p.showIf, q.showIf] } : p.showIf };
    });
    const answerable = questions.filter((q) => q?.type !== 'hidden');
    const last = answerable[answerable.length - 1];
    if (last && p.jumps?.length) {
      const after: Action[] = p.jumps.map((j) => ({
        ...(j.if ? { if: j.if } : {}),
        ...(j.goTo === END ? { do: 'end' as const } : j.goTo === SCREENOUT ? { do: 'screenout' as const } : { do: 'goTo' as const, target: j.goTo }),
      }));
      last.actions = { ...last.actions, after: [...(last.actions?.after ?? []), ...after] };
    }
    const first = answerable[0];
    if (first && p.scripts?.onShow) first.scripts = { ...first.scripts, onShow: [p.scripts.onShow, first.scripts?.onShow].filter(Boolean).join('\n') };
    if (last && p.scripts?.onSubmit) last.scripts = { ...last.scripts, validate: [last.scripts?.validate, p.scripts.onSubmit].filter(Boolean).join('\n') };
    return { id: p.id, ...(p.title ? { title: p.title } : {}), questions };
  });
  return { ...rest, formatVersion: 2, blocks } as Survey;
}
