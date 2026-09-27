// Сессия прохождения опроса: состояние для браузера, проверка страницы, качество ответов, завершение.
// Сервер — источник истины: он проверяет ответы и решает, куда идти дальше.
import { currentUser } from './auth.ts';
import { config } from './config.ts';
import { responses, surveys, type StoredResponse, type SurveyRow } from './db.ts';
import { loadProject, type Loaded } from './projectCtx.ts';
import { queueResponseSync } from './sheets.ts';
import { noteCompleted } from './quotas.ts';
import { afterComplete } from './notify.ts';
import {
  actionError, allQuestions, answerRows, cleanAnswers, evalCondition, findPage, firstPage, isQuestionVisible, pipe, pipeUrl, progressPercent,
} from '../shared/logic.ts';
import { isEmptyAnswer, normalizeAnswer, validateAnswer } from '../shared/answers.ts';
import { expandAllLoops, withLoops } from '../shared/loops.ts';
import { PANEL_PARAM, RESERVED_PARAMS as RESERVED, settingsOf, type Answer, type Panel, type Answers, type RespondentContext, type Survey } from '../shared/types.ts';
import type { ResponseStatus } from '../shared/variables.ts';
import type { RunnerState } from '../shared/api.ts';
export type { RunnerState };

/** Команда (не заказчик) может открыть предпросмотр черновика */
export const isTeam = async (req: Parameters<typeof currentUser>[0]) => {
  const u = await currentUser(req);
  return !!u && u.role !== 'client';
};

const RESERVED_PARAMS = new Set(RESERVED);

export function cleanParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 30)) {
    if (RESERVED_PARAMS.has(k) || !/^[\w.-]{1,50}$/.test(k)) continue;
    out[k] = String(v ?? '').slice(0, 300);
  }
  return out;
}

/**
 * Куда ведёт ссылка /s/ID: проект (обычная ссылка респондента) или анкета — только для предпросмотра из конструктора.
 */
export interface Target {
  projectId: string | null;
  surveyRow: SurveyRow;
  loaded: Loaded | null;
}

export async function resolveTarget(id: string, surveyOnly = false): Promise<Target | null> {
  const loaded = surveyOnly ? null : await loadProject(id);
  if (loaded) return { projectId: id, surveyRow: loaded.survey, loaded };
  const s = await surveys.get(id);
  return s ? { projectId: null, surveyRow: s, loaded: null } : null;
}

export function definitionFor(t: Target, isTest: boolean): Survey | null {
  if (t.loaded) return isTest ? t.loaded.draft : t.loaded.live;
  return isTest ? t.surveyRow.draft : null;
}

/** Ключ для квот и очередей: проект или (для предпросмотра без проекта) анкета */
export const ownerOf = (r: { projectId: string | null; surveyId: string }) => r.projectId ?? `survey:${r.surveyId}`;

/** Контекст респондента; циклы развёрнуты по его ответам */
export const ctxOf = (survey: Survey, r: StoredResponse, answers: Answers): RespondentContext =>
  withLoops({ survey, answers, params: r.params, seed: r.id });

/** Анкета для браузера респондента — без пароля */
export function publicSurvey(survey: Survey): Survey {
  if (!survey.settings?.password) return survey;
  const { password: _, ...settings } = survey.settings;
  return { ...survey, settings };
}

/** Панель, с которой пришёл респондент (по параметру ?panel=) */
export const panelOf = (panels: Panel[], params: Record<string, string>): Panel | undefined =>
  params[PANEL_PARAM] ? panels.find((p) => p.id === params[PANEL_PARAM]) : undefined;

const PANEL_REDIRECT = {
  completed: 'redirectComplete', screened_out: 'redirectScreenout', overquota: 'redirectOverquota', terminated: 'redirectEarlyFinish',
} as const;

function finished(survey: Survey, r: StoredResponse, panels: Panel[]): { message: string; redirect?: string } {
  const st = settingsOf(survey);
  let [message, redirect] = r.status === 'screened_out' ? [st.screenoutMessage, st.redirectScreenout]
    : r.status === 'terminated' ? [st.earlyFinishMessage, st.redirectEarlyFinish]
      : r.status === 'overquota' ? [st.overquotaMessage, st.redirectOverquota]
      : [st.completeMessage, st.redirectComplete];
  // Своё сообщение и адрес у сработавшего действия важнее общих
  if (r.ending?.message) message = r.ending.message;
  if (r.ending?.redirect) redirect = r.ending.redirect;
  // Редирект панели важнее всего: подрядчик считает статусы по возвратам
  const panelRedirect = r.status !== 'in_progress' ? panelOf(panels, r.params)?.[PANEL_REDIRECT[r.status]] : undefined;
  if (panelRedirect) redirect = panelRedirect;
  const ctx = ctxOf(survey, r, r.answers);
  return { message: pipe(message, ctx), redirect: redirect ? pipeUrl(redirect, ctx, r.id) : undefined };
}

