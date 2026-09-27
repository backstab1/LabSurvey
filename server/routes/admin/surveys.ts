// Анкеты (конструктор): черновик, публикация, версии, копии, экспорт JSON
import type { FastifyInstance } from 'fastify';
import { testToken } from '../../auth.ts';
import { projects, surveys } from '../../db.ts';
import { fail, failWith, found, sendDownload } from '../../http.ts';
import { draftShapeOk, validateSurvey } from '../../../shared/validate.ts';
import { migrateSurvey } from '../../../shared/migrate.ts';
import type { Survey } from '../../../shared/types.ts';

export function blankSurvey(title = 'Новая анкета'): Survey {
  return {
    formatVersion: 2,
    title,
    settings: { showProgress: true, allowBack: true, allowEarlyFinish: false },
    blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Первый вопрос', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
  };
}

const NOT_FOUND = 'Анкета не найдена';
const surveyOf = async (id: string) => found(await surveys.get(id), NOT_FOUND);

/** Анкета для сохранения; поломанная структура — 422 с результатом проверки */
function checkedDraft(def: unknown) {
  const v = validateSurvey(def);
  if (!draftShapeOk(def)) failWith(422, v);
  return { def: def as Survey, v };
}

export async function surveysRoutes(app: FastifyInstance) {
  app.get('/api/admin/surveys', async () => surveys.list());

  app.post<{ Body: { definition?: unknown; title?: string } }>('/api/admin/surveys', async (req) => {
    const { def, v } = checkedDraft(req.body?.definition !== undefined ? migrateSurvey(req.body.definition) : blankSurvey(req.body?.title));
    const s = await surveys.create(def);
    return { id: s.id, errors: v.errors, warnings: v.warnings };
  });

  app.get<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req) => {
    const s = await surveyOf(req.params.id);
    const used = (await projects.bySurvey(s.id)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
    return { ...s, testToken: testToken(s.id), projects: used };
  });

  app.put<{ Params: { id: string }; Body: { definition: unknown } }>('/api/admin/surveys/:id', async (req) => {
    const s = await surveyOf(req.params.id);
    const { def, v } = checkedDraft(migrateSurvey(req.body?.definition));
    await surveys.saveDraft(s.id, def);
    return { ok: true, errors: v.errors, warnings: v.warnings };
  });

  app.post<{ Params: { id: string } }>('/api/admin/surveys/:id/publish', async (req) => {
    const s = await surveyOf(req.params.id);
    const v = validateSurvey(s.draft);
    if (!v.ok) failWith(422, v);
    return { version: await surveys.publish(s.id, req.user!.login) };
  });

  app.post<{ Params: { id: string }; Body: { archived: boolean } }>('/api/admin/surveys/:id/archive', async (req) => {
    const s = await surveyOf(req.params.id);
    await surveys.setArchived(s.id, !!req.body?.archived);
    return { ok: true };
  });

  // История опубликованных версий: просмотр и возврат версии в черновик
  app.get<{ Params: { id: string } }>('/api/admin/surveys/:id/versions', async (req) => surveys.versions(req.params.id));

  app.get<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v', async (req) =>
    found(await surveys.version(req.params.id, Number(req.params.v)), 'Версия не найдена'));

  app.post<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v/restore', async (req) => {
    const def = found(await surveys.version(req.params.id, Number(req.params.v)), 'Версия не найдена');
    await surveys.saveDraft(req.params.id, def);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/surveys/:id/duplicate', async (req) => {
    const s = await surveyOf(req.params.id);
    const copy = await surveys.create({ ...s.draft, title: `${s.draft.title} (копия)` });
    return { id: copy.id };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req) => {
    const used = await projects.bySurvey(req.params.id);
    if (used.length) {
      fail(400, `Анкета используется в проектах: ${used.map((p) => `«${p.title}»`).join(', ')}. Сначала удалите проекты или выберите в них другую анкету.`);
    }
    await surveys.remove(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/admin/surveys/:id/export.json', async (req, reply) => {
    const s = await surveyOf(req.params.id);
    return sendDownload(reply, `${s.draft.title.slice(0, 60)}.json`, 'application/json; charset=utf-8', JSON.stringify(s.draft, null, 2));
  });
}
