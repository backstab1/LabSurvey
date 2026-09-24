import type { FastifyInstance } from 'fastify';
import { checkPassword, clearSession, isAdmin, requireAdmin, setSession } from '../auth.ts';
import { responses, surveys, type SheetsConfig, type SurveyStatus } from '../db.ts';
import { buildTable } from '../export/table.ts';
import { writeXlsx } from '../export/xlsx.ts';
import { writeSav } from '../export/sav.ts';
import { queueFullSync, sheetsStatus } from '../sheets.ts';
import { validateSurvey } from '../../shared/validate.ts';
import type { Survey } from '../../shared/types.ts';
import type { ResponseStatus } from '../../shared/variables.ts';

/** Черновик можно сохранить с ошибками логики, но не с поломанной структурой */
function draftShapeOk(def: unknown): boolean {
  const d = def as Survey;
  return !!d && typeof d === 'object' && typeof d.title === 'string' && Array.isArray(d.pages) && d.pages.length > 0
    && d.pages.every((p) => p && typeof p === 'object' && Array.isArray(p.questions));
}

const ALL_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'terminated', 'in_progress'];

export function blankSurvey(title = 'Новая анкета'): Survey {
  return {
    formatVersion: 1,
    title,
    settings: { showProgress: true, allowBack: true, allowEarlyFinish: false },
    pages: [{ id: 'P1', questions: [{ id: 'Q1', type: 'single', text: 'Первый вопрос', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
  };
}

/** Имя файла для Content-Disposition (кириллица через RFC 5987) */
function attachment(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function adminRoutes(app: FastifyInstance) {
  app.post<{ Body: { login: string; password: string } }>('/api/admin/login', async (req, reply) => {
    const { login, password } = req.body ?? ({} as { login: string; password: string });
    if (!checkPassword(String(login ?? ''), String(password ?? ''))) {
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    setSession(reply, login);
    return { login };
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/admin/me', async (req) => ({ login: isAdmin(req) }));

  // Всё ниже — только для команды
  app.register(async (priv) => {
    priv.addHook('preHandler', requireAdmin);

    priv.get('/api/admin/surveys', async () => surveys.list());

    priv.post<{ Body: { definition?: unknown; title?: string } }>('/api/admin/surveys', async (req, reply) => {
      const def = req.body?.definition ?? blankSurvey(req.body?.title);
      const v = validateSurvey(def);
      if (!draftShapeOk(def)) return reply.code(422).send(v);
      const s = await surveys.create(def as Survey);
      return { id: s.id, errors: v.errors, warnings: v.warnings };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      return { ...s, counts: await responses.counts(s.id), sheetsAccount: sheetsStatus() };
    });

    priv.put<{ Params: { id: string }; Body: { definition: unknown } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const v = validateSurvey(req.body?.definition);
      if (!draftShapeOk(req.body?.definition)) return reply.code(422).send(v);
      await surveys.saveDraft(s.id, req.body.definition as Survey);
      return { ok: true, errors: v.errors, warnings: v.warnings };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/publish', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const v = validateSurvey(s.draft);
      if (!v.ok) return reply.code(422).send(v);
      const version = await surveys.publish(s.id);
      return { version };
    });

    priv.post<{ Params: { id: string }; Body: { status: SurveyStatus } }>('/api/admin/surveys/:id/status', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const status = req.body?.status;
      if (status !== 'active' && status !== 'closed') return reply.code(400).send({ error: 'Статус: active или closed' });
      if (status === 'active' && !s.published) return reply.code(400).send({ error: 'Сначала опубликуйте анкету' });
      await surveys.setStatus(s.id, status);
      return { ok: true };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/duplicate', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const copy = await surveys.create({ ...s.draft, title: `${s.draft.title} (копия)` });
      return { id: copy.id };
    });

    priv.delete<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req) => {
      await surveys.remove(req.params.id);
      return { ok: true };
    });

    priv.delete<{ Params: { id: string } }>('/api/admin/surveys/:id/test-responses', async (req) => ({
      deleted: await responses.deleteTest(req.params.id),
    }));

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id/responses', async (req) => {
      const list = await responses.list(req.params.id, { includeTest: true });
      return list.slice(-200).reverse().map((r) => ({
        id: r.id, status: r.status, isTest: r.isTest, startedAt: r.startedAt, completedAt: r.completedAt,
        durationSec: r.durationSec, answered: Object.keys(r.answers).length, params: r.params,
      }));
    });

    priv.get<{ Params: { id: string; format: string }; Querystring: { statuses?: string; test?: string } }>(
      '/api/admin/surveys/:id/export.:format',
      async (req, reply) => {
        const s = await surveys.get(req.params.id);
        if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
        const def = req.query.test === '1' ? s.draft : s.published ?? s.draft;
        const statuses = (req.query.statuses?.split(',').filter((x) => ALL_STATUSES.includes(x as ResponseStatus)) ?? ['completed']) as ResponseStatus[];
        const list = (await responses.list(s.id, { includeTest: req.query.test === '1', statuses }))
          .filter((r) => (req.query.test === '1' ? r.isTest : !r.isTest));
        const table = buildTable(def, list);
        const date = new Date().toISOString().slice(0, 10);
        const base = `${def.title.slice(0, 60)}_${date}${req.query.test === '1' ? '_test' : ''}`;
        if (req.params.format === 'xlsx') {
          reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          reply.header('Content-Disposition', attachment(`${base}.xlsx`));
          return reply.send(await writeXlsx(table, def.title));
        }
        if (req.params.format === 'sav') {
          reply.header('Content-Type', 'application/octet-stream');
          reply.header('Content-Disposition', attachment(`${base}.sav`));
          return reply.send(writeSav(table.vars, table.rows, def.title));
        }
        if (req.params.format === 'json') {
          reply.header('Content-Disposition', attachment(`${def.title.slice(0, 60)}.json`));
          return reply.send(JSON.stringify(s.draft, null, 2));
        }
        return reply.code(400).send({ error: 'Формат: xlsx, sav или json' });
      },
    );

    priv.put<{ Params: { id: string }; Body: Partial<SheetsConfig> | null }>('/api/admin/surveys/:id/sheets', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      if (!req.body || !req.body.spreadsheetId) {
        await surveys.setSheets(s.id, null);
        return { ok: true };
      }
      // Принимаем и полную ссылку на таблицу, и её ID
      const idMatch = String(req.body.spreadsheetId).match(/\/d\/([\w-]+)/);
      const cfg: SheetsConfig = {
        spreadsheetId: idMatch ? idMatch[1] : String(req.body.spreadsheetId).trim(),
        sheetName: String(req.body.sheetName || 'Ответы').slice(0, 90),
        auto: req.body.auto !== false,
        statuses: (req.body.statuses?.filter((x) => ALL_STATUSES.includes(x)) ?? ['completed']) as ResponseStatus[],
        values: req.body.values === 'codes' ? 'codes' : 'labels',
        lastSyncAt: s.sheets?.lastSyncAt,
        lastError: s.sheets?.lastError ?? null,
      };
      await surveys.setSheets(s.id, cfg);
      return { ok: true, sheets: cfg };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/sheets/sync', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s?.sheets) return reply.code(400).send({ error: 'Google Sheets не настроен для этой анкеты' });
      try {
        const n = await queueFullSync(s.id, s.sheets);
        await surveys.setSheets(s.id, { ...s.sheets, lastSyncAt: new Date().toISOString(), lastError: null });
        return { rows: n };
      } catch (e) {
        await surveys.setSheets(s.id, { ...s.sheets, lastError: (e as Error).message });
        return reply.code(502).send({ error: (e as Error).message });
      }
    });
  });
}