/** Почему новый респондент не может начать опрос (null — может) */
export async function closedReason(projectId: string, survey: Survey): Promise<string | null> {
  const st = settingsOf(survey);
  const now = Date.now();
  if (st.openFrom && now < Date.parse(st.openFrom)) {
    const when = new Date(st.openFrom).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: config.timezone });
    return `Опрос начнётся ${when}.`;
  }
  if (st.closeAt && now >= Date.parse(st.closeAt)) return st.closedMessage;
  if (st.maxResponses) {
    const done = (await responses.counts(projectId)).real.completed ?? 0;
    if (done >= st.maxResponses) return st.closedMessage;
  }
  return null;
}

export function stateOf(survey: Survey, r: StoredResponse, panels: Panel[] = []): RunnerState {
  const st = settingsOf(survey);
  const base = {
    rid: r.id, status: r.status, preview: r.isTest, survey: publicSurvey(survey), params: r.params, answers: r.answers,
  };
  if (r.status !== 'in_progress' || !r.currentPage) {
    return { ...base, page: null, canBack: false, progress: 100, step: 0, ...finished(survey, r, panels) };
  }
  const nav = cleanAnswers(ctxOf(survey, r, r.answers), r.history);
  return {
    ...base,
    // + значения, вычисленные действиями (переменные, автоответы)
    answers: { ...r.answers, ...nav },
    page: r.currentPage,
    canBack: st.allowBack && r.history.length > 0,
    progress: progressPercent(ctxOf(survey, r, nav), r.currentPage, r.history),
    step: r.history.filter((id) => findPage(expandAllLoops(survey), id)?.questions.some((q) => q.type !== 'info')).length + 1,
    deadline: st.timeLimitMin ? new Date(Date.parse(r.startedAt) + st.timeLimitMin * 60_000).toISOString() : undefined,
  };
}

/**
 * Проверяет ответы текущей страницы. Скрытые вопросы (в т.ч. скрытые из-за ответов на этой же странице)
 * игнорируются. strict=false — невалидные ответы молча отбрасываются (для «Назад» и «Завершить»).
 */
export function checkPage(survey: Survey, r: StoredResponse, pageId: string, submitted: Answers, strict: boolean) {
  const page = findPage(ctxOf(survey, r, r.answers).survey, pageId) ?? findPage(expandAllLoops(survey), pageId)!;
  const working: Answers = cleanAnswers(ctxOf(survey, r, r.answers), r.history);
  const errors: Record<string, string> = {};
  const pageAnswers: Answers = {};
  // Скрытые переменные (любой страницы) приходят от скриптов браузера
  for (const q of allQuestions(expandAllLoops(survey))) {
    if (q.type !== 'hidden' || !submitted?.[q.id]) continue;
    const a = submitted[q.id];
    if (a && typeof a === 'object' && 'v' in a && !validateAnswer(ctxOf(survey, r, working), q, a)) {
      working[q.id] = { v: a.v };
      pageAnswers[q.id] = { v: a.v };
    }
  }
  for (const q of page.questions) {
    if (q.type === 'hidden') continue;
    delete working[q.id];
    const ctx = ctxOf(survey, r, working);
    if (!isQuestionVisible(ctx, q) || q.type === 'info') continue;
    const raw = submitted?.[q.id];
    const a: Answer | undefined = raw && typeof raw === 'object' && 'v' in raw ? normalizeAnswer(q, raw) : undefined;
    const err = validateAnswer(ctx, q, a);
    if (err) {
      if (strict) errors[q.id] = err;
      continue;
    }
    if (a && !isEmptyAnswer(a)) {
      working[q.id] = a;
      pageAnswers[q.id] = a;
    }
  }
  // Действия «показать ошибку» — когда известны все ответы страницы
  if (strict) {
    const ctx = ctxOf(survey, r, working);
    for (const q of page.questions) {
      if (errors[q.id] || !isQuestionVisible(ctx, q)) continue;
      const e = actionError(ctx, q);
      if (e) errors[q.id] = e;
    }
  }
  return { errors, working, pageAnswers, page };
}

/** Прямолинейные ответы в матрице: от 3 заполненных строк, и во всех — одно и то же */
function straightlined(ctx: RespondentContext, q: Extract<Survey['blocks'][number]['questions'][number], { type: 'matrix' }>): boolean {
  const v = ctx.answers[q.id]?.v;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const rows = answerRows(ctx, q).filter((r) => !r.other);
  const values = rows.map((r) => (v as Record<string, number | number[]>)[String(r.code)])
    .filter((x) => x !== undefined && !(Array.isArray(x) && !x.length))
    .map((x) => JSON.stringify(Array.isArray(x) ? [...x].sort((a, b) => a - b) : x));
  return values.length >= 3 && values.every((x) => x === values[0]);
}

/**
 * Качество ответов на странице: ловушка для ботов, контрольные вопросы, прямолинейные ответы.
 * Возвращает новые пометки и нужно ли отсеять респондента.
 */
