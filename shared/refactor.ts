// Переименование ID вопроса или блока с обновлением всех ссылок на него.
import type { Survey } from './types.ts';

/** Поля, в которых хранится ID вопроса или блока */
const REF_KEYS = new Set(['q', 'question', 'target', 'goTo']);
/** Поля с текстом, где могут быть подстановки {{ID}} */
const TEXT_KEYS = new Set([
  'text', 'hint', 'title', 'value', 'message', 'completeMessage', 'screenoutMessage', 'earlyFinishMessage', 'overquotaMessage',
  'redirectComplete', 'redirectScreenout', 'redirectEarlyFinish', 'redirectOverquota',
]);
/** Поля со скриптами: там ID встречается в кавычках — sl.get('Q1') */
const SCRIPT_KEYS = new Set(['init', 'onShow', 'onChange', 'validate']);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function renameId(survey: Survey, oldId: string, newId: string): Survey {
  if (!oldId || oldId === newId) return survey;
  const piping = new RegExp(`\\{\\{\\s*${esc(oldId)}(\\.\\w+)?\\s*\\}\\}`, 'g');
  const quoted = new RegExp(`(['"\`])${esc(oldId)}\\1`, 'g');

  const walk = (node: unknown, key?: string): unknown => {
    if (Array.isArray(node)) return node.map((x) => walk(x));
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k);
      // Сам вопрос или блок с этим ID
      if (out.id === oldId && ('type' in out || 'questions' in out)) out.id = newId;
      return out;
    }
    if (typeof node === 'string' && key) {
      if (REF_KEYS.has(key) && node === oldId) return newId;
      if (TEXT_KEYS.has(key)) return node.replace(piping, (_m, sub = '') => `{{${newId}${sub}}}`);
      if (SCRIPT_KEYS.has(key)) return node.replace(quoted, (_m, qch) => `${qch}${newId}${qch}`);
    }
    return node;
  };
  return walk(survey) as Survey;
}

/** Все ID анкеты (вопросы и блоки) — одно пространство имён */
export function allIds(survey: Survey): string[] {
  return [...survey.blocks.map((b) => b.id), ...survey.blocks.flatMap((b) => b.questions.map((q) => q.id))];
}

/** Свободный ID с префиксом: Q12, H3, B4 */
export function nextId(existing: string[], prefix: string): string {
  const taken = new Set(existing.map((x) => x.toLowerCase()));
  let max = 0;
  for (const id of existing) {
    const m = id.match(new RegExp(`^${esc(prefix)}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}
