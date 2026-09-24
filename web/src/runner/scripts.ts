// Выполнение пользовательских скриптов анкеты в браузере респондента.
// Скрипт — тело функции `function (sl) { ... }`. Объект sl описан в docs/survey-format.md.
import { findQuestion, answerText } from '../../../shared/logic.ts';
import type { AnswerValue, Answers, RespondentContext } from '../../../shared/types.ts';

export interface ScriptEnv {
  ctx: RespondentContext;
  pageId: string;
  preview: boolean;
  setValue: (id: string, v: AnswerValue | undefined) => void;
}

/** Общий объект между скриптами в рамках сессии — сюда init кладёт функции */
const shared: Record<string, unknown> = {};

export function makeSl(env: ScriptEnv, extra: { question?: string; value?: unknown } = {}) {
  const { ctx } = env;
  return {
    /** ID текущего вопроса (для хуков вопроса) */
    question: extra.question ?? null,
    /** Текущее значение ответа (для onChange / validate) */
    value: extra.value,
    page: env.pageId,
    params: { ...ctx.params },
    respondentId: ctx.seed,
    preview: env.preview,
    shared,
    /** Значение ответа: код, массив кодов, строка, число или объект матрицы */
    get: (id: string) => ctx.answers[id]?.v,
    /** Текст ответа (подписи вариантов) — как в подстановке {{ID}} */
    text: (id: string) => {
      const q = findQuestion(ctx.survey, id);
      return q ? answerText(ctx, q) : '';
    },
    /** Установить значение: для скрытых переменных — любое число/строка; для вопросов текущей страницы — ответ */
    set: (id: string, v: AnswerValue | undefined) => env.setValue(id, v),
    answers: structuredClone(ctx.answers) as Answers,
    /** DOM-элемент вопроса (для onShow/onChange) */
    el: extra.question ? document.getElementById(`q-${extra.question}`) : document.querySelector('.runner-card'),
  };
}

/** Выполняет скрипт; ошибки не ломают опрос (в предпросмотре — показываются) */
export function runScript(code: string | undefined, where: string, env: ScriptEnv, extra: { question?: string; value?: unknown } = {}): unknown {
  if (!code?.trim()) return undefined;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('sl', code)(makeSl(env, extra));
  } catch (e) {
    console.error(`[SurveyLAB] Ошибка в скрипте ${where}:`, e);
    if (env.preview) window.alert(`Ошибка в скрипте ${where}: ${(e as Error).message}`);
    return undefined;
  }
}
