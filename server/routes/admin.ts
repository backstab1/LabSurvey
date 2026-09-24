import type { FastifyInstance } from 'fastify';
import { checkPassword, clearSession, isAdmin, loginBlocked, loginFailed, requireAdmin, setSession, testToken } from '../auth.ts';
import { responses, surveys, type NotifyConfig, type SheetsConfig, type SurveyStatus } from '../db.ts';
import { buildTable } from '../export/table.ts';
import { writeXlsx } from '../export/xlsx.ts';
import { writeSav } from '../export/sav.ts';
import { queueFullSync, sheetsStatus } from '../sheets.ts';
import { simulate } from '../simulate.ts';
import { quotaCounts, resetQuotas } from '../quotas.ts';
import { buildReport } from '../../shared/report.ts';
import { send, telegramConfigured } from '../notify.ts';
import { validateSurvey } from '../../shared/validate.ts';
import { migrateSurvey } from '../../shared/migrate.ts';
import type { Condition, Survey } from '../../shared/types.ts';
import { evalCondition } from '../../shared/logic.ts';
import type { ResponseStatus } from '../../shared/variables.ts';

/** Черновик можно сохранить с ошибками логики, но не с поломанной структурой */
function draftShapeOk(def: unknown): boolean {
  const d = def as Survey;
  return !!d && typeof d === 'object' && typeof d.title === 'string' && Array.isArray(d.blocks) && d.blocks.length > 0
    && d.blocks.every((b) => b && typeof b === 'object' && Array.isArray(b.questions));
}

const ALL_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'terminated', 'overquota', 'in_progress'];

