// Хранилище: SQLite (по умолчанию, файл data/surveylab.db) или PostgreSQL (DATABASE_URL=postgres://…).
// Все методы асинхронные и одинаковые для обеих баз; различия диалектов — в помощниках ниже (jsonGet, isSame, ci…).
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { openSql, sqliteHandle, type Param, type Queryable, type Row } from './sql.ts';
import { initSchema } from './schema.ts';
import { PANEL_PARAM, type Answers, type Panel, type ProjectSettings, type ProjectStatus, type Quota, type Survey } from '../shared/types.ts';
import { migrateSurvey } from '../shared/migrate.ts';
import type { ResponseRecord, ResponseStatus } from '../shared/variables.ts';
import type { CrosstabSpec } from '../shared/crosstab.ts';
import { isEmail } from '../shared/mailTemplate.ts';

export const sql = await openSql({ url: config.databaseUrl, sqliteFile: config.dbFile });
const pg = sql.kind === 'postgres';

await initSchema(sql);

/** SQLite: согласованная копия базы в файл (работает, пока сервис принимает ответы) */
export function backupTo(file: string): void {
  const db = sqliteHandle(sql);
  if (!db) throw new Error('Копия файлом — только для SQLite');
  db.prepare('VACUUM INTO ?').run(file);
}

// ---------- Диалект ----------

/** Значение из JSON-столбца по ключу: `${jsonGet('params')}` с параметром jsonKey('panel') */
const jsonGet = (col: string) => (pg ? `(${col}::jsonb ->> ?)` : `json_extract(${col}, ?)`);
const jsonKey = (key: string) => (pg ? key : `$."${key.replace(/"/g, '')}"`);
/** Сравнение, где NULL = NULL */
const isSame = pg ? 'IS NOT DISTINCT FROM ?' : 'IS ?';
/** Поиск без учёта регистра */
const LIKE = pg ? 'ILIKE' : 'LIKE';
/** Логины — без учёта регистра */
const ci = (col: string) => `lower(${col}) = lower(?)`;
/** Условие → 0/1 (в PostgreSQL сравнения дают boolean) */
const flag = (cond: string) => `CASE WHEN ${cond} THEN 1 ELSE 0 END`;
/** Список ID порциями — для IN (…) */
function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ---------- Типы ----------

export type SurveyStatus = 'draft' | 'active' | 'closed';

export interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  auto: boolean;
  /** Какие статусы выгружать */
  statuses: ResponseStatus[];
  values: 'labels' | 'codes';
  lastSyncAt?: string;
  lastError?: string | null;
}

/** Уведомления о ходе сбора: вебхук и/или Telegram */
export interface NotifyConfig {
  webhookUrl?: string;
  telegramChatId?: string;
  /** Сообщать о каждой N-й завершённой анкете (1 — о каждой); 0 или пусто — нет */
  everyN?: number;
  quotaFull?: boolean;
  limitReached?: boolean;
  lastError?: string | null;
  lastSentAt?: string;
}

export interface SurveyRow {
  id: string;
  title: string;
  draft: Survey;
  published: Survey | null;
  version: number;
  status: SurveyStatus;
  sheets: SheetsConfig | null;
  /** В архиве: скрыта из основного списка, сбор закрыт */
  archived: boolean;
  notify: NotifyConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface SurveyVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  questions: number;
}

export interface ProjectRow {
  id: string;
  title: string;
  surveyId: string;
  status: ProjectStatus;
  settings: ProjectSettings;
  quotas: Quota[];
  panels: Panel[];
  /** Сохранённые наборы таблиц */
  tables: TableSet[];
  sheets: SheetsConfig | null;
  notify: NotifyConfig | null;
  createdAt: string;
  updatedAt: string;
}

/** Набор таблиц: строки, шапка, фильтры — сохраняется в проекте */
export interface TableSet { name: string; spec: CrosstabSpec }

/** Счётчики одного источника: panel = null — прямая ссылка без панели */
export interface PanelCounts {
  panel: string | null;
  statuses: Record<string, number>;
  rejected: number;
  /** Медиана длительности завершённых анкет, сек */
  medianSec: number | null;
}

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
}

export function newId(len = 10): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

const now = () => new Date().toISOString();

