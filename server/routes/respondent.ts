// API прохождения опроса: старт, ответы страницы, «Назад», досрочное завершение, файлы респондента.
// Логика сессии — в session.ts.
import type { FastifyInstance } from 'fastify';
import { checkTestToken } from '../auth.ts';
import { invitees, responses, type Invitee } from '../db.ts';
import { fullQuota } from '../quotas.ts';
import { IMAGE_EXT, MIME, countUploads, detectType, saveUpload, uploadPath } from '../uploads.ts';
import { fail, found, sendUpload } from '../http.ts';
import {
  ALREADY_DONE, checkPage, cleanParams, closed, closedReason, ctxOf, definitionFor, finalize, isTeam, loadSession, mergePage, ownerOf,
  panelOf, qualityCheck, resolveTarget, resumeSession, stateOf,
} from '../session.ts';
import { allQuestions, cleanAnswers, endingAction, findPage, firstPage, nextPage, paramAnswer } from '../../shared/logic.ts';
import { fileIds } from '../../shared/answers.ts';
import { expandAllLoops } from '../../shared/loops.ts';
import { END, INVITE_PARAM, PANEL_PARAM, SCREENOUT, settingsOf, type Answers, type Survey } from '../../shared/types.ts';
import { botChallenge, verifyBotSolution } from '../botcheck.ts';
import { verifyEntry } from '../panelLinks.ts';
import { textFlags } from '../../shared/quality.ts';
import type { BotSolution, Telemetry } from '../../shared/api.ts';

/** Отпечаток устройства из браузера: hex-хеш */
const cleanDevice = (fp: unknown) => (typeof fp === 'string' && /^[a-f0-9]{16,64}$/.test(fp) ? fp : null);

const LINK_INCOMPLETE = 'Ссылка на опрос неполная. Откройте её из приглашения ещё раз.';

/** Начальные ответы из параметров ссылки: скрытые переменные и предзаполнение видимых вопросов (респондент может исправить) */
function initialAnswers(survey: Survey, params: Record<string, string>): Answers {
  const initial: Answers = {};
  for (const q of allQuestions(survey)) {
    if (q.type === 'hidden' && q.fromParam && params[q.fromParam] !== undefined && params[q.fromParam] !== '') {
      const raw = params[q.fromParam];
      initial[q.id] = { v: q.valueType === 'number' && isFinite(Number(raw)) ? Number(raw) : raw };
    }
  }
  for (const q of allQuestions(survey)) {
    if (!q.prefillParam || q.prefillSkip || q.type === 'hidden') continue;
    const v = paramAnswer({ survey, answers: initial, params, seed: '' }, q);
    if (v !== undefined) initial[q.id] = { v };
  }
  return initial;
}

/** Уже есть анкета с такими параметрами ссылки: начатую продолжаем, повторно не пускаем; null — нет */
async function repeatVisit(projectId: string, match: Record<string, string>, title: string) {
  const prev = await responses.findByParam(projectId, match);
  return prev ? (await resumeSession(projectId, prev.id, title)) ?? closed(title, ALREADY_DONE) : null;
}