export function blankSurvey(title = 'Новая анкета'): Survey {
  return {
    formatVersion: 2,
    title,
    settings: { showProgress: true, allowBack: true, allowEarlyFinish: false },
    blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Первый вопрос', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
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
    if (loginBlocked(req.ip)) return reply.code(429).send({ error: 'Слишком много неудачных попыток. Подождите 15 минут.' });
    if (!checkPassword(String(login ?? ''), String(password ?? ''))) {
      loginFailed(req.ip);
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
      const def = req.body?.definition !== undefined ? migrateSurvey(req.body.definition) : blankSurvey(req.body?.title);
      const v = validateSurvey(def);
      if (!draftShapeOk(def)) return reply.code(422).send(v);
      const s = await surveys.create(def as Survey);
      return { id: s.id, errors: v.errors, warnings: v.warnings };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      // Прогресс квот опубликованной версии
      const live = s.published;
      const counts = live?.quotas?.length ? await quotaCounts(s.id, live, false) : null;
      const quotas = (live?.quotas ?? []).map((q) => ({ id: q.id, title: q.title, limit: q.limit, count: counts?.get(q.id) ?? 0 }));
      return { ...s, counts: await responses.counts(s.id), sheetsAccount: sheetsStatus(), testToken: testToken(s.id), quotas, telegramConfigured: telegramConfigured() };
    });

    priv.put<{ Params: { id: string }; Body: { definition: unknown } }>('/api/admin/surveys/:id', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const def = migrateSurvey(req.body?.definition);
      const v = validateSurvey(def);
      if (!draftShapeOk(def)) return reply.code(422).send(v);
      await surveys.saveDraft(s.id, def as Survey);
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
      if (status === 'active' && s.archived) return reply.code(400).send({ error: 'Сначала верните анкету из архива' });
      await surveys.setStatus(s.id, status);
      return { ok: true };
    });

    priv.post<{ Params: { id: string }; Body: { archived: boolean } }>('/api/admin/surveys/:id/archive', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      await surveys.setArchived(s.id, !!req.body?.archived);
      return { ok: true };
    });

    // История опубликованных версий: просмотр и возврат версии в черновик
    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id/versions', async (req) => surveys.versions(req.params.id));

    priv.get<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v', async (req, reply) => {
      const def = await surveys.version(req.params.id, Number(req.params.v));
      if (!def) return reply.code(404).send({ error: 'Версия не найдена' });
      return def;
    });

    priv.post<{ Params: { id: string; v: string } }>('/api/admin/surveys/:id/versions/:v/restore', async (req, reply) => {
      const def = await surveys.version(req.params.id, Number(req.params.v));
      if (!def) return reply.code(404).send({ error: 'Версия не найдена' });
      await surveys.saveDraft(req.params.id, def);
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

    priv.delete<{ Params: { id: string } }>('/api/admin/surveys/:id/test-responses', async (req) => {
      resetQuotas(req.params.id);
      return { deleted: await responses.deleteTest(req.params.id) };
    });

    // Тестовое заполнение черновика случайными ответами по логике анкеты
    priv.post<{ Params: { id: string }; Body: { count?: number } }>('/api/admin/surveys/:id/simulate', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const v = validateSurvey(s.draft);
      if (!v.ok) return reply.code(422).send({ error: 'Сначала исправьте ошибки в анкете', ...v });
      const count = Math.min(Math.max(Number(req.body?.count) || 20, 1), 500);
      return { count, stats: await simulate(s.id, s.draft, s.version, count) };
    });

    priv.get<{ Params: { id: string; rid: string } }>('/api/admin/surveys/:id/responses/:rid', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      const r = await responses.get(req.params.rid);
      if (!s || !r || r.surveyId !== s.id) return reply.code(404).send({ error: 'Ответ не найден' });
      return { response: r, survey: r.isTest ? s.draft : s.published ?? s.draft };
    });

    priv.delete<{ Params: { id: string; rid: string } }>('/api/admin/surveys/:id/responses/:rid', async (req, reply) => {
      const r = await responses.get(req.params.rid);
      if (!r || r.surveyId !== req.params.id) return reply.code(404).send({ error: 'Ответ не найден' });
      await responses.remove(r.id);
      resetQuotas(r.surveyId);
      return { ok: true };
    });

    priv.get<{ Params: { id: string } }>('/api/admin/surveys/:id/responses', async (req) => {
      const list = await responses.list(req.params.id, { includeTest: true });
      return list.slice(-200).reverse().map((r) => ({
        id: r.id, status: r.status, isTest: r.isTest, startedAt: r.startedAt, completedAt: r.completedAt,
        durationSec: r.durationSec, answered: Object.keys(r.answers).length, params: r.params,
      }));
    });

    // Отчёт: распределения ответов и места, где бросают анкету
    priv.get<{ Params: { id: string }; Querystring: { statuses?: string; test?: string; filter?: string } }>('/api/admin/surveys/:id/report', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const test = req.query.test === '1';
      const def = test ? s.draft : s.published ?? s.draft;
      const statuses = (req.query.statuses?.split(',').filter((x) => ALL_STATUSES.includes(x as ResponseStatus)) ?? ['completed']) as ResponseStatus[];
      // Подгруппа: условие как у showIf (по ответам и параметрам ссылки)
      let filter: Condition | undefined;
      if (req.query.filter) {
        try { filter = JSON.parse(req.query.filter); } catch { return reply.code(400).send({ error: 'Фильтр: некорректный JSON' }); }
      }
      const all = (await responses.list(s.id, { includeTest: test }))
        .filter((r) => r.isTest === test)
        .filter((r) => !filter || evalCondition(filter, { survey: def, answers: r.answers, params: r.params, seed: r.id }));
      const unfinished = all
        .filter((r) => r.status === 'in_progress' || r.status === 'terminated')
        .map((r) => ({ ...r, lastPage: r.status === 'in_progress' ? r.currentPage : r.history[r.history.length - 1] ?? null }));
      return buildReport(def, all.filter((r) => statuses.includes(r.status)), unfinished);
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

    priv.put<{ Params: { id: string }; Body: Partial<NotifyConfig> | null }>('/api/admin/surveys/:id/notify', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'Анкета не найдена' });
      const b = req.body ?? {};
      const webhookUrl = String(b.webhookUrl ?? '').trim() || undefined;
      if (webhookUrl && !/^https?:\/\/\S+$/i.test(webhookUrl)) return reply.code(400).send({ error: 'Адрес вебхука должен начинаться с http:// или https://' });
      const telegramChatId = String(b.telegramChatId ?? '').trim() || undefined;
      if (telegramChatId && !/^(-?\d+|@\w{4,})$/.test(telegramChatId)) return reply.code(400).send({ error: 'ID чата Telegram: число (например, -1001234567890) или @имя_канала' });
      const everyN = Math.max(0, Math.round(Number(b.everyN) || 0)) || undefined;
      const cfg: NotifyConfig | null = webhookUrl || telegramChatId
        ? { webhookUrl, telegramChatId, everyN, quotaFull: !!b.quotaFull, limitReached: !!b.limitReached, lastError: s.notify?.lastError ?? null, lastSentAt: s.notify?.lastSentAt }
        : null;
      await surveys.setNotify(s.id, cfg);
      return { ok: true, notify: cfg };
    });

    priv.post<{ Params: { id: string } }>('/api/admin/surveys/:id/notify/test', async (req, reply) => {
      const s = await surveys.get(req.params.id);
      if (!s?.notify) return reply.code(400).send({ error: 'Сначала сохраните вебхук или чат Telegram' });
      const error = await send(s.id, s.published?.title ?? s.title, s.notify, { kind: 'test' });
      return error ? reply.code(502).send({ error }) : { ok: true };
    });

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
