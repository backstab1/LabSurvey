// API прохождения опроса. Сервер — источник истины: он проверяет ответы и решает, куда идти дальше.
import type { FastifyInstance } from 'fastify';
import { isAdmin } from '../auth.ts';
import { responses, surveys, type StoredResponse, type SurveyRow } from '../db.ts';
import { queueResponseSync } from '../sheets.ts';
import {
  cleanAnswers, findPage, firstPage, isQuestionVisible, nextPage, progressPercent,
} from '../../shared/logic.ts';
import { isEmptyAnswer, normalizeAnswer, validateAnswer } from '../../shared/answers.ts';
import { DEFAULT_SETTINGS, END, SCREENOUT, type Answer, type Answers, type RespondentContext, type Survey } from '../../shared/types.ts';
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
  message?: string;
}

const RESERVED_PARAMS = new Set(['preview', 'new', 'rid']);

function cleanParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 30)) {
    if (RESERVED_PARAMS.has(k) || !/^[\w.-]{1,50}$/.test(k)) continue;
    out[k] = String(v ?? '').slice(0, 300);
  }
  return out;
}

function definitionFor(s: SurveyRow, r: { isTest: boolean }): Survey | null {
  return r.isTest ? s.draft : s.published;
}

const ctxOf = (survey: Survey, r: StoredResponse, answers: Answers): RespondentContext =>
  ({ survey, answers, params: r.params, seed: r.id });

function finishedMessage(survey: Survey, status: ResponseStatus): string {
  const st = { ...DEFAULT_SETTINGS, ...survey.settings };
  if (status === 'screened_out') return st.screenoutMessage;
  if (status === 'terminated') return st.earlyFinishMessage;
  return st.completeMessage;
}

function stateOf(survey: Survey, r: StoredResponse): RunnerState {
  const st = { ...DEFAULT_SETTINGS, ...survey.settings };
  const base = {
    rid: r.id, status: r.status, preview: r.isTest, survey, params: r.params, answers: r.answers,
  };
  if (r.status !== 'in_progress' || !r.currentPage) {
    return { ...base, page: null, canBack: false, progress: 100, message: finishedMessage(survey, r.status) };
  }
  const nav = cleanAnswers(ctxOf(survey, r, r.answers), r.history);
  return {
    ...base,
    page: r.currentPage,
    canBack: st.allowBack && r.history.length > 0,
    progress: progressPercent(ctxOf(survey, r, nav), r.currentPage, r.history),
  };
}

/**
 * Проверяет ответы текущей страницы. Скрытые вопросы (в т.ч. скрытые из-за ответов на этой же странице)
 * игнорируются. strict=false — невалидные ответы молча отбрасываются (для «Назад» и «Завершить»).
 */
