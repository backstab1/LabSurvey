// API прохождения опроса. Сервер — источник истины: он проверяет ответы и решает, куда идти дальше.
import type { FastifyInstance } from 'fastify';
import { checkTestToken, currentUser } from '../auth.ts';
import { config } from '../config.ts';
import { invitees, responses, surveys, type Invitee, type StoredResponse, type SurveyRow } from '../db.ts';
import { defFor, loadProject, type Loaded } from '../projectCtx.ts';
import { queueResponseSync } from '../sheets.ts';
import { fullQuota, noteCompleted } from '../quotas.ts';
import { afterComplete } from '../notify.ts';
import {
  actionError, allQuestions, answerRows, cleanAnswers, endingAction, evalCondition, findPage, firstPage, paramAnswer, isQuestionVisible, nextPage, pipe, pipeUrl, progressPercent,
} from '../../shared/logic.ts';
import { fileIds, isEmptyAnswer, normalizeAnswer, validateAnswer } from '../../shared/answers.ts';
import { IMAGE_EXT, MIME, countUploads, detectType, saveUpload, uploadPath } from '../uploads.ts';
import { createReadStream } from 'node:fs';
import { expandAllLoops, withLoops } from '../../shared/loops.ts';
import { END, INVITE_PARAM, PANEL_PARAM, RESERVED_PARAMS as RESERVED, SCREENOUT, settingsOf, type Answer, type Panel, type Answers, type RespondentContext, type Survey } from '../../shared/types.ts';
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

/** Команда (не заказчик) может открыть предпросмотр черновика */
const isTeam = async (req: Parameters<typeof currentUser>[0]) => {
  const u = await currentUser(req);
  return !!u && u.role !== 'client';
};

const RESERVED_PARAMS = new Set(RESERVED);

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