export function median(list: number[]): number | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function toSurvey(r: Row): SurveyRow {
  return {
    id: r.id as string,
    title: r.title as string,
    // Анкеты старого формата переводятся в текущий при чтении
    draft: migrateSurvey(JSON.parse(r.draft as string)) as Survey,
    published: r.published ? (migrateSurvey(JSON.parse(r.published as string)) as Survey) : null,
    version: r.version as number,
    status: r.status as SurveyStatus,
    sheets: r.sheets ? JSON.parse(r.sheets as string) : null,
    archived: r.archived === 1,
    notify: r.notify ? JSON.parse(r.notify as string) : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toProject(r: Row): ProjectRow {
  return {
    id: r.id as string,
    title: r.title as string,
    surveyId: r.survey_id as string,
    status: r.status as ProjectStatus,
    settings: r.settings ? JSON.parse(r.settings as string) : {},
    quotas: r.quotas ? JSON.parse(r.quotas as string) : [],
    panels: r.panels ? JSON.parse(r.panels as string) : [],
    tables: r.tables ? JSON.parse(r.tables as string) : [],
    sheets: r.sheets ? JSON.parse(r.sheets as string) : null,
    notify: r.notify ? JSON.parse(r.notify as string) : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toResponse(r: Row): StoredResponse {
  return {
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
    ending: r.ending ? JSON.parse(r.ending as string) : null,
    timings: r.timings ? JSON.parse(r.timings as string) : {},
    rejected: r.rejected === 1,
    flags: r.flags ? JSON.parse(r.flags as string) : [],
  };
}

// ---------- Анкеты ----------

export const surveys = {
  async list(): Promise<{ id: string; title: string; version: number; archived: boolean; createdAt: string; updatedAt: string; projects: number; unpublished: boolean }[]> {
    const rows = await sql.all(`SELECT s.id, s.title, s.version, s.archived, s.created_at, s.updated_at,
      ${flag('s.published IS NULL OR s.published <> s.draft')} AS unpublished,
      (SELECT COUNT(*) FROM projects p WHERE p.survey_id = s.id) AS projects FROM surveys s ORDER BY s.updated_at DESC`);
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, version: r.version as number, archived: r.archived === 1,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string, projects: r.projects as number, unpublished: r.unpublished === 1,
    }));
  },

  async get(id: string): Promise<SurveyRow | null> {
    const r = await sql.get('SELECT * FROM surveys WHERE id = ?', [id]);
    return r ? toSurvey(r) : null;
  },

  async create(def: Survey): Promise<SurveyRow> {
    const id = newId(8);
    const t = now();
    await sql.run('INSERT INTO surveys (id, title, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, def.title, JSON.stringify(def), t, t]);
    return (await this.get(id))!;
  },

  async saveDraft(id: string, def: Survey): Promise<void> {
    await sql.run('UPDATE surveys SET draft = ?, title = ?, updated_at = ? WHERE id = ?', [JSON.stringify(def), def.title, now(), id]);
  },

  async publish(id: string, by: string | null = null): Promise<number> {
    const s = (await this.get(id))!;
    const version = s.version + 1;
    const t = now();
    await sql.tx(async (q) => {
      await q.run('UPDATE surveys SET published = draft, version = ?, updated_at = ? WHERE id = ?', [version, t, id]);
      await q.run('INSERT INTO survey_versions (survey_id, version, definition, published_at, published_by) VALUES (?, ?, ?, ?, ?)',
        [id, version, JSON.stringify(s.draft), t, by]);
    });
    return version;
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    await sql.run('UPDATE surveys SET archived = ? WHERE id = ?', [archived ? 1 : 0, id]);
  },

  async versions(id: string): Promise<SurveyVersion[]> {
    const rows = await sql.all('SELECT version, definition, published_at, published_by FROM survey_versions WHERE survey_id = ? ORDER BY version DESC', [id]);
    return rows.map((r) => {
      const def = migrateSurvey(JSON.parse(r.definition as string)) as Survey;
      return {
        version: r.version as number, publishedAt: r.published_at as string, publishedBy: (r.published_by as string) ?? null,
        questions: def.blocks.reduce((n, b) => n + b.questions.length, 0),
      };
    });
  },

  async version(id: string, version: number): Promise<Survey | null> {
    const r = await sql.get('SELECT definition FROM survey_versions WHERE survey_id = ? AND version = ?', [id, version]);
    return r ? (migrateSurvey(JSON.parse(r.definition as string)) as Survey) : null;
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM surveys WHERE id = ?', [id]);
  },
};

// ---------- Проекты ----------

export const projects = {
  async list(): Promise<(ProjectRow & { surveyTitle: string; counts: Record<string, number> })[]> {
    const rows = await sql.all('SELECT p.*, s.title AS survey_title FROM projects p JOIN surveys s ON s.id = p.survey_id ORDER BY p.updated_at DESC');
    const counts = await sql.all(
      'SELECT project_id, status, COUNT(*) AS n FROM responses WHERE is_test = 0 AND rejected = 0 AND project_id IS NOT NULL GROUP BY project_id, status',
    );
    return rows.map((r) => {
      const c: Record<string, number> = {};
      for (const x of counts) if (x.project_id === r.id) c[x.status as string] = x.n as number;
      return { ...toProject(r), surveyTitle: r.survey_title as string, counts: c };
    });
  },

  async get(id: string): Promise<ProjectRow | null> {
    const r = await sql.get('SELECT * FROM projects WHERE id = ?', [id]);
    return r ? toProject(r) : null;
  },

  async bySurvey(surveyId: string): Promise<ProjectRow[]> {
    return (await sql.all('SELECT * FROM projects WHERE survey_id = ? ORDER BY created_at', [surveyId])).map(toProject);
  },

  async create(p: { title: string; surveyId: string }): Promise<ProjectRow> {
    let id = newId(8);
    // ID проекта — в ссылке респондента (/s/ID): не должен совпадать с ID анкеты
    while (await sql.get('SELECT 1 AS x FROM surveys WHERE id = ? UNION SELECT 1 AS x FROM projects WHERE id = ?', [id, id])) id = newId(8);
    const t = now();
    await sql.run('INSERT INTO projects (id, title, survey_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, p.title, p.surveyId, t, t]);
    return (await this.get(id))!;
  },

  async update(id: string, patch: { title?: string; surveyId?: string; status?: ProjectStatus; settings?: ProjectSettings; quotas?: Quota[]; panels?: Panel[]; tables?: TableSet[] }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: Param[] = [now()];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
    if (patch.surveyId !== undefined) { sets.push('survey_id = ?'); vals.push(patch.surveyId); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.settings !== undefined) { sets.push('settings = ?'); vals.push(Object.keys(patch.settings).length ? JSON.stringify(patch.settings) : null); }
    if (patch.quotas !== undefined) { sets.push('quotas = ?'); vals.push(patch.quotas.length ? JSON.stringify(patch.quotas) : null); }
    if (patch.panels !== undefined) { sets.push('panels = ?'); vals.push(patch.panels.length ? JSON.stringify(patch.panels) : null); }
    if (patch.tables !== undefined) { sets.push('tables = ?'); vals.push(patch.tables.length ? JSON.stringify(patch.tables) : null); }
    vals.push(id);
    await sql.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, vals);
  },

  /** Копия проекта (новая волна): анкета, настройки сбора, квоты и панели — без ответов, в статусе «Разработка» */
  async copy(id: string, title: string): Promise<ProjectRow> {
    const src = (await this.get(id))!;
    const p = await this.create({ title, surveyId: src.surveyId });
    await this.update(p.id, { settings: src.settings, quotas: src.quotas, panels: src.panels, tables: src.tables });
    return (await this.get(p.id))!;
  },

  async setNotify(id: string, notify: NotifyConfig | null): Promise<void> {
    await sql.run('UPDATE projects SET notify = ? WHERE id = ?', [notify ? JSON.stringify(notify) : null, id]);
  },

  async setSheets(id: string, sheets: SheetsConfig | null): Promise<void> {
    await sql.run('UPDATE projects SET sheets = ? WHERE id = ?', [sheets ? JSON.stringify(sheets) : null, id]);
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM projects WHERE id = ?', [id]);
  },
};

// ---------- Ответы ----------

export const responses = {
  async create(r: Omit<StoredResponse, 'id' | 'updatedAt' | 'completedAt' | 'durationSec'>): Promise<StoredResponse> {
    const id = newId(12);
    const t = now();
    await sql.run(`INSERT INTO responses
      (id, project_id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, r.projectId, r.surveyId, r.version, r.status, r.isTest ? 1 : 0, JSON.stringify(r.answers), JSON.stringify(r.history),
      r.currentPage, JSON.stringify(r.params), r.ip, r.userAgent, r.startedAt, t,
    ]);
    return (await this.get(id))!;
  },

  async get(id: string): Promise<StoredResponse | null> {
    const r = await sql.get('SELECT * FROM responses WHERE id = ?', [id]);
    return r ? toResponse(r) : null;
  },

  async update(id: string, patch: {
    answers?: Answers; history?: string[]; currentPage?: string | null; status?: ResponseStatus;
    completedAt?: string | null; durationSec?: number | null; version?: number;
    ending?: { message?: string; redirect?: string } | null;
    timings?: Record<string, number>; rejected?: boolean; flags?: string[];
  }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: Param[] = [now()];
    if (patch.answers !== undefined) { sets.push('answers = ?'); vals.push(JSON.stringify(patch.answers)); }
    if (patch.history !== undefined) { sets.push('history = ?'); vals.push(JSON.stringify(patch.history)); }
    if (patch.currentPage !== undefined) { sets.push('current_page = ?'); vals.push(patch.currentPage); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); vals.push(patch.completedAt); }
    if (patch.durationSec !== undefined) { sets.push('duration_sec = ?'); vals.push(patch.durationSec); }
    if (patch.version !== undefined) { sets.push('version = ?'); vals.push(patch.version); }
    if (patch.timings !== undefined) { sets.push('timings = ?'); vals.push(JSON.stringify(patch.timings)); }
    if (patch.rejected !== undefined) { sets.push('rejected = ?'); vals.push(patch.rejected ? 1 : 0); }
    if (patch.flags !== undefined) { sets.push('flags = ?'); vals.push(patch.flags.length ? JSON.stringify(patch.flags) : null); }
    if (patch.ending !== undefined) { sets.push('ending = ?'); vals.push(patch.ending ? JSON.stringify(patch.ending) : null); }
    vals.push(id);
    await sql.run(`UPDATE responses SET ${sets.join(', ')} WHERE id = ?`, vals);
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
        panel: r.panel === null || r.panel === undefined || r.panel === '' ? null : String(r.panel),
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
    const key = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
    for (const r of rows) {
      const c = of(key(r.panel));
      if (r.rejected === 1) c.rejected += r.n as number;
      else c.statuses[r.status as string] = (c.statuses[r.status as string] ?? 0) + (r.n as number);
    }
    const durations = await sql.all(`SELECT ${jsonGet('params')} AS panel, duration_sec AS d FROM responses
      WHERE project_id = ? AND is_test = 0 AND rejected = 0 AND status = 'completed' AND duration_sec IS NOT NULL`, [jsonKey(PANEL_PARAM), projectId]);
    const byPanel = new Map<string | null, number[]>();
    for (const r of durations) {
      const k = key(r.panel);
      byPanel.set(k, [...(byPanel.get(k) ?? []), r.d as number]);
    }
    for (const [k, list] of byPanel) of(k).medianSec = median(list);
    return [...out.values()];
  },

  /** Сколько настоящих анкет начато с этого IP за последние sinceSec секунд */
  async countByIp(projectId: string, ip: string, sinceSec: number): Promise<number> {
    const since = new Date(Date.now() - sinceSec * 1000).toISOString();
    const r = await sql.get('SELECT COUNT(*) AS n FROM responses WHERE project_id = ? AND is_test = 0 AND ip = ? AND started_at >= ?', [projectId, ip, since]);
    return r!.n as number;
  },

  /** Счётчики по статусам; бракованные анкеты считаются отдельно (rejected) и в статусы не входят */
  async counts(projectId: string): Promise<{ real: Record<string, number>; test: number; rejected: number; suspect: number }> {
    const rows = await sql.all(`SELECT is_test, status, rejected, ${flag('flags IS NOT NULL')} AS flagged, COUNT(*) AS n FROM responses
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

  /** Забраковать все настоящие анкеты с пометками качества; возвращает, сколько забраковано */
  async rejectSuspect(projectId: string): Promise<number> {
    return (await sql.run('UPDATE responses SET rejected = 1, updated_at = ? WHERE project_id = ? AND is_test = 0 AND rejected = 0 AND flags IS NOT NULL',
      [now(), projectId])).changes;
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM responses WHERE id = ?', [id]);
  },

  async deleteTest(projectId: string): Promise<number> {
    return (await sql.run('DELETE FROM responses WHERE project_id = ? AND is_test = 1', [projectId])).changes;
  },
};

// ---- Пользователи админки ----

/**
 * admin — всё, включая пользователей и копии базы; editor — анкеты и данные; viewer — только просмотр и выгрузки;
 * client — заказчик: только свои проекты (сводка, отчёт, данные), без анкет и настроек
 */
export type Role = 'admin' | 'editor' | 'viewer' | 'client';

export interface UserRow {
  login: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Для заказчика: проекты, которые он видит */
  projects: string[];
}

const toUser = (r: Row): UserRow => ({
  login: r.login as string, role: r.role as Role, disabled: r.disabled === 1,
  createdAt: r.created_at as string, lastLoginAt: (r.last_login_at as string) ?? null,
  projects: r.projects ? JSON.parse(r.projects as string) : [],
});

export const users = {
  async list(): Promise<UserRow[]> {
    return (await sql.all('SELECT * FROM users ORDER BY lower(login)')).map(toUser);
  },
  async get(login: string): Promise<(UserRow & { passwordHash: string }) | null> {
    const r = await sql.get(`SELECT * FROM users WHERE ${ci('login')}`, [login]);
    return r ? { ...toUser(r), passwordHash: r.password as string } : null;
  },
  async create(login: string, passwordHash: string, role: Role): Promise<void> {
    await sql.run('INSERT INTO users (login, password, role, created_at) VALUES (?, ?, ?, ?)', [login, passwordHash, role, now()]);
  },
  async update(login: string, patch: { passwordHash?: string; role?: Role; disabled?: boolean; projects?: string[] }): Promise<void> {
    if (patch.projects !== undefined) await sql.run(`UPDATE users SET projects = ? WHERE ${ci('login')}`, [patch.projects.length ? JSON.stringify(patch.projects) : null, login]);
    if (patch.passwordHash !== undefined) await sql.run(`UPDATE users SET password = ? WHERE ${ci('login')}`, [patch.passwordHash, login]);
    if (patch.role !== undefined) await sql.run(`UPDATE users SET role = ? WHERE ${ci('login')}`, [patch.role, login]);
    if (patch.disabled !== undefined) await sql.run(`UPDATE users SET disabled = ? WHERE ${ci('login')}`, [patch.disabled ? 1 : 0, login]);
  },
  async touch(login: string): Promise<void> {
    await sql.run(`UPDATE users SET last_login_at = ? WHERE ${ci('login')}`, [now(), login]);
  },
  async remove(login: string): Promise<void> {
    await sql.run(`DELETE FROM users WHERE ${ci('login')}`, [login]);
  },
};

// ---- OAuth для ИИ-коннекторов (Claude, ChatGPT) ----

export interface OAuthClient { id: string; name: string; secretHash: string | null; redirectUris: string[]; createdAt: string }
export interface OAuthGrant { clientId: string; login: string; scope: string | null; expiresAt: string }

const toClient = (r: Row): OAuthClient => ({
  id: r.id as string, name: r.name as string, secretHash: (r.secret_hash as string) ?? null,
  redirectUris: JSON.parse(r.redirect_uris as string), createdAt: r.created_at as string,
});

/** Коды, токены и секреты хранятся только как хэши */
export const oauth = {
  async createClient(c: { name: string; secretHash: string | null; redirectUris: string[] }): Promise<OAuthClient> {
    const id = `sl_${newId(20)}`;
    await sql.run('INSERT INTO oauth_clients (id, name, secret_hash, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, c.name, c.secretHash, JSON.stringify(c.redirectUris), now()]);
    return (await this.client(id))!;
  },
  async client(id: string): Promise<OAuthClient | null> {
    const r = await sql.get('SELECT * FROM oauth_clients WHERE id = ?', [id]);
    return r ? toClient(r) : null;
  },
  async saveCode(codeHash: string, g: OAuthGrant & { redirectUri: string; challenge: string }): Promise<void> {
    await sql.run('DELETE FROM oauth_codes WHERE expires_at < ?', [now()]);
    await sql.run('INSERT INTO oauth_codes (code_hash, client_id, login, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [codeHash, g.clientId, g.login, g.redirectUri, g.challenge, g.scope, g.expiresAt]);
  },
  /** Код одноразовый: читается и удаляется одной командой */
  async takeCode(codeHash: string): Promise<(OAuthGrant & { redirectUri: string; challenge: string }) | null> {
    const r = await sql.get('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *', [codeHash]);
    if (!r) return null;
    if ((r.expires_at as string) < now()) return null;
    return {
      clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null,
      expiresAt: r.expires_at as string, redirectUri: r.redirect_uri as string, challenge: r.challenge as string,
    };
  },
  async saveToken(tokenHash: string, kind: 'access' | 'refresh', g: OAuthGrant): Promise<void> {
    await sql.run('INSERT INTO oauth_tokens (token_hash, kind, client_id, login, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tokenHash, kind, g.clientId, g.login, g.scope, g.expiresAt, now()]);
  },
  /** Действующий токен (просроченные удаляются) */
  async token(tokenHash: string, kind: 'access' | 'refresh'): Promise<OAuthGrant | null> {
    const r = await sql.get('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?', [tokenHash, kind]);
    if (!r) return null;
    if ((r.expires_at as string) < now()) {
      await sql.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [tokenHash]);
      return null;
    }
    if (kind === 'access') await sql.run('UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?', [now(), tokenHash]);
    return { clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null, expiresAt: r.expires_at as string };
  },
  async deleteToken(tokenHash: string): Promise<void> {
    await sql.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [tokenHash]);
  },
  /** Подключённые приложения пользователя: по клиенту — когда выдан доступ и когда им пользовались */
  async connections(login: string): Promise<{ clientId: string; name: string; since: string; lastUsedAt: string | null }[]> {
    const rows = await sql.all(`SELECT t.client_id, c.name, MIN(t.created_at) AS since, MAX(t.last_used_at) AS last_used
      FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE ${ci('t.login')} AND t.expires_at >= ?
      GROUP BY t.client_id, c.name ORDER BY since`, [login, now()]);
    return rows.map((r) => ({
      clientId: r.client_id as string, name: r.name as string, since: r.since as string, lastUsedAt: (r.last_used as string) ?? null,
    }));
  },
  /** Отозвать доступ приложения (или всех приложений, если clientId не задан) */
  async revoke(login: string, clientId?: string): Promise<number> {
    const res = clientId
      ? await sql.run(`DELETE FROM oauth_tokens WHERE ${ci('login')} AND client_id = ?`, [login, clientId])
      : await sql.run(`DELETE FROM oauth_tokens WHERE ${ci('login')}`, [login]);
    return res.changes;
  },
};

// ---- Журнал действий команды ----

export interface AuditEntry {
  id: number;
  at: string;
  login: string | null;
  /** ui — интерфейс, ai — ИИ-коннектор (details.app — приложение) */
  via: 'ui' | 'ai';
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetTitle: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

/** Сколько дней хранить журнал */
const AUDIT_KEEP_DAYS = 365;
let auditPrunedAt = 0;

export const audit = {
  /**
   * Записать действие. coalesceMin — если то же действие того же человека над тем же объектом было недавно,
   * обновляется время прежней записи (автосохранение черновика не засоряет журнал).
   */
  async add(e: Omit<AuditEntry, 'id' | 'at'>, coalesceMin = 0): Promise<void> {
    const t = now();
    if (coalesceMin > 0) {
      const since = new Date(Date.now() - coalesceMin * 60_000).toISOString();
      const prev = await sql.get(`SELECT id FROM audit WHERE login ${isSame} AND via = ? AND action = ? AND target_type ${isSame} AND target_id ${isSame} AND at >= ?
        ORDER BY id DESC LIMIT 1`, [e.login, e.via, e.action, e.targetType, e.targetId, since]);
      if (prev) {
        await sql.run('UPDATE audit SET at = ?, target_title = COALESCE(?, target_title) WHERE id = ?', [t, e.targetTitle, prev.id as number]);
        return;
      }
    }
    await sql.run(`INSERT INTO audit (at, login, via, action, target_type, target_id, target_title, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      t, e.login, e.via, e.action, e.targetType, e.targetId, e.targetTitle, e.details ? JSON.stringify(e.details) : null, e.ip,
    ]);
    if (Date.now() - auditPrunedAt > 86400_000) {
      auditPrunedAt = Date.now();
      await sql.run('DELETE FROM audit WHERE at < ?', [new Date(Date.now() - AUDIT_KEEP_DAYS * 86400_000).toISOString()]);
    }
  },

  /** Записи от новых к старым; фильтры необязательны */
  async list(f: { login?: string; targetType?: string; targetId?: string; via?: string; q?: string; from?: string; to?: string; before?: number; limit?: number } = {}):
    Promise<AuditEntry[]> {
    const where: string[] = [];
    const vals: Param[] = [];
    if (f.login) { where.push(ci('login')); vals.push(f.login); }
    if (f.targetType) { where.push('target_type = ?'); vals.push(f.targetType); }
    if (f.targetId) { where.push('target_id = ?'); vals.push(f.targetId); }
    if (f.via) { where.push('via = ?'); vals.push(f.via); }
    if (f.from) { where.push('at >= ?'); vals.push(f.from); }
    if (f.to) { where.push('at < ?'); vals.push(f.to); }
    if (f.before) { where.push('id < ?'); vals.push(f.before); }
    if (f.q) {
      where.push(`(action ${LIKE} ? OR target_title ${LIKE} ? OR target_id ${LIKE} ? OR login ${LIKE} ?)`);
      const like = `%${f.q.replace(/[%_]/g, '')}%`;
      vals.push(like, like, like, like);
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
    const rows = await sql.all(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, vals);
    return rows.map((r) => ({
      id: r.id as number, at: r.at as string, login: (r.login as string) ?? null, via: r.via as 'ui' | 'ai', action: r.action as string,
      targetType: (r.target_type as string) ?? null, targetId: (r.target_id as string) ?? null, targetTitle: (r.target_title as string) ?? null,
      details: r.details ? JSON.parse(r.details as string) : null, ip: (r.ip as string) ?? null,
    }));
  },

  /** Логины, встречающиеся в журнале (для фильтра) */
  async logins(): Promise<string[]> {
    return (await sql.all('SELECT DISTINCT login FROM audit WHERE login IS NOT NULL ORDER BY login')).map((r) => r.login as string);
  },
};

// ---- Персональные ссылки: список приглашённых проекта ----

export interface Invitee {
  id: number;
  projectId: string;
  token: string;
  /** ID из списка (табельный номер, ID клиента) */
  extId: string | null;
  /** Остальные столбцы списка: имя, e-mail, отдел… — становятся параметрами ответа */
  fields: Record<string, string>;
  responseId: string | null;
  openedAt: string | null;
  createdAt: string;
  /** Статус анкеты по ссылке (из ответа) */
  status: ResponseStatus | null;
  rejected: boolean;
  completedAt: string | null;
  /** Письмо ждёт отправки (в очереди рассылки) */
  mailPending: boolean;
  mailSentAt: string | null;
  mailCount: number;
  mailError: string | null;
}

const toInvitee = (r: Row): Invitee => ({
  id: r.id as number, projectId: r.project_id as string, token: r.token as string, extId: (r.ext_id as string) ?? null,
  fields: JSON.parse(r.fields as string), responseId: (r.response_id as string) ?? null, openedAt: (r.opened_at as string) ?? null,
  createdAt: r.created_at as string, status: (r.status as ResponseStatus) ?? null, rejected: r.rejected === 1,
  completedAt: (r.completed_at as string) ?? null,
  mailPending: r.mail_pending != null, mailSentAt: (r.mail_sent_at as string) ?? null, mailCount: (r.mail_count as number) ?? 0,
  mailError: (r.mail_error as string) ?? null,
});

const INVITEE_SELECT = `SELECT i.*, r.status, r.rejected, r.completed_at FROM invitees i LEFT JOIN responses r ON r.id = i.response_id`;

export const invitees = {
  async list(projectId: string): Promise<Invitee[]> {
    return (await sql.all(`${INVITEE_SELECT} WHERE i.project_id = ? ORDER BY i.id`, [projectId])).map(toInvitee);
  },
  async byToken(projectId: string, token: string): Promise<Invitee | null> {
    const r = await sql.get(`${INVITEE_SELECT} WHERE i.project_id = ? AND i.token = ?`, [projectId, token]);
    return r ? toInvitee(r) : null;
  },
  /** Добавить людей; ext_id не повторяется внутри проекта — повторы пропускаются */
  async add(projectId: string, people: { extId: string | null; fields: Record<string, string> }[]): Promise<{ added: number; skipped: number }> {
    return sql.tx(async (q) => {
      const existing = new Set((await q.all('SELECT ext_id FROM invitees WHERE project_id = ? AND ext_id IS NOT NULL', [projectId]))
        .map((r) => String(r.ext_id).toLowerCase()));
      const rows: Param[][] = [];
      let skipped = 0;
      const t = now();
      for (const p of people) {
        const key = p.extId?.toLowerCase();
        if (key && existing.has(key)) { skipped++; continue; }
        if (key) existing.add(key);
        rows.push([projectId, newId(16), p.extId, JSON.stringify(p.fields), t]);
      }
      // Вставка порциями: 20 000 человек — это 40 запросов, а не 20 000
      for (const part of chunks(rows, 200)) {
        await q.run(`INSERT INTO invitees (project_id, token, ext_id, fields, created_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`, part.flat());
      }
      return { added: rows.length, skipped };
    });
  },
  async attach(id: number, responseId: string): Promise<void> {
    await sql.run('UPDATE invitees SET response_id = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?', [responseId, now(), id]);
  },
  /** Удалить людей из списка (их ответы остаются) */
  async remove(projectId: string, ids: number[] | 'all'): Promise<number> {
    if (ids === 'all') return (await sql.run('DELETE FROM invitees WHERE project_id = ?', [projectId])).changes;
    let n = 0;
    for (const part of chunks(ids)) n += (await sql.run(`DELETE FROM invitees WHERE project_id = ? AND id IN (${marks(part.length)})`, [projectId, ...part])).changes;
    return n;
  },
  /** Новая ссылка взамен старой (старая перестаёт работать) */
  async reissue(projectId: string, id: number): Promise<void> {
    await sql.run('UPDATE invitees SET token = ? WHERE project_id = ? AND id = ?', [newId(16), projectId, id]);
  },
  async count(projectId: string): Promise<number> {
    return (await sql.get('SELECT COUNT(*) AS n FROM invitees WHERE project_id = ?', [projectId]))!.n as number;
  },
};

// ---- Рассылки приглашений по e-mail ----

/** Кому: ещё не получали письмо / не завершили (напоминание) / все / выбранные */
export type MailAudience = 'not_sent' | 'not_completed' | 'all' | 'ids';

export interface Mailing {
  id: number;
  projectId: string;
  audience: MailAudience;
  subject: string;
  body: string;
  /** Столбец списка с адресом */
  emailField: string;
  /** Адрес сервиса для ссылок в письмах */
  baseUrl: string;
  createdBy: string | null;
  createdAt: string;
  total: number;
  sent: number;
  failed: number;
  /** Сколько ещё в очереди */
  pending: number;
  finishedAt: string | null;
  cancelled: boolean;
}

const toMailing = (r: Row): Mailing => ({
  id: r.id as number, projectId: r.project_id as string, audience: r.audience as MailAudience, subject: r.subject as string,
  body: r.body as string, emailField: r.email_field as string, baseUrl: r.base_url as string, createdBy: (r.created_by as string) ?? null,
  createdAt: r.created_at as string, total: r.total as number, sent: r.sent as number, failed: r.failed as number,
  pending: (r.pending as number) ?? 0, finishedAt: (r.finished_at as string) ?? null, cancelled: r.cancelled === 1,
});

export { isEmail };

const MAILING_SELECT = 'SELECT m.*, (SELECT COUNT(*) FROM invitees i WHERE i.mail_pending = m.id) AS pending FROM mailings m';

async function getMailing(q: Queryable, id: number): Promise<Mailing | null> {
  const r = await q.get(`${MAILING_SELECT} WHERE m.id = ?`, [id]);
  return r ? toMailing(r) : null;
}

export const mailings = {
  /**
   * Создать рассылку и поставить письма в очередь. Люди без адреса и те, кому письмо уже стоит в очереди, пропускаются.
   * Возвращает рассылку и сколько людей пропущено из-за пустого или неверного адреса.
   */
  async create(m: Pick<Mailing, 'projectId' | 'audience' | 'subject' | 'body' | 'emailField' | 'baseUrl' | 'createdBy'>, ids?: number[]): Promise<{ mailing: Mailing; noEmail: number }> {
    const where = {
      not_sent: 'i.mail_sent_at IS NULL',
      not_completed: "(r.status IS NULL OR r.status = 'in_progress')",
      all: '1 = 1',
      ids: '1 = 1',
    }[m.audience];
    return sql.tx(async (q) => {
      const rows = await q.all(`${INVITEE_SELECT} WHERE i.project_id = ? AND i.mail_pending IS NULL AND ${where}`, [m.projectId]);
      const idSet = m.audience === 'ids' ? new Set(ids ?? []) : null;
      const chosen = rows.map(toInvitee).filter((p) => !idSet || idSet.has(p.id));
      const withEmail = chosen.filter((p) => isEmail(p.fields[m.emailField]));
      const ins = await q.get(`INSERT INTO mailings (project_id, audience, subject, body, email_field, base_url, created_by, created_at, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [m.projectId, m.audience, m.subject, m.body, m.emailField, m.baseUrl, m.createdBy, now(), withEmail.length]);
      const id = ins!.id as number;
      for (const part of chunks(withEmail.map((p) => p.id))) {
        await q.run(`UPDATE invitees SET mail_pending = ? WHERE id IN (${marks(part.length)})`, [id, ...part]);
      }
      if (!withEmail.length) await q.run('UPDATE mailings SET finished_at = ? WHERE id = ?', [now(), id]);
      return { mailing: (await getMailing(q, id))!, noEmail: chosen.length - withEmail.length };
    });
  },
  async get(id: number): Promise<Mailing | null> {
    return getMailing(sql, id);
  },
  async list(projectId: string): Promise<Mailing[]> {
    return (await sql.all(`${MAILING_SELECT} WHERE m.project_id = ? ORDER BY m.id DESC LIMIT 50`, [projectId])).map(toMailing);
  },
  /** Следующее письмо из очереди (сначала более ранние рассылки) */
  async nextPending(): Promise<{ mailing: Mailing; invitee: Invitee } | null> {
    for (;;) {
      const r = await sql.get(`${INVITEE_SELECT} WHERE i.mail_pending IS NOT NULL ORDER BY i.mail_pending, i.id LIMIT 1`);
      if (!r) return null;
      const mailing = await this.get(r.mail_pending as number);
      if (mailing) return { mailing, invitee: toInvitee(r) };
      await sql.run('UPDATE invitees SET mail_pending = NULL WHERE id = ?', [r.id as number]);
    }
  },
  /** Итог отправки одного письма: error — текст ошибки или null */
  async markSent(mailingId: number, inviteeId: number, error: string | null): Promise<void> {
    await sql.tx(async (q) => {
      // Письмо могли убрать из очереди (рассылку остановили) — тогда не считаем
      const still = await q.get('SELECT 1 AS x FROM invitees WHERE id = ? AND mail_pending = ?', [inviteeId, mailingId]);
      if (error) {
        await q.run('UPDATE invitees SET mail_pending = NULL, mail_error = ? WHERE id = ?', [error.slice(0, 300), inviteeId]);
        if (still) await q.run('UPDATE mailings SET failed = failed + 1 WHERE id = ?', [mailingId]);
      } else {
        await q.run('UPDATE invitees SET mail_pending = NULL, mail_error = NULL, mail_sent_at = ?, mail_count = mail_count + 1 WHERE id = ?', [now(), inviteeId]);
        await q.run('UPDATE mailings SET sent = sent + 1 WHERE id = ?', [mailingId]);
      }
      await q.run(`UPDATE mailings SET finished_at = ? WHERE id = ? AND finished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invitees WHERE mail_pending = ?)`, [now(), mailingId, mailingId]);
    });
  },
  /** Остановить рассылку: неотправленные письма убираются из очереди */
  async cancel(projectId: string, id: number): Promise<boolean> {
    return sql.tx(async (q) => {
      const n = (await q.run('UPDATE mailings SET cancelled = 1, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND project_id = ? AND finished_at IS NULL',
        [now(), id, projectId])).changes;
      if (n > 0) await q.run('UPDATE invitees SET mail_pending = NULL WHERE mail_pending = ?', [id]);
      return n > 0;
    });
  },
};
