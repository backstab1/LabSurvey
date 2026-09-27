// Данные проекта: ответы, файлы респондентов, отчёт, кросс-таблицы, выгрузки
import type { FastifyInstance } from 'fastify';
import { responses, type StoredResponse } from '../../db.ts';
import { defFor, loadProject, loadedOf, projectOf, type Loaded } from '../../projectCtx.ts';
import { resetQuotas } from '../../quotas.ts';
import { removeUploads, uploadPath } from '../../uploads.ts';
import { buildTable, cellToText } from '../../export/table.ts';
import { writeXlsx } from '../../export/xlsx.ts';
import { writeSav } from '../../export/sav.ts';
import { writeCrosstabXlsx, type Measure } from '../../export/crosstabXlsx.ts';
import {
  XLSX_TYPE, fail, found, isoDay, nextDayIso, parseStatuses, pickStatuses, sendDownload, sendUpload, toCsv,
} from '../../http.ts';
import { designTable } from '../../../shared/designExport.ts';
import { evalCondition, findQuestion } from '../../../shared/logic.ts';
import { buildCrosstabs, type CrosstabSpec } from '../../../shared/crosstab.ts';
import { buildReport } from '../../../shared/report.ts';
import { expandAllLoops } from '../../../shared/loops.ts';
import { PANEL_PARAM, type Condition, type Survey } from '../../../shared/types.ts';

type Params = { id: string };
type RespParams = { id: string; rid: string };

/** Ответ проекта или 404 */
async function responseOf(projectId: string, rid: string): Promise<StoredResponse> {
  const r = await responses.get(rid);
  if (!r || r.projectId !== projectId) fail(404, 'Ответ не найден');
  return r;
}

/** Условие-фильтр (как у showIf): по ответам и параметрам ссылки */
const matches = (filter: Condition | undefined, def: Survey) => (r: StoredResponse) =>
  !filter || evalCondition(filter, { survey: def, answers: r.answers, params: r.params, seed: r.id });

/** Ответы для отчётов и выгрузок: только тестовые или только настоящие */
async function listFor(l: Loaded, test: boolean, opts: Omit<Parameters<typeof responses.list>[1] & object, 'includeTest'> = {}) {
  return (await responses.list(l.project.id, { ...opts, includeTest: test })).filter((r) => r.isTest === test);
}

/** Спецификация кросс-таблиц из адреса */
function parseSpec(raw: string | undefined): CrosstabSpec {
  let s: CrosstabSpec;
  try { s = JSON.parse(raw ?? ''); } catch { fail(400, 'spec: некорректный JSON'); }
  const refOk = (x: unknown) => !!x && typeof x === 'object'
    && ((typeof (x as { q?: unknown }).q === 'string') || (typeof (x as { param?: unknown }).param === 'string'));
  if (!s || !Array.isArray(s.rows) || !Array.isArray(s.cols) || !s.rows.every(refOk) || !s.cols.every(refOk)) fail(400, 'spec: rows и cols — списки переменных');
  if (s.rows.length > 100 || s.cols.length > 10) fail(400, 'Не больше 100 строк и 10 переменных в шапке');
  return s;
}

async function crosstab(id: string, rawSpec: string | undefined) {
  const spec = parseSpec(rawSpec);
  const l = await loadedOf(id);
  const def = defFor(l, !!spec.test);
  const statuses = pickStatuses(spec.statuses) ?? ['completed'];
  const list = (await listFor(l, !!spec.test, { statuses: statuses.length ? statuses : ['completed'] })).filter(matches(spec.filter, def));
  return { l, spec, result: buildCrosstabs(expandAllLoops(def), spec, list) };
}