function checkPage(survey: Survey, r: StoredResponse, pageId: string, submitted: Answers, strict: boolean) {
  const page = findPage(survey, pageId)!;
  const working: Answers = cleanAnswers(ctxOf(survey, r, r.answers), r.history);
  const errors: Record<string, string> = {};
  const pageAnswers: Answers = {};
  // Скрытые переменные (любой страницы) приходят от скриптов браузера
  for (const q of survey.pages.flatMap((p) => p.questions)) {
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
  return { errors, working, pageAnswers, page };
}

/** Ответы страницы заменяют прежние ответы на её вопросы */
function mergePage(stored: Answers, page: { questions: { id: string; type: string }[] }, pageAnswers: Answers): Answers {
  const out = { ...stored };
  for (const q of page.questions) if (q.type !== 'hidden') delete out[q.id];
  return { ...out, ...pageAnswers };
}

async function finalize(survey: Survey, r: StoredResponse, answers: Answers, visited: string[], status: ResponseStatus) {
  const completedAt = new Date();
  const final = cleanAnswers(ctxOf(survey, r, answers), visited);
  await responses.update(r.id, {
    answers: final, history: visited, currentPage: null, status,
    completedAt: completedAt.toISOString(),
    durationSec: Math.round((completedAt.getTime() - new Date(r.startedAt).getTime()) / 1000),
  });
  if (!r.isTest) queueResponseSync(r.surveyId, r.id);
}

export async function respondentRoutes(app: FastifyInstance) {
  async function load(surveyId: string, rid: string) {
    const s = await surveys.get(surveyId);
    const r = rid ? await responses.get(rid) : null;
    if (!s || !r || r.surveyId !== s.id) return null;
    const survey = definitionFor(s, r);
    if (!survey) return null;
    // Анкету переопубликовали во время прохождения — продолжаем по новой версии
    if (!r.isTest && r.version !== s.version && r.status === 'in_progress') {
      r.version = s.version;
      if (r.currentPage && !findPage(survey, r.currentPage)) {
        r.currentPage = firstPage(ctxOf(survey, r, {}));
        r.history = [];
      }
      r.history = r.history.filter((p) => findPage(survey, p));
      await responses.update(r.id, { version: s.version, currentPage: r.currentPage, history: r.history });
    }
    return { s, r, survey };
  }

  app.post<{ Params: { id: string }; Body: { rid?: string; params?: unknown; preview?: boolean } }>(
    '/api/s/:id/start',
    async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Опрос не найден' });
      const preview = !!req.body?.preview;
      if (preview && !isAdmin(req)) return reply.code(401).send({ error: 'Предпросмотр доступен только после входа в админку' });

      if (!preview) {
        if (!s.published || s.status !== 'active') {
          const msg = s.published?.settings?.closedMessage ?? DEFAULT_SETTINGS.closedMessage;
          return { closed: true, title: s.published?.title ?? s.title, message: msg };
        }
      }

      if (req.body?.rid) {
        const loaded = await load(s.id, req.body.rid);
        if (loaded && loaded.r.isTest === preview) {
          // В предпросмотре завершённую сессию не показываем — начинаем заново
          if (!(preview && loaded.r.status !== 'in_progress')) return stateOf(loaded.survey, loaded.r);
        }
      }

      const survey = preview ? s.draft : s.published!;
      const params = cleanParams(req.body?.params);
      // Скрытые переменные из параметров ссылки
      const initial: Answers = {};
      for (const q of survey.pages.flatMap((p) => p.questions)) {
        if (q.type === 'hidden' && q.fromParam && params[q.fromParam] !== undefined && params[q.fromParam] !== '') {
          const raw = params[q.fromParam];
          initial[q.id] = { v: q.valueType === 'number' && isFinite(Number(raw)) ? Number(raw) : raw };
        }
      }
      const created = await responses.create({
        surveyId: s.id, version: s.version, status: 'in_progress', isTest: preview, answers: initial, history: [],
        currentPage: null, params, ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || null,
        startedAt: new Date().toISOString(),
      });
      const first = firstPage(ctxOf(survey, created, initial));
      if (first === END || first === SCREENOUT) {
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
      const { errors, working, pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers, true);
      if (Object.keys(errors).length) return reply.code(422).send({ errors });

      const answers = mergePage(r.answers, page, pageAnswers);
      const next = nextPage(ctxOf(survey, r, working), page.id);
      const visited = [...r.history, page.id];
      if (next === END || next === SCREENOUT) {
        await finalize(survey, r, answers, visited, next === END ? 'completed' : 'screened_out');
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
      const st = { ...DEFAULT_SETTINGS, ...survey.settings };
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
      const st = { ...DEFAULT_SETTINGS, ...survey.settings };
      if (r.status !== 'in_progress' || !st.allowEarlyFinish || !r.currentPage) return stateOf(survey, r);
      const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
      await finalize(survey, r, mergePage(r.answers, page, pageAnswers), [...r.history, page.id], 'terminated');
      return stateOf(survey, (await responses.get(r.id))!);
    },
  );
}
