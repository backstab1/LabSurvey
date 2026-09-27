// Проекты: сбор ответов по анкете — настройки, квоты, панели, статус, тестовые ответы
import type { FastifyInstance } from 'fastify';
import { testToken } from '../../auth.ts';
import { invitees, projects, responses, surveys, type ProjectRow, type TableSet } from '../../db.ts';
import { loadProject, projectOf, loadedOf, type Loaded } from '../../projectCtx.ts';
import { quotaCounts, resetQuotas } from '../../quotas.ts';
import { sheetsStatus } from '../../sheets.ts';
import { telegramConfigured } from '../../notify.ts';
import { dailyStats } from '../../daily.ts';
import { simulate } from '../../simulate.ts';
import { removeUploads } from '../../uploads.ts';
import { fail } from '../../http.ts';
import type { ProjectInfo, ProjectListItem } from '../../../shared/api.ts';
import { validatePanels, validateSurvey } from '../../../shared/validate.ts';
import {
  PROJECT_SETTING_KEYS, effectiveSurvey, type Panel, type ProjectSettings, type ProjectStatus, type Quota, type Survey,
} from '../../../shared/types.ts';

const PROJECT_STATUSES: ProjectStatus[] = ['development', 'collecting', 'processing', 'archive'];

/** Только настройки сбора (остальные ключи анкеты в проекте не хранятся) */
function projectSettings(src: Partial<Record<string, unknown>> | undefined): ProjectSettings {
  const out: Record<string, unknown> = {};
  for (const k of PROJECT_SETTING_KEYS) if (src?.[k] !== undefined) out[k] = src[k];
  return out as ProjectSettings;
}

/** Сколько квот набрано — по опубликованной версии анкеты */
async function fullQuotas(p: ProjectRow): Promise<number> {
  if (!p.quotas.length) return 0;
  const l = await loadProject(p.id);
  if (!l?.live) return 0;
  const counts = await quotaCounts(p.id, l.live, false);
  return p.quotas.filter((q) => (counts.get(q.id) ?? 0) >= q.limit).length;
}