export async function respondentRoutes(app: FastifyInstance) {
  // Загрузка файла приходит телом запроса целиком (имя — в заголовке x-file-name)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 21 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  const sessionOf = async (id: string, rid: string | undefined) => found(await loadSession(id, String(rid ?? '')), 'Сессия не найдена');

  app.post<{
    Params: { id: string };
    Body: {
      rid?: string; params?: unknown; preview?: boolean; test?: string; startAt?: string; restart?: boolean; password?: string;
      /** Отпечаток устройства, признак автоматизированного браузера, решение проверки браузера, адрес страницы (для подписи панели) */
      fp?: string; wd?: boolean; pow?: BotSolution; url?: string;
      /** Предпросмотр анкеты из конструктора — вне проекта, даже если ID совпадает с проектом */
      surveyPreview?: boolean;
    };
  }>('/api/s/:id/start', async (req) => {
    const b = req.body ?? {};
    // Предпросмотр черновика: команда (после входа) или тестовая ссылка
    const preview = !!b.preview || !!b.test;
    const t = found(await resolveTarget(req.params.id, !!b.surveyPreview && preview), 'Опрос не найден');
    const s = t.surveyRow;
    if (preview && !checkTestToken(req.params.id, b.test) && !(await isTeam(req))) {
      fail(401, b.test ? 'Тестовая ссылка недействительна' : 'Предпросмотр доступен только после входа в админку');
    }

    if (!preview) {
      // Сбор ответов решает проект: «Разработка» — ещё не начался, «Обработка» и «Архив» — закрыт
      const p = t.loaded?.project;
      const live = t.loaded?.live;
      if (!p || !live || p.status !== 'collecting') {
        const base = live ?? t.loaded?.draft ?? s.draft;
        return closed(base.title, p?.status === 'development' || !live ? 'Опрос ещё не начался.' : settingsOf(base).closedMessage);
      }
    }

    // Персональная ссылка: один человек — одна анкета; начатую продолжаем с любого устройства
    let invitee: Invitee | null = null;
    const invToken = !preview && t.projectId ? String((b.params as Record<string, unknown> | undefined)?.[INVITE_PARAM] ?? '').slice(0, 64) : '';
    if (invToken && t.projectId) {
      invitee = await invitees.byToken(t.projectId, invToken);
      const title = (t.loaded?.live ?? s.draft).title;
      if (!invitee) return closed(title, 'Ссылка недействительна. Откройте её из приглашения целиком или попросите новую.');
      if (invitee.responseId) {
        const resumed = await resumeSession(t.projectId, invitee.responseId, title);
        if (resumed) return resumed;
      }
    }

    // Предпросмотр с выбранного вопроса — всегда новая сессия
    const startAt = preview && b.startAt && findPage(definitionFor(t, true)!, b.startAt) ? b.startAt : null;

    if (b.rid && !startAt && !invitee) {
      const loaded = await loadSession(req.params.id, b.rid);
      if (loaded && loaded.r.isTest === preview) {
        const done = loaded.r.status !== 'in_progress';
        // Завершённую сессию показываем снова, если повторное прохождение не разрешено (в предпросмотре — всегда заново)
        const retake = done && (preview || (b.restart && settingsOf(loaded.survey).allowRetake));
        if (!retake) return stateOf(loaded.survey, loaded.r, loaded.panels);
      }
    }

    const survey = definitionFor(t, preview)!;
    // Поля из списка важнее параметров в адресе: их нельзя подменить
    const params = invitee
      ? { ...cleanParams(b.params), ...invitee.fields, ...(invitee.extId ? { inv_id: invitee.extId } : {}) }
      : cleanParams(b.params);
    const panels = t.loaded?.project.panels ?? [];
    const panel = panelOf(panels, params);
    let panelFull = false;
    const device = cleanDevice(b.fp);
    const flags: string[] = [];
    if (!preview && t.projectId) {
      const projectId = t.projectId;
      const st = settingsOf(survey);
      if (panel?.closed) return closed(survey.title, st.closedMessage);
      // Подписанная ссылка панели: без верной подписи не пускаем (защита от подделки ID и «ложных завершений»)
      if (panel?.verifyEntry && panel.hashSecret && !(typeof b.url === 'string' && verifyEntry(panel, b.url.slice(0, 2000)))) {
        return closed(survey.title, 'Ссылка на опрос повреждена или недействительна. Откройте её из приглашения ещё раз.');
      }
      // Невидимая проверка браузера: без решения задачи анкета не создаётся
      if (st.botCheck && !verifyBotSolution(projectId, b.pow)) return { needCheck: true, challenge: botChallenge(projectId) };
      if (b.wd) flags.push('automation');
      if (st.inviteOnly && !invitee) return closed(survey.title, 'Опрос доступен только по персональной ссылке из приглашения.');
      // Панель с ID респондента: один ответ на ID внутри панели
      if (panel?.idParam) {
        const value = params[panel.idParam];
        if (!value) return closed(survey.title, LINK_INCOMPLETE);
        const again = await repeatVisit(projectId, { [PANEL_PARAM]: panel.id, [panel.idParam]: value }, survey.title);
        if (again) return again;
      }
      if (panel?.limit && (await responses.completedFromPanel(projectId, panel.id)) >= panel.limit) panelFull = true;
      // Один ответ на значение параметра (ID панелиста)
      if (st.uniqueParam) {
        const value = params[st.uniqueParam];
        if (!value) return closed(survey.title, LINK_INCOMPLETE);
        const again = await repeatVisit(projectId, { [st.uniqueParam]: value }, survey.title);
        if (again) return again;
      }
      if (st.maxStartsPerIpHour && req.ip && (await responses.countByIp(projectId, req.ip, 3600)) >= st.maxStartsPerIpHour) {
        return closed(survey.title, 'С вашего устройства уже начато слишком много анкет. Попробуйте позже.');
      }
      const reason = await closedReason(projectId, survey);
      if (reason) return closed(survey.title, reason);
      // То же устройство уже проходило опрос: не пускаем или помечаем
      if (st.deviceCheck && device) {
        const seen = await responses.deviceSeen(projectId, device);
        if (seen && st.deviceCheck === 'block' && !st.allowRetake) {
          if (seen.status === 'in_progress') {
            const resumed = await resumeSession(projectId, seen.id, survey.title);
            if (resumed) return resumed;
          }
          return closed(survey.title, ALREADY_DONE);
        }
        if (seen) flags.push('device');
      }
      const password = survey.settings?.password;
      if (password && b.password !== password) {
        return { needPassword: true, title: survey.title, error: b.password ? 'Неверный пароль' : undefined };
      }
    }

    const initial = initialAnswers(survey, params);
    const created = await responses.create({
      projectId: t.projectId, surveyId: s.id, version: s.version, status: 'in_progress', isTest: preview, answers: initial, history: [],
      currentPage: null, params, ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || null,
      startedAt: new Date().toISOString(), device, flags,
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
  });

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers: Answers; hp?: string; tm?: Telemetry } }>('/api/s/:id/submit', async (req, reply) => {
    const { survey, r, panels } = await sessionOf(req.params.id, req.body?.rid);
    if (r.status !== 'in_progress' || r.currentPage !== req.body.page) {
      return { ...stateOf(survey, r, panels), resynced: true };
    }
    const { errors, pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers, true);
    // Файлы должны быть загружены именно в эту анкету
    for (const q of page.questions) {
      if (q.type !== 'file' || !pageAnswers[q.id]) continue;
      if (fileIds(pageAnswers[q.id].v).some((id) => !uploadPath(ownerOf(r), r.id, id))) errors[q.id] = 'Файл не найден – загрузите его ещё раз';
    }
    if (Object.keys(errors).length) return reply.code(422).send({ errors });

    // Согласие: время ответа ставит сервер — это подтверждение для проверки
    for (const q of page.questions) if (q.type === 'consent' && pageAnswers[q.id]) pageAnswers[q.id] = { ...pageAnswers[q.id], o: { at: new Date().toISOString() } };
    const answers = mergePage(r.answers, page, pageAnswers);
    const visited = [...r.history, page.id];
    // Время на экране: с момента его показа (последнее обновление сессии), при возврате — суммируется
    const spent = Math.min(3600, Math.max(0, Math.round((Date.now() - Date.parse(r.updatedAt)) / 1000)));
    const timings = { ...r.timings, [page.id]: (r.timings?.[page.id] ?? 0) + spent };
    await responses.update(r.id, { timings });
    // Навигация — по ответам с учётом действий «после ответа» (переменные)
    const nav = ctxOf(survey, r, cleanAnswers(ctxOf(survey, r, answers), visited));
    const quality = qualityCheck(nav, page.questions, req.body.hp, r.flags ?? []);
    // Открытые ответы: вставка, ввод без набора, признаки ИИ, совпадение с ответом другого респондента
    {
      for (const q of page.questions) {
        const text = q.type === 'text' ? pageAnswers[q.id]?.v : undefined;
        if (typeof text !== 'string') continue;
        const tm = req.body.tm?.[q.id];
        const stat = tm && Number.isFinite(tm.k) && Number.isFinite(tm.p) ? { k: Number(tm.k), p: Number(tm.p) } : undefined;
        const found = textFlags(q.id, text, stat);
        if (r.projectId && !r.isTest && text.trim().length >= 20 && (await responses.sameText(r.projectId, q.id, text.trim(), r.id))) found.push(`duptext:${q.id}`);
        // Пометки этого вопроса пересчитываются при повторной отправке экрана
        quality.flags = [...quality.flags.filter((f) => !f.endsWith(`:${q.id}`) || /^(attention|straightline):/.test(f)), ...found];
      }
    }
    if (JSON.stringify(quality.flags) !== JSON.stringify(r.flags ?? [])) {
      await responses.update(r.id, { flags: quality.flags });
      r.flags = quality.flags;
    }
    const next = nextPage(nav, page.id);
    // Отказ от согласия на обработку данных — анкета завершается отсевом
    const declined = page.questions.find((q) => q.type === 'consent' && pageAnswers[q.id]?.v === 0);
    if (declined?.type === 'consent') {
      await finalize(survey, r, answers, visited, 'screened_out', declined.declineMessage ? { message: declined.declineMessage } : null);
    } else if (quality.screenout) {
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
  });

  // Загрузка файла для вопроса текущего экрана: проверяются тип (по содержимому), размер и число файлов
  app.post<{ Params: { id: string }; Querystring: { rid?: string; q?: string }; Body: Buffer }>('/api/s/:id/upload', async (req) => {
    const { survey, r } = await sessionOf(req.params.id, req.query.rid);
    if (r.status !== 'in_progress' || !r.currentPage) fail(400, 'Анкета уже завершена');
    const page = findPage(ctxOf(survey, r, r.answers).survey, r.currentPage) ?? findPage(expandAllLoops(survey), r.currentPage);
    const q = page?.questions.find((x) => x.id === req.query.q);
    if (!q || q.type !== 'file') fail(400, 'Вопрос не найден');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) fail(400, 'Пустой файл');
    const maxMb = q.maxSizeMb ?? 10;
    if (buf.length > maxMb * 1024 * 1024) fail(413, `Файл больше ${maxMb} МБ`);
    let name = 'файл';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'файл')).replace(/[\r\n"\\/]/g, '_').slice(0, 200) || 'файл'; } catch { /* имя не важно */ }
    const ext = detectType(buf, name);
    const imagesOnly = (q.accept ?? 'image') === 'image';
    const allowed = imagesOnly ? (IMAGE_EXT as readonly string[]) : Object.keys(MIME);
    if (!ext || !allowed.includes(ext)) {
      fail(415, imagesOnly ? 'Можно загрузить только фото или картинку (JPG, PNG, WEBP, GIF, HEIC)' : 'Такой тип файла не поддерживается');
    }
    if (countUploads(ownerOf(r), r.id) >= 30) fail(429, 'Слишком много файлов');
    const id = saveUpload(ownerOf(r), r.id, buf, ext);
    return { id, name, size: buf.length, type: MIME[ext] };
  });

  // Свой файл — для миниатюры при возврате к вопросу
  app.get<{ Params: { id: string }; Querystring: { rid?: string; f?: string } }>('/api/s/:id/file', async (req, reply) => {
    const loaded = await loadSession(req.params.id, String(req.query.rid ?? ''));
    const path = found(loaded ? uploadPath(ownerOf(loaded.r), loaded.r.id, String(req.query.f ?? '')) : null, 'Файл не найден');
    return sendUpload(reply, path, 'private, max-age=3600');
  });

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>('/api/s/:id/back', async (req) => {
    const { survey, r, panels } = await sessionOf(req.params.id, req.body?.rid);
    if (r.status !== 'in_progress' || !settingsOf(survey).allowBack || r.history.length === 0 || r.currentPage !== req.body.page) {
      return stateOf(survey, r, panels);
    }
    // Сохраняем то, что уже введено на странице, чтобы не потерять при возврате
    const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
    await responses.update(r.id, {
      answers: mergePage(r.answers, page, pageAnswers), history: r.history.slice(0, -1), currentPage: r.history[r.history.length - 1],
    });
    return stateOf(survey, (await responses.get(r.id))!, panels);
  });

  app.post<{ Params: { id: string }; Body: { rid: string; page: string; answers?: Answers } }>('/api/s/:id/finish', async (req) => {
    const { survey, r, panels } = await sessionOf(req.params.id, req.body?.rid);
    if (r.status !== 'in_progress' || !settingsOf(survey).allowEarlyFinish || !r.currentPage) return stateOf(survey, r, panels);
    const { pageAnswers, page } = checkPage(survey, r, r.currentPage, req.body.answers ?? {}, false);
    await finalize(survey, r, mergePage(r.answers, page, pageAnswers), [...r.history, page.id], 'terminated');
    return stateOf(survey, (await responses.get(r.id))!, panels);
  });
}
