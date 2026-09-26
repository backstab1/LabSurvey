// Проект вместе с его анкетой: опубликованная версия и черновик с настройками сбора и квотами проекта
import { projects, surveys, type ProjectRow, type SurveyRow } from './db.ts';
import { effectiveSurvey, type Survey } from '../shared/types.ts';

export interface Loaded {
  project: ProjectRow;
  survey: SurveyRow;
  /** Опубликованная анкета с настройками проекта (null — не опубликована) */
  live: Survey | null;
  /** Черновик с настройками проекта — для тестовых прохождений */
  draft: Survey;
}

export async function loadProject(id: string): Promise<Loaded | null> {
  const project = await projects.get(id);
  if (!project) return null;
  const survey = await surveys.get(project.surveyId);
  if (!survey) return null;
  return {
    project, survey,
    live: survey.published ? effectiveSurvey(survey.published, project) : null,
    draft: effectiveSurvey(survey.draft, project),
  };
}

/** Анкета для ответа: тестовые — по черновику, настоящие — по опубликованной версии */
export const defFor = (l: Loaded, isTest: boolean): Survey => (isTest ? l.draft : l.live ?? l.draft);
