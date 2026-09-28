// Ответы респондентов: сессии прохождения, выборки для выгрузок, счётчики по статусам и панелям
import type { Param, Row } from '../sql.ts';
import { enc, flag, jsonGet, jsonKey, marks, median, newId, now, parseJson, pg, sql, updateRow } from './connection.ts';
import { PANEL_PARAM, type Answers } from '../../shared/types.ts';
import { SUSPECT_SCORE, qualityScore } from '../../shared/quality.ts';
import type { ResponseRecord, ResponseStatus } from '../../shared/variables.ts';
import type { PanelCounts, ResponseCounts } from '../../shared/api.ts';
export type { PanelCounts };

export interface StoredResponse extends ResponseRecord {
  /** Проект; null — предпросмотр анкеты из конструктора (вне проекта) */
  projectId: string | null;
  /** Анкета */
  surveyId: string;
  /** Своё сообщение / редирект из сработавшего действия «Завершить» или «Отсеять» */
  ending?: { message?: string; redirect?: string } | null;
  history: string[];
  currentPage: string | null;
  updatedAt: string;
  /** Отпечаток устройства (хеш) — для проверки повторного прохождения */
  device?: string | null;
  /** Результат постбэка панели */
  postback?: PostbackResult | null;
}

/** Постбэк панели: статус, когда отправлен, успешно ли и ошибка */
export interface PostbackResult { status: string; at: string; ok: boolean; error?: string }

export interface ResponsePatch {
  answers?: Answers; history?: string[]; currentPage?: string | null; status?: ResponseStatus;
  completedAt?: string | null; durationSec?: number | null; version?: number;
  ending?: { message?: string; redirect?: string } | null;
  timings?: Record<string, number>; rejected?: boolean; flags?: string[]; postback?: PostbackResult | null;
}

const toResponse = (r: Row): StoredResponse => ({
  id: r.id as string,
  projectId: (r.project_id as string) ?? null,
  surveyId: r.survey_id as string,
  version: r.version as number,
  status: r.status as ResponseStatus,
  isTest: r.is_test === 1,
  answers: JSON.parse(r.answers as string),
  history: JSON.parse(r.history as string),
  currentPage: (r.current_page as string) ?? null,
  params: JSON.parse(r.params as string),
  ip: (r.ip as string) ?? null,
  userAgent: (r.user_agent as string) ?? null,
  startedAt: r.started_at as string,
  updatedAt: r.updated_at as string,
  completedAt: (r.completed_at as string) ?? null,
  durationSec: (r.duration_sec as number) ?? null,
  ending: parseJson(r.ending, null),
  timings: parseJson(r.timings, {}),
  rejected: r.rejected === 1,
  flags: parseJson(r.flags, []),
  device: (r.device as string) ?? null,
  postback: parseJson(r.postback, null),
});

/** Код панели из JSON параметров ссылки; пусто — без панели */
const panelKey = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