/** Всё о проекте для страницы проекта */
async function projectInfo(l: Loaded): Promise<ProjectInfo> {
  const { project: p, survey: s } = l;
  const counts = l.live && p.quotas.length ? await quotaCounts(p.id, l.live, false) : null;
  return {
    id: p.id, title: p.title, status: p.status, settings: p.settings, quotaDefs: p.quotas, panels: p.panels, tableSets: p.tables,
    panelCounts: await responses.countsByPanel(p.id),
    quotas: p.quotas.map((q) => ({ id: q.id, title: q.title, limit: q.limit, count: counts?.get(q.id) ?? 0 })),
    survey: {
      id: s.id, title: s.draft.title, version: s.version, published: !!s.published,
      unpublished: !s.published || JSON.stringify(s.published) !== JSON.stringify(s.draft),
    },
    // Анкета с настройками проекта: для отчёта, данных и условий квот
    draft: l.draft, published: l.live,
    sheets: p.sheets, notify: p.notify, counts: await responses.counts(p.id),
    sheetsAccount: sheetsStatus(), testToken: testToken(p.id), telegramConfigured: telegramConfigured(),
    daily: dailyStats(await responses.timeline(p.id)),
    invitees: await invitees.count(p.id),
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

/** Заказчику — без служебного: тестовой ссылки, интеграций, пароля и адресов возврата панелей */
function forClient(info: ProjectInfo): ProjectInfo {
  const { password: _pw, ...settings } = info.settings;
  return {
    ...info, settings, testToken: '', sheets: null, notify: null, sheetsAccount: { configured: false, email: null }, telegramConfigured: false,
    panels: info.panels.map((x) => ({ id: x.id, title: x.title, limit: x.limit, closed: x.closed })),
  };
}

const tablesOk = (list: unknown): list is TableSet[] => Array.isArray(list) && list.length <= 50
  && list.every((t) => t && typeof t.name === 'string' && t.name.trim() && t.spec && Array.isArray(t.spec.rows) && Array.isArray(t.spec.cols));

export async function projectsRoutes(app: FastifyInstance) {
  app.get('/api/admin/projects', async (req): Promise<ProjectListItem[]> => {
    const u = req.user!;
    const list = (await projects.list()).filter((p) => u.role !== 'client' || (u.projects ?? []).includes(p.id));
    return Promise.all(list.map(async (p) => ({
      id: p.id, title: p.title, status: p.status, surveyId: p.surveyId, surveyTitle: p.surveyTitle, counts: p.counts,
      panels: p.panels.length,
      maxResponses: p.settings.maxResponses ?? null, openFrom: p.settings.openFrom ?? null, closeAt: p.settings.closeAt ?? null,
      quotas: p.quotas.length, quotasFull: await fullQuotas(p), createdAt: p.createdAt, updatedAt: p.updatedAt,
    })));
  });

  app.post<{ Body: { surveyId?: string; title?: string } }>('/api/admin/projects', async (req) => {
    const s = req.body?.surveyId ? await surveys.get(req.body.surveyId) : null;
    if (!s) fail(400, 'Выберите анкету для проекта');
    const title = String(req.body?.title ?? '').trim() || s.draft.title;
    const p = await projects.create({ title: title.slice(0, 200), surveyId: s.id });
    // Настройки сбора и квоты, если они пришли в JSON анкеты (импорт, анкета от ИИ), становятся стартовыми настройками проекта
    const src = s.published ?? s.draft;
    const seeded = projectSettings(src.settings as Record<string, unknown> | undefined);
    if (Object.keys(seeded).length || src.quotas?.length) {
      await projects.update(p.id, { settings: seeded, quotas: src.quotas ?? [] });
    }
    return { id: p.id };
  });

  app.get<{ Params: { id: string } }>('/api/admin/projects/:id', async (req) => {
    const info = await projectInfo(await loadedOf(req.params.id));
    return req.user!.role === 'client' ? forClient(info) : info;
  });

  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/admin/projects/:id/copy', async (req) => {
    const p = await projectOf(req.params.id);
    const title = String(req.body?.title ?? '').trim() || `${p.title} (копия)`;
    const copy = await projects.copy(p.id, title.slice(0, 200));
    return { id: copy.id };
  });

  app.put<{ Params: { id: string }; Body: { title?: string; surveyId?: string; settings?: ProjectSettings; quotas?: Quota[]; panels?: Panel[]; tables?: TableSet[] } }>(
    '/api/admin/projects/:id',
    async (req) => {
      const l = await loadedOf(req.params.id);
      const b = req.body ?? {};
      const patch: Parameters<typeof projects.update>[1] = {};
      if (b.title !== undefined) {
        const title = String(b.title).trim();
        if (!title) fail(400, 'Укажите название проекта');
        patch.title = title.slice(0, 200);
      }
      let survey = l.survey;
      if (b.surveyId !== undefined && b.surveyId !== l.survey.id) {
        const s = await surveys.get(b.surveyId);
        if (!s) fail(400, 'Анкета не найдена');
        if (l.project.status === 'collecting') fail(400, 'Во время сбора анкету проекта менять нельзя — сначала остановите сбор');
        patch.surveyId = s.id;
        survey = s;
      }
      if (b.settings !== undefined) patch.settings = projectSettings(b.settings as Record<string, unknown>);
      if (b.quotas !== undefined) {
        if (!Array.isArray(b.quotas)) fail(400, 'quotas: ожидается массив');
        patch.quotas = b.quotas;
      }
      if (b.panels !== undefined) {
        const errs = validatePanels(b.panels);
        if (errs.length) fail(422, errs.join('; '));
        patch.panels = b.panels;
      }
      if (b.tables !== undefined) {
        if (!tablesOk(b.tables)) fail(400, 'Наборы таблиц: список {name, spec} (не больше 50)');
        patch.tables = b.tables.map((t) => ({ name: t.name.trim().slice(0, 100), spec: t.spec }));
      }
      // Настройки и квоты проверяются вместе с анкетой — условия квот ссылаются на её вопросы
      const next = { settings: patch.settings ?? l.project.settings, quotas: patch.quotas ?? l.project.quotas };
      const v = validateSurvey(effectiveSurvey((survey.published ?? survey.draft) as Survey, next));
      const own = v.errors.filter((e) => e.where.startsWith('settings.') || e.where.startsWith('квота'));
      if (own.length) fail(422, own.map((e) => `${e.where}: ${e.message}`).join('; '), { errors: own });
      await projects.update(l.project.id, patch);
      if (patch.quotas || patch.surveyId) resetQuotas(l.project.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { status: ProjectStatus } }>('/api/admin/projects/:id/status', async (req) => {
    const l = await loadedOf(req.params.id);
    const status = req.body?.status;
    if (!PROJECT_STATUSES.includes(status)) fail(400, 'Статус: development, collecting, processing или archive');
    if (status === 'collecting' && !l.live) fail(400, 'Сначала опубликуйте анкету проекта');
    await projects.update(l.project.id, { status });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/projects/:id', async (req) => {
    await projects.remove(req.params.id);
    removeUploads(req.params.id);
    resetQuotas(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/projects/:id/test-responses', async (req) => {
    resetQuotas(req.params.id);
    for (const r of (await responses.list(req.params.id, { includeTest: true, includeRejected: true })).filter((x) => x.isTest)) removeUploads(req.params.id, r.id);
    return { deleted: await responses.deleteTest(req.params.id) };
  });

  // Тестовое заполнение черновика анкеты случайными ответами по логике — в проект, как тестовые ответы
  app.post<{ Params: { id: string }; Body: { count?: number } }>('/api/admin/projects/:id/simulate', async (req) => {
    const l = await loadedOf(req.params.id);
    const v = validateSurvey(l.draft);
    if (!v.ok) fail(422, 'Сначала исправьте ошибки в анкете', { ...v });
    const count = Math.min(Math.max(Number(req.body?.count) || 20, 1), 500);
    return { count, stats: await simulate(l.project.id, l.survey.id, l.draft, l.survey.version, count) };
  });
}
