// API прохождения опроса. Сервер — источник истины: он проверяет ответы и решает, куда идти дальше.
import type { FastifyInstance } from 'fastify';
import { checkTestToken, currentUser } from '../auth.ts';
import { config } from '../config.ts';
import { responses, surveys, type StoredResponse, type SurveyRow } from '../db.ts';
import { defFor, loadProject, type Loaded } from '../projectCtx.ts';
import { queueResponseSync } from '../sheets.ts';
import { fullQuota, noteCompleted } from '../quotas.ts';
import { afterComplete } from '../notify.ts';
import {
  actionError, allQuestions, cleanAnswers, endingAction, findPage, firstPage, paramAnswer, isQuestionVisible, nextPage, pipe, pipeUrl, progressPercent,
} from '../../shared/logic.ts';
import { isEmptyAnswer, normalizeAnswer, validateAnswer } from '../../shared/answers.ts';
import { expandAllLoops, withLoops } from '../../shared/loops.ts';
import { END, SCREENOUT, settingsOf, type Answer, type Answers, type RespondentContext, type Survey } from '../../shared/types.ts';
import type { ResponseStatus } from '../../shared/variables.ts';

export interface RunnerState {
  rid: string;
  status: ResponseStatus;
  preview: boolean;
  survey: Survey;
  params: Record<string, string>;
  answers: Answers;
  page: string | null;
  canBack: boolean;
  progress: number;
  /** Порядковый номер вопроса у респондента (для «Вопрос N») */
  step: number;
  message?: string;
  /** Куда перенаправить после завершения */
  redirect?: string;
  /** До какого момента нужно закончить (ограничение времени), ISO */
  deadline?: string;
}

const RESERVED_PARAMS = new Set(['preview', 'new', 'rid', 'test', 'survey', 'start']);