export const responses = {
  async create(r: Omit<StoredResponse, 'id' | 'updatedAt' | 'completedAt' | 'durationSec'>): Promise<StoredResponse> {
    const id = newId(12);
    const flags = r.flags?.length ? r.flags : null;
    await sql.run(`INSERT INTO responses
      (id, project_id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent, started_at, updated_at, device, flags, score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, r.projectId, r.surveyId, r.version, r.status, r.isTest ? 1 : 0, JSON.stringify(r.answers), JSON.stringify(r.history),
      r.currentPage, JSON.stringify(r.params), r.ip, r.userAgent, r.startedAt, now(), r.device ?? null,
      flags ? JSON.stringify(flags) : null, flags ? qualityScore(flags) : null,
    ]);
    return (await this.get(id))!;
  },

  async get(id: string): Promise<StoredResponse | null> {
    const r = await sql.get('SELECT * FROM responses WHERE id = ?', [id]);
    return r ? toResponse(r) : null;
  },

  async update(id: string, patch: ResponsePatch): Promise<void> {
    // Балл риска всегда пересчитывается вместе с пометками
    const extra: [string, Param][] = [['updated_at', now()]];
    if (patch.flags) extra.push(['score', patch.flags.length ? qualityScore(patch.flags) : null]);
    await updateRow('responses', 'id = ?', id, patch, {
      answers: ['answers', enc.json], history: ['history', enc.json], currentPage: 'current_page', status: 'status',
      completedAt: 'completed_at', durationSec: 'duration_sec', version: 'version', timings: ['timings', enc.json],
      rejected: ['rejected', enc.bool], flags: ['flags', enc.jsonOrNull], ending: ['ending', enc.nullableJson],
      postback: ['postback', enc.nullableJson],
    }, extra);
  },

  /** Есть ли в проекте другая настоящая анкета с этого устройства */
  async deviceSeen(projectId: string, device: string, exceptId?: string): Promise<StoredResponse | null> {
    const r = await sql.get(`SELECT * FROM responses WHERE project_id = ? AND is_test = 0 AND device = ? AND id <> ?
      ORDER BY started_at DESC LIMIT 1`, [projectId, device, exceptId ?? '']);
    return r ? toResponse(r) : null;
  },

  /** Есть ли у другой настоящей анкеты проекта точно такой же открытый ответ на вопрос */
  async sameText(projectId: string, questionId: string, text: string, exceptId: string): Promise<boolean> {
    const expr = pg ? `(answers::jsonb -> ? ->> 'v')` : 'json_extract(answers, ?)';
    const key = pg ? questionId : `$."${questionId.replace(/"/g, '')}".v`;
    const r = await sql.get(`SELECT 1 AS x FROM responses WHERE project_id = ? AND is_test = 0 AND id <> ? AND ${expr} = ? LIMIT 1`,
      [projectId, exceptId, key, text]);
    return !!r;
  },

  /** Ответы проекта; бракованные — только с includeRejected, from / to — по времени начала (ISO) */
  async list(projectId: string, opts: {
    includeTest?: boolean; statuses?: ResponseStatus[]; includeRejected?: boolean; from?: string; to?: string;
  } = {}): Promise<StoredResponse[]> {
    let q = 'SELECT * FROM responses WHERE project_id = ?';
    const vals: Param[] = [projectId];
    if (!opts.includeTest) q += ' AND is_test = 0';
    if (!opts.includeRejected) q += ' AND rejected = 0';
    if (opts.from) { q += ' AND started_at >= ?'; vals.push(opts.from); }
    if (opts.to) { q += ' AND started_at < ?'; vals.push(opts.to); }
    if (opts.statuses?.length) {
      q += ` AND status IN (${marks(opts.statuses.length)})`;
      vals.push(...opts.statuses);
    }
    q += ' ORDER BY started_at, id';
    return (await sql.all(q, vals)).map(toResponse);
  },

  /** Последняя настоящая (не тестовая) анкета с этими значениями параметров ссылки */
  async findByParam(projectId: string, match: Record<string, string>): Promise<StoredResponse | null> {
    const keys = Object.keys(match);
    const r = await sql.get(`SELECT * FROM responses WHERE project_id = ? AND is_test = 0
      ${keys.map(() => `AND ${jsonGet('params')} = ?`).join(' ')} ORDER BY started_at DESC LIMIT 1`,
    [projectId, ...keys.flatMap((k) => [jsonKey(k), match[k]])]);
    return r ? toResponse(r) : null;
  },

  /** Сколько настоящих завершённых анкет пришло с панели */
  async completedFromPanel(projectId: string, panel: string): Promise<number> {
    const r = await sql.get(`SELECT COUNT(*) AS n FROM responses WHERE project_id = ? AND is_test = 0 AND rejected = 0
      AND status = 'completed' AND ${jsonGet('params')} = ?`, [projectId, jsonKey(PANEL_PARAM), panel]);
    return r!.n as number;
  },

  /** Настоящие (не бракованные) анкеты для динамики по дням: начало, окончание, статус, панель */
  async timeline(projectId: string): Promise<{ startedAt: string; completedAt: string | null; status: ResponseStatus; panel: string | null }[]> {
    return (await sql.all(`SELECT started_at, completed_at, status, ${jsonGet('params')} AS panel FROM responses
      WHERE project_id = ? AND is_test = 0 AND rejected = 0`, [jsonKey(PANEL_PARAM), projectId]))
      .map((r) => ({
        startedAt: r.started_at as string, completedAt: (r.completed_at as string) ?? null, status: r.status as ResponseStatus,
        panel: panelKey(r.panel),
      }));
  },

  /** Счётчики настоящих анкет по панелям (источникам) */
  async countsByPanel(projectId: string): Promise<PanelCounts[]> {
    const rows = await sql.all(`SELECT ${jsonGet('params')} AS panel, status, rejected, COUNT(*) AS n FROM responses
      WHERE project_id = ? AND is_test = 0 GROUP BY 1, status, rejected`, [jsonKey(PANEL_PARAM), projectId]);
    const out = new Map<string | null, PanelCounts>();
    const of = (panel: string | null) => {
      if (!out.has(panel)) out.set(panel, { panel, statuses: {}, rejected: 0, medianSec: null });
      return out.get(panel)!;
    };
    for (const r of rows) {
      const c = of(panelKey(r.panel));
      if (r.rejected === 1) c.rejected += r.n as number;
      else c.statuses[r.status as string] = (c.statuses[r.status as string] ?? 0) + (r.n as number);
    }
    const durations = await sql.all(`SELECT ${jsonGet('params')} AS panel, duration_sec AS d FROM responses
      WHERE project_id = ? AND is_test = 0 AND rejected = 0 AND status = 'completed' AND duration_sec IS NOT NULL`, [jsonKey(PANEL_PARAM), projectId]);
    const byPanel = new Map<string | null, number[]>();
    for (const r of durations) {
      const k = panelKey(r.panel);
      byPanel.set(k, [...(byPanel.get(k) ?? []), r.d as number]);
    }
    for (const [k, list] of byPanel) of(k).medianSec = median(list);
    const failed = await sql.all(`SELECT ${jsonGet('params')} AS panel, COUNT(*) AS n FROM responses
      WHERE project_id = ? AND is_test = 0 AND postback LIKE '%"ok":false%' GROUP BY 1`, [jsonKey(PANEL_PARAM), projectId]);
    for (const r of failed) of(panelKey(r.panel)).postbackFailed = r.n as number;
    return [...out.values()];
  },

  /** Сколько настоящих анкет начато с этого IP за последние sinceSec секунд */
  async countByIp(projectId: string, ip: string, sinceSec: number): Promise<number> {
    const since = new Date(Date.now() - sinceSec * 1000).toISOString();
    const r = await sql.get('SELECT COUNT(*) AS n FROM responses WHERE project_id = ? AND is_test = 0 AND ip = ? AND started_at >= ?', [projectId, ip, since]);
    return r!.n as number;
  },

  /** Счётчики по статусам; бракованные анкеты считаются отдельно (rejected) и в статусы не входят */
  async counts(projectId: string): Promise<ResponseCounts> {
    const rows = await sql.all(`SELECT is_test, status, rejected, ${flag(`score >= ${SUSPECT_SCORE}`)} AS flagged, COUNT(*) AS n FROM responses
      WHERE project_id = ? GROUP BY is_test, status, rejected, 4`, [projectId]);
    const real: Record<string, number> = {};
    let test = 0;
    let rejected = 0;
    let suspect = 0;
    for (const r of rows) {
      if (r.is_test === 1) test += r.n as number;
      else if (r.rejected === 1) rejected += r.n as number;
      else {
        real[r.status as string] = (real[r.status as string] ?? 0) + (r.n as number);
        if (r.flagged === 1) suspect += r.n as number;
      }
    }
    return { real, test, rejected, suspect };
  },

  /** Забраковать все настоящие подозрительные анкеты (балл риска от SUSPECT_SCORE); возвращает их ID */
  async rejectSuspect(projectId: string): Promise<string[]> {
    const where = `project_id = ? AND is_test = 0 AND rejected = 0 AND score >= ${SUSPECT_SCORE}`;
    const ids = (await sql.all(`SELECT id FROM responses WHERE ${where}`, [projectId])).map((r) => r.id as string);
    await sql.run(`UPDATE responses SET rejected = 1, updated_at = ? WHERE ${where}`, [now(), projectId]);
    return ids;
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM responses WHERE id = ?', [id]);
  },

  async deleteTest(projectId: string): Promise<number> {
    return (await sql.run('DELETE FROM responses WHERE project_id = ? AND is_test = 1', [projectId])).changes;
  },
};