export async function dataRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>('/api/admin/projects/:id/responses', async (req) => {
    const list = await responses.list(req.params.id, { includeTest: true, includeRejected: true });
    return list.slice(-200).reverse().map((r) => ({
      id: r.id, status: r.status, isTest: r.isTest, rejected: r.rejected, startedAt: r.startedAt, completedAt: r.completedAt,
      durationSec: r.durationSec, answered: Object.keys(r.answers).length, params: r.params, flags: r.flags ?? [],
    }));
  });

  app.get<{ Params: RespParams }>('/api/admin/projects/:id/responses/:rid', async (req) => {
    const l = await loadProject(req.params.id);
    if (!l) fail(404, 'Ответ не найден');
    const r = await responseOf(l.project.id, req.params.rid);
    return { response: r, survey: defFor(l, r.isTest) };
  });

  app.post<{ Params: RespParams; Body: { rejected: boolean } }>('/api/admin/projects/:id/responses/:rid/reject', async (req) => {
    const r = await responseOf(req.params.id, req.params.rid);
    await responses.update(r.id, { rejected: !!req.body?.rejected });
    resetQuotas(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: RespParams }>('/api/admin/projects/:id/responses/:rid', async (req) => {
    const r = await responseOf(req.params.id, req.params.rid);
    await responses.remove(r.id);
    removeUploads(req.params.id, r.id);
    resetQuotas(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: Params }>('/api/admin/projects/:id/reject-suspect', async (req) => {
    await projectOf(req.params.id);
    const rejected = await responses.rejectSuspect(req.params.id);
    resetQuotas(req.params.id);
    return { rejected };
  });

  // Файл респондента (вопрос «Загрузка файла»): картинки открываются в браузере, документы скачиваются
  app.get<{ Params: RespParams & { file: string } }>('/api/admin/projects/:id/files/:rid/:file', async (req, reply) => {
    const r = await responses.get(req.params.rid);
    const path = found(r && r.projectId === req.params.id ? uploadPath(req.params.id, r.id, req.params.file) : null, 'Файл не найден');
    const name = Object.values(r!.answers).map((a) => a.o?.[req.params.file]).find(Boolean) ?? req.params.file;
    return sendUpload(reply, path, 'private, max-age=86400', name);
  });

  // Дизайн MaxDiff / конджойнта: показанные наборы и выборы, по строке на вариант (карточку)
  app.get<{ Params: Params; Querystring: { q?: string; statuses?: string; test?: string } }>('/api/admin/projects/:id/design.csv', async (req, reply) => {
    const l = await loadedOf(req.params.id);
    const test = req.query.test === '1';
    const def = expandAllLoops(defFor(l, test));
    const q = req.query.q ? findQuestion(def, req.query.q) : undefined;
    if (!q || (q.type !== 'maxdiff' && q.type !== 'conjoint')) fail(400, 'Укажите вопрос MaxDiff или конджойнт');
    const list = await listFor(l, test, { statuses: parseStatuses(req.query.statuses) });
    return sendDownload(reply, `${l.project.title.slice(0, 60)}_${q.id}_дизайн.csv`, 'text/csv; charset=utf-8', toCsv(designTable(q, list)));
  });

  app.get<{ Params: Params; Querystring: { spec?: string } }>('/api/admin/projects/:id/crosstab', async (req) =>
    (await crosstab(req.params.id, req.query.spec)).result);

  app.get<{ Params: Params; Querystring: { spec?: string; measures?: string } }>('/api/admin/projects/:id/crosstab.xlsx', async (req, reply) => {
    const { l, spec, result } = await crosstab(req.params.id, req.query.spec);
    const measures = (req.query.measures?.split(',').filter((m) => ['colPct', 'rowPct', 'count'].includes(m)) ?? ['colPct']) as Measure[];
    const sig = spec.sig === 0 ? 'значимость не проверялась' : `буквы — столбец значимо больше указанных (${Math.round((spec.sig ?? 0.95) * 100)}%, база от ${result.minBase})`;
    const note = `Анкет: ${result.total}${spec.test ? ' (тестовые)' : ''}${spec.filter ? ', подгруппа' : ''}; ${sig}`;
    const date = new Date().toISOString().slice(0, 10);
    return sendDownload(reply, `${l.project.title.slice(0, 60)}_таблицы_${date}.xlsx`, XLSX_TYPE,
      await writeCrosstabXlsx(result, l.project.title, measures.length ? measures : ['colPct'], note));
  });

  // Отчёт: распределения ответов и места, где бросают анкету
  app.get<{ Params: Params; Querystring: { statuses?: string; test?: string; filter?: string } }>('/api/admin/projects/:id/report', async (req) => {
    const l = await loadedOf(req.params.id);
    const test = req.query.test === '1';
    const def = defFor(l, test);
    const statuses = parseStatuses(req.query.statuses);
    let filter: Condition | undefined;
    if (req.query.filter) {
      try { filter = JSON.parse(req.query.filter); } catch { fail(400, 'Фильтр: некорректный JSON'); }
    }
    const all = (await listFor(l, test)).filter(matches(filter, def));
    const unfinished = all
      .filter((r) => r.status === 'in_progress' || r.status === 'terminated')
      .map((r) => ({ ...r, lastPage: r.status === 'in_progress' ? r.currentPage : r.history[r.history.length - 1] ?? null }));
    return buildReport(expandAllLoops(def), all.filter((r) => statuses.includes(r.status)), unfinished);
  });

  app.get<{ Params: Params & { format: string }; Querystring: { statuses?: string; test?: string; from?: string; to?: string; timings?: string; rejected?: string; panel?: string } }>(
    '/api/admin/projects/:id/export.:format',
    async (req, reply) => {
      const l = await loadedOf(req.params.id);
      const q = req.query;
      const test = q.test === '1';
      const def = defFor(l, test);
      // Даты — дни в формате YYYY-MM-DD (по UTC-границам суток сервера); to — включительно
      const from = isoDay(q.from);
      const to = isoDay(q.to);
      const list = (await listFor(l, test, {
        statuses: parseStatuses(q.statuses), includeRejected: q.rejected === '1',
        from: from ? `${from}T00:00:00` : undefined, to: to ? nextDayIso(to).slice(0, 19) : undefined,
      }))
        // Панель: код или «-» — пришедшие без панели
        .filter((r) => !q.panel || (q.panel === '-' ? !r.params[PANEL_PARAM] : r.params[PANEL_PARAM] === q.panel));
      const table = buildTable(def, list, { timings: q.timings === '1' });
      const date = new Date().toISOString().slice(0, 10);
      const base = `${l.project.title.slice(0, 60)}_${date}${test ? '_test' : ''}`;
      switch (req.params.format) {
        case 'xlsx':
          return sendDownload(reply, `${base}.xlsx`, XLSX_TYPE, await writeXlsx(table, def.title));
        case 'sav':
          return sendDownload(reply, `${base}.sav`, 'application/octet-stream', writeSav(table.vars, table.rows, def.title));
        case 'csv':
          // Для русского Excel значения — коды
          return sendDownload(reply, `${base}.csv`, 'text/csv; charset=utf-8',
            toCsv([table.vars.map((v) => v.name), ...table.rows.map((row) => row.map((c, i) => cellToText(table.vars[i], c)))]));
        default:
          fail(400, 'Формат: xlsx, sav или csv');
      }
    },
  );
}