function stateOf(survey: Survey, r: StoredResponse, panels: Panel[] = []): RunnerState {
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
function qualityCheck(ctx: RespondentContext, questions: Survey['blocks'][number]['questions'], hp: unknown, prev: string[]) {
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
  // Загрузка файла приходит телом запроса целиком (имя — в заголовке x-file-name)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 21 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  async function load(id: string, rid: string) {
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
      if (preview && !checkTestToken(req.params.id, req.body?.test) && !(await isTeam(req))) {
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

      // Персональная ссылка: один человек — одна анкета; начатую продолжаем с любого устройства
      let invitee: Invitee | null = null;
      const invToken = !preview && t.projectId ? String((req.body?.params as Record<string, unknown> | undefined)?.[INVITE_PARAM] ?? '').slice(0, 64) : '';
      if (invToken && t.projectId) {
        invitee = await invitees.byToken(t.projectId, invToken);
        const title = (t.loaded?.live ?? s.draft).title;
        if (!invitee) return { closed: true, title, message: 'Ссылка недействительна. Откройте её из приглашения целиком или попросите новую.' };
        if (invitee.responseId) {
          const prev = await load(t.projectId, invitee.responseId);
          if (prev?.r.status === 'in_progress') return stateOf(prev.survey, prev.r, prev.panels);
          if (prev) return { closed: true, title, message: 'Вы уже прошли этот опрос. Спасибо!' };
        }
      }

      const draftDef = definitionFor(t, true)!;
      // Предпросмотр с выбранного вопроса — всегда новая сессия
      const startAt = preview && req.body?.startAt && findPage(draftDef, req.body.startAt) ? req.body.startAt : null;

      if (req.body?.rid && !startAt && !invitee) {
        const loaded = await load(req.params.id, req.body.rid);
        if (loaded && loaded.r.isTest === preview) {
          const done = loaded.r.status !== 'in_progress';
          // Завершённую сессию показываем снова, если повторное прохождение не разрешено (в предпросмотре — всегда заново)
          const retake = done && (preview || (req.body.restart && settingsOf(loaded.survey).allowRetake));
          if (!retake) return stateOf(loaded.survey, loaded.r, loaded.panels);
        }
      }

      const survey = definitionFor(t, preview)!;
      // Поля из списка важнее параметров в адресе: их нельзя подменить
      const params = invitee
        ? { ...cleanParams(req.body?.params), ...invitee.fields, ...(invitee.extId ? { inv_id: invitee.extId } : {}) }
        : cleanParams(req.body?.params);
      const panels = t.loaded?.project.panels ?? [];
      const panel = panelOf(panels, params);
      let panelFull = false;
      if (!preview && t.projectId) {
        const projectId = t.projectId;
        const st = settingsOf(survey);
        if (panel?.closed) return { closed: true, title: survey.title, message: st.closedMessage };
        if (st.inviteOnly && !invitee) {
          return { closed: true, title: survey.title, message: 'Опрос доступен только по персональной ссылке из приглашения.' };
        }
        // Панель с ID респондента: один ответ на ID внутри панели, начатую анкету продолжаем
        if (panel?.idParam) {
          const value = params[panel.idParam];
          if (!value) return { closed: true, title: survey.title, message: 'Ссылка на опрос неполная. Откройте её из приглашения ещё раз.' };
          const prev = await responses.findByParam(projectId, { [PANEL_PARAM]: panel.id, [panel.idParam]: value });
          if (prev) {
            const loaded = await load(projectId, prev.id);
            if (loaded?.r.status === 'in_progress') return stateOf(loaded.survey, loaded.r, loaded.panels);
            return { closed: true, title: survey.title, message: 'Вы уже прошли этот опрос. Спасибо!' };
          }
        }
        if (panel?.limit && (await responses.completedFromPanel(projectId, panel.id)) >= panel.limit) panelFull = true;
        // Один ответ на значение параметра (ID панелиста): продолжаем начатую анкету, повторно не пускаем
        if (st.uniqueParam) {
          const value = params[st.uniqueParam];
          if (!value) return { closed: true, title: survey.title, message: 'Ссылка на опрос неполная. Откройте её из приглашения ещё раз.' };
          const prev = await responses.findByParam(projectId, { [st.uniqueParam]: value });
          if (prev) {
            const loaded = await load(projectId, prev.id);
            if (loaded?.r.status === 'in_progress') return stateOf(loaded.survey, loaded.r, loaded.panels);
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
      if (invitee) await invitees.attach(invitee.id, created.id);
      const startCtx = ctxOf(survey, created, cleanAnswers(ctxOf(survey, created, initial), []));
      const first = startAt ?? firstPage(startCtx);
      // Лимит панели набран — сразу «Сверх квоты» (с редиректом панели); квоты по параметрам ссылки проверяются сразу
      if (panelFull || (!startAt && first !== SCREENOUT && (await fullQuota(ownerOf(created), survey, preview, startCtx)))) {
        await finalize(survey, created, initial, [], 'overquota');
      } else if (first === END || first === SCREENOUT) {
        await finalize(survey, created, initial, [], first === END ? 'completed' : 'screened_out');
      } else {
        await responses.update(created.id, { currentPage: first });
      }
      return stateOf(survey, (await responses.get(created.id))!, panels);
    },
  );

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers: Answers; hp?: string } }>(
    '/api/s/:id/submit',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r, panels } = loaded;
      if (r.status !== 'in_progress' || r.currentPage !== req.body.page) {
        return { ...stateOf(survey, r, panels), resynced: true };
      }
      const { errors, pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers, true);
      // Файлы должны быть загружены именно в эту анкету
      for (const q of page.questions) {
        if (q.type !== 'file' || !pageAnswers[q.id]) continue;
        if (fileIds(pageAnswers[q.id].v).some((id) => !uploadPath(ownerOf(r), r.id, id))) errors[q.id] = 'Файл не найден — загрузите его ещё раз';
      }
      if (Object.keys(errors).length) return reply.code(422).send({ errors });

      const answers = mergePage(r.answers, page, pageAnswers);
      const visited = [...r.history, page.id];
      // Время на экране: с момента его показа (последнее обновление сессии), при возврате — суммируется
      const spent = Math.min(3600, Math.max(0, Math.round((Date.now() - Date.parse(r.updatedAt)) / 1000)));
      const timings = { ...r.timings, [page.id]: (r.timings?.[page.id] ?? 0) + spent };
      await responses.update(r.id, { timings });
      // Навигация — по ответам с учётом действий «после ответа» (переменные)
      const nav = ctxOf(survey, r, cleanAnswers(ctxOf(survey, r, answers), visited));
      const quality = qualityCheck(nav, page.questions, req.body.hp, r.flags ?? []);
      if (quality.flags.length !== (r.flags ?? []).length) await responses.update(r.id, { flags: quality.flags });
      const next = nextPage(nav, page.id);
      if (quality.screenout) {
        // Контрольный вопрос или прямолинейные ответы с отсевом
        await finalize(survey, r, answers, visited, 'screened_out');
      } else if (next !== SCREENOUT && (await fullQuota(ownerOf(r), survey, r.isTest, nav))) {
        // Респондент подошёл под квоту, которая уже набрана (отсев важнее квоты)
        await finalize(survey, r, answers, visited, 'overquota');
      } else if (next === END || next === SCREENOUT) {
        const act = endingAction(nav, page.id);
        const ending = act && (act.message || act.redirect) ? { message: act.message, redirect: act.redirect } : null;
        await finalize(survey, r, answers, visited, next === END ? 'completed' : 'screened_out', ending);
      } else {
        await responses.update(r.id, { answers, history: visited, currentPage: next });
      }
      return stateOf(survey, (await responses.get(r.id))!, panels);
    },
  );

  // Загрузка файла для вопроса текущего экрана: проверяются тип (по содержимому), размер и число файлов
  app.post<{ Params: { id: string }; Querystring: { rid?: string; q?: string }; Body: Buffer }>('/api/s/:id/upload', async (req, reply) => {
    const loaded = await load(req.params.id, String(req.query.rid ?? ''));
    if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
    const { survey, r } = loaded;
    if (r.status !== 'in_progress' || !r.currentPage) return reply.code(400).send({ error: 'Анкета уже завершена' });
    const page = findPage(ctxOf(survey, r, r.answers).survey, r.currentPage) ?? findPage(expandAllLoops(survey), r.currentPage);
    const q = page?.questions.find((x) => x.id === req.query.q);
    if (!q || q.type !== 'file') return reply.code(400).send({ error: 'Вопрос не найден' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return reply.code(400).send({ error: 'Пустой файл' });
    const maxMb = q.maxSizeMb ?? 10;
    if (buf.length > maxMb * 1024 * 1024) return reply.code(413).send({ error: `Файл больше ${maxMb} МБ` });
    let name = 'файл';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'файл')).replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'файл'; } catch { /* имя не важно */ }
    const ext = detectType(buf, name);
    const allowed = (q.accept ?? 'image') === 'image' ? (IMAGE_EXT as readonly string[]) : Object.keys(MIME);
    if (!ext || !allowed.includes(ext)) {
      return reply.code(415).send({ error: (q.accept ?? 'image') === 'image' ? 'Можно загрузить только фото или картинку (JPG, PNG, WEBP, GIF, HEIC)' : 'Такой тип файла не поддерживается' });
    }
    if (countUploads(ownerOf(r), r.id) >= 30) return reply.code(429).send({ error: 'Слишком много файлов' });
    const id = saveUpload(ownerOf(r), r.id, buf, ext);
    return { id, name, size: buf.length, type: MIME[ext] };
  });

  // Свой файл — для миниатюры при возврате к вопросу
  app.get<{ Params: { id: string }; Querystring: { rid?: string; f?: string } }>('/api/s/:id/file', async (req, reply) => {
    const loaded = await load(req.params.id, String(req.query.rid ?? ''));
    const p = loaded ? uploadPath(ownerOf(loaded.r), loaded.r.id, String(req.query.f ?? '')) : null;
    if (!p) return reply.code(404).send({ error: 'Файл не найден' });
    const ext = p.split('.').pop()!;
    reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream').header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Disposition', IMAGE_EXT.includes(ext as never) ? 'inline' : 'attachment');
    return reply.send(createReadStream(p));
  });

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>(
    '/api/s/:id/back',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r, panels } = loaded;
      const st = settingsOf(survey);
      if (r.status !== 'in_progress' || !st.allowBack || r.history.length === 0 || r.currentPage !== req.body.page) {
        return stateOf(survey, r, panels);
      }
      // Сохраняем то, что уже введено на странице, чтобы не потерять при возврате
      const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
      const history = r.history.slice(0, -1);
      await responses.update(r.id, {
        answers: mergePage(r.answers, page, pageAnswers), history, currentPage: r.history[r.history.length - 1],
      });
      return stateOf(survey, (await responses.get(r.id))!, panels);
    },
  );

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>(
    '/api/s/:id/finish',
    async (req, reply) => {
      const loaded = await load(req.params.id, req.body?.rid);
      if (!loaded) return reply.code(404).send({ error: 'Сессия не найдена' });
      const { survey, r, panels } = loaded;
      const st = settingsOf(survey);
      if (r.status !== 'in_progress' || !st.allowEarlyFinish || !r.currentPage) return stateOf(survey, r, panels);
      const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
      await finalize(survey, r, mergePage(r.answers, page, pageAnswers), [...r.history, page.id], 'terminated');
      return stateOf(survey, (await responses.get(r.id))!, panels);
    },
  );
}