function cleanParams(raw: unknown): Record<string, string> {
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
interface Target {
  projectId: string | null;
  surveyRow: SurveyRow;
  loaded: Loaded | null;
}

async function resolveTarget(id: string, surveyOnly = false): Promise<Target | null> {
  const loaded = surveyOnly ? null : await loadProject(id);
  if (loaded) return { projectId: id, surveyRow: loaded.survey, loaded };
  const s = await surveys.get(id);
  return s ? { projectId: null, surveyRow: s, loaded: null } : null;
}

function definitionFor(t: Target, isTest: boolean): Survey | null {
  if (t.loaded) return isTest ? t.loaded.draft : t.loaded.live;
  return isTest ? t.surveyRow.draft : null;
}

/** Ключ для квот и очередей: проект или (для предпросмотра без проекта) анкета */
const ownerOf = (r: { projectId: string | null; surveyId: string }) => r.projectId ?? `survey:${r.surveyId}`;

/** Контекст респондента; циклы развёрнуты по его ответам */
const ctxOf = (survey: Survey, r: StoredResponse, answers: Answers): RespondentContext =>
  withLoops({ survey, answers, params: r.params, seed: r.id });

/** Анкета для браузера респондента — без пароля */
export function publicSurvey(survey: Survey): Survey {
  if (!survey.settings?.password) return survey;
  const { password: _, ...settings } = survey.settings;
  return { ...survey, settings };
}

function finished(survey: Survey, r: StoredResponse): { message: string; redirect?: string } {
  const st = settingsOf(survey);
  let [message, redirect] = r.status === 'screened_out' ? [st.screenoutMessage, st.redirectScreenout]
    : r.status === 'terminated' ? [st.earlyFinishMessage, st.redirectEarlyFinish]
      : r.status === 'overquota' ? [st.overquotaMessage, st.redirectOverquota]
      : [st.completeMessage, st.redirectComplete];
  // Своё сообщение и адрес у сработавшего действия важнее общих
  if (r.ending?.message) message = r.ending.message;
  if (r.ending?.redirect) redirect = r.ending.redirect;
  const ctx = ctxOf(survey, r, r.answers);
  return { message: pipe(message, ctx), redirect: redirect ? pipeUrl(redirect, ctx, r.id) : undefined };
}

/** Почему новый респондент не может начать опрос (null — может) */
async function closedReason(projectId: string, survey: Survey): Promise<string | null> {
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

function stateOf(survey: Survey, r: StoredResponse): RunnerState {
  const st = settingsOf(survey);
  const base = {
    rid: r.id, status: r.status, preview: r.isTest, survey: publicSurvey(survey), params: r.params, answers: r.answers,
  };
  if (r.status !== 'in_progress' || !r.currentPage) {
    return { ...base, page: null, canBack: false, progress: 100, step: 0, ...finished(survey, r) };
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
function checkPage(survey: Survey, r: StoredResponse, pageId: string, submitted: Answers, strict: boolean) {
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

/** Ответы страницы заменяют прежние ответы на её вопросы */
function mergePage(stored: Answers, page: { questions: { id: string; type: string }[] }, pageAnswers: Answers): Answers {
  const out = { ...stored };
  for (const q of page.questions) if (q.type !== 'hidden') delete out[q.id];
  return { ...out, ...pageAnswers };
}

async function finalize(
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

export async function respondentRoutes(app: FastifyInstance) {
  async function load(id: string, rid: string) {
    // Сессия принадлежит проекту или (предпросмотр из конструктора) анкете — адрес должен совпадать
    const r = rid ? await responses.get(rid) : null;
    if (!r || (r.projectId ?? r.surveyId) !== id) return null;
    const t = r.projectId ? await resolveTarget(r.projectId) : await resolveTarget(r.surveyId, true);
    if (!t) return null;
    const s = t.surveyRow;
    const survey = definitionFor(t, r.isTest);
    if (!survey) return null;
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
      return { s, r: (await responses.get(r.id))!, survey };
    }
    return { s, r, survey };
  }

  app.post<{
    Params: { id: string };
    Body: {
      rid?: string; params?: unknown; preview?: boolean; test?: string; startAt?: string; restart?: boolean; password?: string;
      /** Предпросмотр анкеты из конструктора — вне проекта, даже если ID совпадает с проектом */
      surveyPreview?: boolean;
    };
  }>(
    '/api/s/:id/start',
    async (req, reply) => {
      const t = await resolveTarget(req.params.id, !!req.body?.surveyPreview && (!!req.body?.preview || !!req.body?.test));
      if (!t) return reply.code(404).send({ error: 'Опрос не найден' });
      const s = t.surveyRow;
      // Предпросмотр черновика: команда (после входа) или тестовая ссылка
      const preview = !!req.body?.preview || !!req.body?.test;
      if (preview && !checkTestToken(req.params.id, req.body?.test) && !(await currentUser(req))) {
        return reply.code(401).send({ error: req.body?.test ? 'Тестовая ссылка недействительна' : 'Предпросмотр доступен только после входа в админку' });
      }

      if (!preview) {
        // Сбор ответов решает проект: «Разработка» — ещё не начался, «Обработка» и «Архив» — закрыт
        const p = t.loaded?.project;
        const live = t.loaded?.live;
        if (!p || !live || p.status !== 'collecting') {
          const base = live ?? t.loaded?.draft ?? s.draft;
          const message = p?.status === 'development' || !live ? 'Опрос ещё не начался.' : settingsOf(base).closedMessage;
          return { closed: true, title: base.title, message };
        }
      }

      const draftDef = definitionFor(t, true)!;
      // Предпросмотр с выбранного вопроса — всегда новая сессия
      const startAt = preview && req.body?.startAt && findPage(draftDef, req.body.startAt) ? req.body.startAt : null;

      if (req.body?.rid && !startAt) {
        const loaded = await load(req.params.id, req.body.rid);
        if (loaded && loaded.r.isTest === preview) {
          const done = loaded.r.status !== 'in_progress';
          // Завершённую сессию показываем снова, если повторное прохождение не разрешено (в предпросмотре — всегда заново)
          const retake = done && (preview || (req.body.restart && settingsOf(loaded.survey).allowRetake));
          if (!retake) return stateOf(loaded.survey, loaded.r);
        }
      }

      const survey = definitionFor(t, preview)!;
      const params = cleanParams(req.body?.params);
      if (!preview && t.projectId) {
        const projectId = t.projectId;
        const st = settingsOf(survey);
        // Один ответ на значение параметра (ID панелиста): продолжаем начатую анкету, повторно не пускаем
        if (st.uniqueParam) {
          const value = params[st.uniqueParam];
          if (!value) return { closed: true, title: survey.title, message: 'Ссылка на опрос неполная. Откройте её из приглашения ещё раз.' };
          const prev = await responses.findByParam(projectId, st.uniqueParam, value);
          if (prev) {
            const loaded = await load(projectId, prev.id);
            if (loaded?.r.status === 'in_progress') return stateOf(loaded.survey, loaded.r);
            return { closed: true, title: survey.title, message: 'Вы уже прошли этот опрос. Спасибо!' };
          }
        }
        if (st.maxStartsPerIpHour && req.ip && (await responses.countByIp(projectId, req.ip, 3600)) >= st.maxStartsPerIpHour) {
          return { closed: true, title: survey.title, message: 'С вашего устройства уже начато слишком много анкет. Попробуйте позже.' };
        }
        const reason = await closedReason(projectId, survey);
        if (reason) return { closed: true, title: survey.title, message: reason };
        const password = survey.settings?.password;
        if (password && req.body?.password !== password) {
          return { needPassword: true, title: survey.title, error: req.body?.password ? 'Неверный пароль' : undefined };
        }
      }
      // Скрытые переменные из параметров ссылки
      const initial: Answers = {};
      for (const q of allQuestions(survey)) {
        if (q.type === 'hidden' && q.fromParam && params[q.fromParam] !== undefined && params[q.fromParam] !== '') {
          const raw = params[q.fromParam];
          initial[q.id] = { v: q.valueType === 'number' && isFinite(Number(raw)) ? Number(raw) : raw };
        }
      }
      // Предзаполнение видимых вопросов из ссылки (респондент может исправить)
      for (const q of allQuestions(survey)) {
        if (!q.prefillParam || q.prefillSkip || q.type === 'hidden') continue;
        const v = paramAnswer({ survey, answers: initial, params, seed: '' }, q);
        if (v !== undefined) initial[q.id] = { v };
      }
      const created = await responses.create({
        projectId: t.projectId, surveyId: s.id, version: s.version, status: 'in_progress', isTest: preview, answers: initial, history: [],
        currentPage: null, params, ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || null,
        startedAt: new Date().toISOString(),
      });
      const startCtx = ctxOf(survey, created, cleanAnswers(ctxOf(survey, created, initial), []));
      const first = startAt ?? firstPage(startCtx);
      // Квоты по параметрам ссылки проверяются сразу
      if (!startAt && first !== SCREENOUT && (await fullQuota(ownerOf(created), survey, preview, startCtx))) {
        await finalize(survey, created, initial, [], 'overquota');
      } else if (first === END || first === SCREENOUT) {
        await finalize(survey, created, initial, [], first === END ? 'completed' : 'screened_out');
      } else {
        await responses.update(created.id, { currentPage: first });
      }
      return stateOf(survey, (await responses.get(created.id))!);
    },
  );

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers: Answers } }>(
    '/api/s/:id/submit',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r } = loaded;
      if (r.status !== 'in_progress' || r.currentPage !== req.body.page) {
        return { ...stateOf(survey, r), resynced: true };
      }
      const { errors, pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers, true);
      if (Object.keys(errors).length) return reply.code(422).send({ errors });

      const answers = mergePage(r.answers, page, pageAnswers);
      const visited = [...r.history, page.id];
      // Время на экране: с момента его показа (последнее обновление сессии), при возврате — суммируется
      const spent = Math.min(3600, Math.max(0, Math.round((Date.now() - Date.parse(r.updatedAt)) / 1000)));
      const timings = { ...r.timings, [page.id]: (r.timings?.[page.id] ?? 0) + spent };
      await responses.update(r.id, { timings });
      // Навигация — по ответам с учётом действий «после ответа» (переменные)
      const nav = ctxOf(survey, r, cleanAnswers(ctxOf(survey, r, answers), visited));
      const next = nextPage(nav, page.id);
      // Респондент подошёл под квоту, которая уже набрана (отсев важнее квоты)
      if (next !== SCREENOUT && (await fullQuota(ownerOf(r), survey, r.isTest, nav))) {
        await finalize(survey, r, answers, visited, 'overquota');
      } else if (next === END || next === SCREENOUT) {
        const act = endingAction(nav, page.id);
        const ending = act && (act.message || act.redirect) ? { message: act.message, redirect: act.redirect } : null;
        await finalize(survey, r, answers, visited, next === END ? 'completed' : 'screened_out', ending);
      } else {
        await responses.update(r.id, { answers, history: visited, currentPage: next });
      }
      return stateOf(survey, (await responses.get(r.id))!);
    },
  );

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>(
    '/api/s/:id/back',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r } = loaded;
      const st = settingsOf(survey);
      if (r.status !== 'in_progress' || !st.allowBack || r.history.length === 0 || r.currentPage !== req.body.page) {
        return stateOf(survey, r);
      }
      // Сохраняем то, что уже введено на странице, чтобы не потерять при возврате
      const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
      const history = r.history.slice(0, -1);
      await responses.update(r.id, {
        answers: mergePage(r.answers, page, pageAnswers), history, currentPage: r.history[r.history.length - 1],
      });
      return stateOf(survey, (await responses.get(r.id))!);
    },
  );

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>(
    '/api/s/:id/finish',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r } = loaded;
      const st = settingsOf(survey);
      if (r.status !== 'in_progress' || !st.allowEarlyFinish || !r.currentPage) return stateOf(survey, r);
      const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
      await finalize(survey, r, mergePage(r.answers, page, pageAnswers), [...r.history, page.id], 'terminated');
      return stateOf(survey, (await responses.get(r.id))!);
    },
  );
}
