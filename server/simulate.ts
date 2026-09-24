// Тестовое заполнение: «боты» проходят черновик анкеты по логике и сохраняют ответы как тестовые.
import { responses } from './db.ts';
import { fullQuota, noteCompleted } from './quotas.ts';
import { actionError, cleanAnswers, findPage, firstPage, isQuestionVisible, nextPage } from '../shared/logic.ts';
import { randomAnswer } from '../shared/simulate.ts';
import { END, SCREENOUT, type Answers, type RespondentContext, type Survey } from '../shared/types.ts';
import type { ResponseStatus } from '../shared/variables.ts';

export async function simulate(surveyId: string, survey: Survey, version: number, count: number) {
  const stats: Record<string, number> = {};
  for (let n = 0; n < count; n++) {
    const started = new Date(Date.now() - Math.floor(Math.random() * 3600_000));
    const r = await responses.create({
      surveyId, version, status: 'in_progress', isTest: true, answers: {}, history: [], currentPage: null,
      params: { source: 'simulation' }, ip: null, userAgent: 'SurveyLAB simulation', startedAt: started.toISOString(),
    });
    const ctxOf = (answers: Answers): RespondentContext => ({ survey, answers, params: r.params, seed: r.id });

    let answers: Answers = {};
    const visited: string[] = [];
    let page = firstPage(ctxOf(cleanAnswers(ctxOf(answers), [])));
    let guard = 0;
    let overquota = false;
    while (page !== END && page !== SCREENOUT && guard++ < 1000) {
      const nav = cleanAnswers(ctxOf(answers), visited);
      const working: Answers = { ...nav };
      for (const q of findPage(survey, page)!.questions) {
        if (q.type === 'hidden' || !isQuestionVisible(ctxOf(working), q)) continue;
        // Несколько попыток, чтобы не упереться в действие «показать ошибку»
        for (let attempt = 0; attempt < 5; attempt++) {
          const a = randomAnswer(ctxOf(working), q);
          const trial = { ...working };
          if (a) trial[q.id] = a; else delete trial[q.id];
          if (!actionError(ctxOf(trial), q) || attempt === 4) {
            if (a) working[q.id] = a;
            break;
          }
        }
      }
      answers = { ...answers, ...working };
      visited.push(page);
      const navCtx = ctxOf(cleanAnswers(ctxOf(answers), visited));
      page = nextPage(navCtx, page);
      // Квоты — как у настоящих респондентов (по тестовым ответам)
      if (page !== SCREENOUT && (await fullQuota(surveyId, survey, true, navCtx))) { overquota = true; break; }
    }
    const status: ResponseStatus = overquota ? 'overquota' : page === SCREENOUT ? 'screened_out' : 'completed';
    const duration = 60 + Math.floor(Math.random() * 600);
    await responses.update(r.id, {
      answers: cleanAnswers(ctxOf(answers), visited), history: visited, currentPage: null, status,
      completedAt: new Date(started.getTime() + duration * 1000).toISOString(), durationSec: duration,
    });
    if (status === 'completed') noteCompleted(surveyId, survey, true, ctxOf(cleanAnswers(ctxOf(answers), visited)));
    stats[status] = (stats[status] ?? 0) + 1;
  }
  return stats;
}