export function qualityCheck(ctx: RespondentContext, questions: Survey['blocks'][number]['questions'], hp: unknown, prev: string[]) {
  const flags = new Set(prev);
  let screenout = false;
  if (typeof hp === 'string' && hp.trim()) flags.add('bot');
  for (const q of questions) {
    if (!ctx.answers[q.id] || !isQuestionVisible(ctx, q)) continue;
    if (q.attention && !evalCondition(q.attention.correct, ctx)) {
      flags.add(`attention:${q.id}`);
      if (q.attention.onFail === 'screenout') screenout = true;
    }
    if (q.type === 'matrix' && q.straightline && straightlined(ctx, q)) {
      flags.add(`straightline:${q.id}`);
      if (q.straightline === 'screenout') screenout = true;
    }
  }
  return { flags: [...flags], screenout };
}

/** Ответы страницы заменяют прежние ответы на её вопросы */
export function mergePage(stored: Answers, page: { questions: { id: string; type: string }[] }, pageAnswers: Answers): Answers {
  const out = { ...stored };
  for (const q of page.questions) if (q.type !== 'hidden') delete out[q.id];
  return { ...out, ...pageAnswers };
}

export async function finalize(
  survey: Survey, r: StoredResponse, answers: Answers, visited: string[], status: ResponseStatus,
  ending: { message?: string; redirect?: string } | null = null,
) {
  const completedAt = new Date();
  const final = cleanAnswers(ctxOf(survey, r, answers), visited);
  await responses.update(r.id, {
    answers: final, history: visited, currentPage: null, status, ending,
    completedAt: completedAt.toISOString(),
    durationSec: Math.round((completedAt.getTime() - new Date(r.startedAt).getTime()) / 1000),
  });
  if (status === 'completed') {
    noteCompleted(ownerOf(r), survey, r.isTest, ctxOf(survey, r, final));
    // Уведомления — в фоне, респондент не ждёт
    if (!r.isTest && r.projectId) {
      const projectId = r.projectId;
      responses.get(r.id)
        .then((saved) => saved && afterComplete(projectId, survey, saved, ctxOf(survey, saved, final)))
        .catch((e) => console.error('Уведомление не отправлено:', e));
    }
  }
  if (!r.isTest && r.projectId) queueResponseSync(r.projectId, r.id);
}

/** Сессия респондента по ID ответа (адрес — проект или анкета — должен совпадать); переводит её на текущую версию анкеты и завершает по таймеру */
export async function loadSession(id: string, rid: string) {
  // Сессия принадлежит проекту или (предпросмотр из конструктора) анкете — адрес должен совпадать
  const r = rid ? await responses.get(rid) : null;
  if (!r || (r.projectId ?? r.surveyId) !== id) return null;
  const t = r.projectId ? await resolveTarget(r.projectId) : await resolveTarget(r.surveyId, true);
  if (!t) return null;
  const s = t.surveyRow;
  const survey = definitionFor(t, r.isTest);
  if (!survey) return null;
  const panels = t.loaded?.project.panels ?? [];
  // Анкету переопубликовали (или черновик изменили) во время прохождения — продолжаем по текущей версии
  const all = expandAllLoops(survey);
  const stale = r.currentPage && !findPage(all, r.currentPage);
  if (r.status === 'in_progress' && (stale || (!r.isTest && r.version !== s.version))) {
    if (!r.isTest) r.version = s.version;
    if (r.currentPage && !findPage(all, r.currentPage)) {
      r.currentPage = firstPage(ctxOf(survey, r, {}));
      r.history = [];
    }
    r.history = r.history.filter((p) => findPage(all, p));
    await responses.update(r.id, { version: r.version, currentPage: r.currentPage, history: r.history });
  }
  // Время вышло — анкета завершается досрочно с сохранёнными ответами
  const limit = settingsOf(survey).timeLimitMin;
  if (limit && r.status === 'in_progress' && Date.now() > Date.parse(r.startedAt) + limit * 60_000 + 5_000) {
    await finalize(survey, r, r.answers, r.history, 'terminated', { message: settingsOf(survey).timeoutMessage });
    return { s, r: (await responses.get(r.id))!, survey, panels };
  }
  return { s, r, survey, panels };
}

export const ALREADY_DONE = 'Вы уже прошли этот опрос. Спасибо!';

export const closed = (title: string, message: string) => ({ closed: true as const, title, message });

/**
 * Человек уже начинал опрос (персональная ссылка, ID панелиста): начатую анкету продолжаем, завершённую второй раз не проходят.
 * null — прежнюю сессию открыть нельзя.
 */
export async function resumeSession(projectId: string, rid: string, title: string) {
  const prev = await loadSession(projectId, rid);
  if (!prev) return null;
  if (prev.r.status === 'in_progress') return stateOf(prev.survey, prev.r, prev.panels);
  return closed(title, ALREADY_DONE);
}
