// Хранилище. Сейчас SQLite (встроенный node:sqlite); методы асинхронные,
// чтобы переход на PostgreSQL не менял код маршрутов.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { PANEL_PARAM, stripProjectFields, type Answers, type Panel, type ProjectSettings, type ProjectStatus, type Quota, type Survey } from '../shared/types.ts';
import { migrateSurvey } from '../shared/migrate.ts';
import type { ResponseRecord, ResponseStatus } from '../shared/variables.ts';

const db = new DatabaseSync(config.dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    draft TEXT NOT NULL,
    published TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    sheets TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS survey_versions (
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    published_at TEXT NOT NULL,
    PRIMARY KEY (survey_id, version)
  );

  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0,
    answers TEXT NOT NULL DEFAULT '{}',
    history TEXT NOT NULL DEFAULT '[]',
    current_page TEXT,
    params TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    user_agent TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    duration_sec INTEGER
  );
  CREATE INDEX IF NOT EXISTS responses_survey ON responses(survey_id, is_test, status);
`);
// Добавленные позже столбцы
const surveyCols = (db.prepare('PRAGMA table_info(surveys)').all() as { name: string }[]).map((c) => c.name);
if (!surveyCols.includes('archived')) db.exec('ALTER TABLE surveys ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
if (!surveyCols.includes('notify')) db.exec('ALTER TABLE surveys ADD COLUMN notify TEXT');
const versionCols = (db.prepare('PRAGMA table_info(survey_versions)').all() as { name: string }[]).map((c) => c.name);
const responseCols = (db.prepare('PRAGMA table_info(responses)').all() as { name: string }[]).map((c) => c.name);
if (!responseCols.includes('ending')) db.exec('ALTER TABLE responses ADD COLUMN ending TEXT');
if (!responseCols.includes('timings')) db.exec('ALTER TABLE responses ADD COLUMN timings TEXT');
if (!responseCols.includes('rejected')) db.exec('ALTER TABLE responses ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0');
if (!versionCols.includes('published_by')) db.exec('ALTER TABLE survey_versions ADD COLUMN published_by TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    survey_id TEXT NOT NULL REFERENCES surveys(id),
    status TEXT NOT NULL DEFAULT 'development',
    settings TEXT,
    quotas TEXT,
    sheets TEXT,
    notify TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_survey ON projects(survey_id);
`);
migrateToProjects();
if (!(db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some((c) => c.name === 'panels')) {
  db.exec('ALTER TABLE projects ADD COLUMN panels TEXT');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    login TEXT PRIMARY KEY COLLATE NOCASE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
`);
if (!(db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some((c) => c.name === 'projects')) {
  db.exec('ALTER TABLE users ADD COLUMN projects TEXT');
}

/**
 * Переход на проекты (один раз): каждая анкета становится проектом с тем же ID — ссылки респондентов и ответы
 * сохраняются. Настройки сбора, квоты, Google Sheets и уведомления переезжают из анкеты в проект.
 */
function migrateToProjects() {
  const cols = (db.prepare('PRAGMA table_info(responses)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('project_id')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const t = new Date().toISOString();
    for (const s of db.prepare('SELECT * FROM surveys').all() as Record<string, unknown>[]) {
      const draft = JSON.parse(s.draft as string) as Survey;
      const live = s.published ? (JSON.parse(s.published as string) as Survey) : null;
      const src = live ?? draft;
      const settings: Record<string, unknown> = {};
      for (const k of ['openFrom', 'closeAt', 'maxResponses', 'password', 'allowRetake', 'uniqueParam', 'maxStartsPerIpHour', 'minDurationSec']) {
        const v = (src.settings as Record<string, unknown> | undefined)?.[k];
        if (v !== undefined) settings[k] = v;
      }
      const status: ProjectStatus = s.archived === 1 ? 'archive' : s.status === 'active' ? 'collecting' : s.status === 'closed' ? 'processing' : 'development';
      db.prepare(`INSERT INTO projects (id, title, survey_id, status, settings, quotas, sheets, notify, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        s.id as string, s.title as string, s.id as string, status,
        Object.keys(settings).length ? JSON.stringify(settings) : null,
        src.quotas?.length ? JSON.stringify(src.quotas) : null,
        (s.sheets as string) ?? null, (s.notify as string) ?? null, (s.created_at as string) ?? t, t,
      );
      db.prepare('UPDATE surveys SET draft = ?, published = ?, archived = 0 WHERE id = ?').run(
        JSON.stringify(stripProjectFields(draft)), live ? JSON.stringify(stripProjectFields(live)) : null, s.id as string,
      );
    }
    db.exec(`
      CREATE TABLE responses_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        is_test INTEGER NOT NULL DEFAULT 0,
        answers TEXT NOT NULL DEFAULT '{}',
        history TEXT NOT NULL DEFAULT '[]',
        current_page TEXT,
        params TEXT NOT NULL DEFAULT '{}',
        ip TEXT,
        user_agent TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        duration_sec INTEGER,
        ending TEXT,
        timings TEXT,
        rejected INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO responses_new (id, project_id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent,
        started_at, updated_at, completed_at, duration_sec, ending, timings, rejected)
        SELECT id, survey_id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent,
        started_at, updated_at, completed_at, duration_sec, ending, timings, rejected FROM responses;
      DROP TABLE responses;
      ALTER TABLE responses_new RENAME TO responses;
      CREATE INDEX responses_project ON responses(project_id, is_test, status);
      CREATE INDEX responses_survey ON responses(survey_id);
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Согласованная копия базы в файл (работает, пока сервис принимает ответы) */
export function backupTo(file: string): void {
  db.prepare('VACUUM INTO ?').run(file);
}

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
  sheets: SheetsConfig | null;
  notify: NotifyConfig | null;
  createdAt: string;
  updatedAt: string;
}

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
const paramPath = (key: string) => `$."${key.replace(/"/g, '')}"`;

export function median(list: number[]): number | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
type Row = Record<string, unknown>;

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
  };
}

export const surveys = {
  async list(): Promise<{ id: string; title: string; version: number; archived: boolean; createdAt: string; updatedAt: string; projects: number; unpublished: boolean }[]> {
    const rows = db.prepare(`SELECT s.id, s.title, s.version, s.archived, s.created_at, s.updated_at, (s.published IS NULL OR s.published <> s.draft) AS unpublished,
      (SELECT COUNT(*) FROM projects p WHERE p.survey_id = s.id) AS projects FROM surveys s ORDER BY s.updated_at DESC`).all() as Row[];
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, version: r.version as number, archived: r.archived === 1,
      createdAt: r.created_at as string, updatedAt: r.updated_at as string, projects: r.projects as number, unpublished: r.unpublished === 1,
    }));
  },

  async get(id: string): Promise<SurveyRow | null> {
    const r = db.prepare('SELECT * FROM surveys WHERE id = ?').get(id) as Row | undefined;
    return r ? toSurvey(r) : null;
  },

  async create(def: Survey): Promise<SurveyRow> {
    const id = newId(8);
    const t = now();
    db.prepare('INSERT INTO surveys (id, title, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, def.title, JSON.stringify(def), t, t);
    return (await this.get(id))!;
  },

  async saveDraft(id: string, def: Survey): Promise<void> {
    db.prepare('UPDATE surveys SET draft = ?, title = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(def), def.title, now(), id);
  },

  async publish(id: string, by: string | null = null): Promise<number> {
    const s = (await this.get(id))!;
    const version = s.version + 1;
    const t = now();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE surveys SET published = draft, version = ?, updated_at = ? WHERE id = ?').run(version, t, id);
      db.prepare('INSERT INTO survey_versions (survey_id, version, definition, published_at, published_by) VALUES (?, ?, ?, ?, ?)')
        .run(id, version, JSON.stringify(s.draft), t, by);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return version;
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    db.prepare('UPDATE surveys SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  },

  async versions(id: string): Promise<SurveyVersion[]> {
    const rows = db.prepare('SELECT version, definition, published_at, published_by FROM survey_versions WHERE survey_id = ? ORDER BY version DESC').all(id) as Row[];
    return rows.map((r) => {
      const def = migrateSurvey(JSON.parse(r.definition as string)) as Survey;
      return {
        version: r.version as number, publishedAt: r.published_at as string, publishedBy: (r.published_by as string) ?? null,
        questions: def.blocks.reduce((n, b) => n + b.questions.length, 0),
      };
    });
  },

  async version(id: string, version: number): Promise<Survey | null> {
    const r = db.prepare('SELECT definition FROM survey_versions WHERE survey_id = ? AND version = ?').get(id, version) as Row | undefined;
    return r ? (migrateSurvey(JSON.parse(r.definition as string)) as Survey) : null;
  },

  async remove(id: string): Promise<void> {
    db.prepare('DELETE FROM surveys WHERE id = ?').run(id);
  },
};

export const projects = {
  async list(): Promise<(ProjectRow & { surveyTitle: string; counts: Record<string, number> })[]> {
    const rows = db.prepare(`SELECT p.*, s.title AS survey_title FROM projects p JOIN surveys s ON s.id = p.survey_id ORDER BY p.updated_at DESC`).all() as Row[];
    const counts = db.prepare(
      'SELECT project_id, status, COUNT(*) AS n FROM responses WHERE is_test = 0 AND rejected = 0 AND project_id IS NOT NULL GROUP BY project_id, status',
    ).all() as Row[];
    return rows.map((r) => {
      const c: Record<string, number> = {};
      for (const x of counts) if (x.project_id === r.id) c[x.status as string] = x.n as number;
      return { ...toProject(r), surveyTitle: r.survey_title as string, counts: c };
    });
  },

  async get(id: string): Promise<ProjectRow | null> {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r) : null;
  },

  async bySurvey(surveyId: string): Promise<ProjectRow[]> {
    return (db.prepare('SELECT * FROM projects WHERE survey_id = ? ORDER BY created_at').all(surveyId) as Row[]).map(toProject);
  },

  async create(p: { title: string; surveyId: string }): Promise<ProjectRow> {
    let id = newId(8);
    // ID проекта — в ссылке респондента (/s/ID): не должен совпадать с ID анкеты
    while (db.prepare('SELECT 1 FROM surveys WHERE id = ? UNION SELECT 1 FROM projects WHERE id = ?').get(id, id)) id = newId(8);
    const t = now();
    db.prepare('INSERT INTO projects (id, title, survey_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, p.title, p.surveyId, t, t);
    return (await this.get(id))!;
  },

  async update(id: string, patch: { title?: string; surveyId?: string; status?: ProjectStatus; settings?: ProjectSettings; quotas?: Quota[]; panels?: Panel[] }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: (string | null)[] = [now()];
    if (patch.title !== undefined) { sets.push('title = ?'); vals.push(patch.title); }
    if (patch.surveyId !== undefined) { sets.push('survey_id = ?'); vals.push(patch.surveyId); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.settings !== undefined) { sets.push('settings = ?'); vals.push(Object.keys(patch.settings).length ? JSON.stringify(patch.settings) : null); }
    if (patch.quotas !== undefined) { sets.push('quotas = ?'); vals.push(patch.quotas.length ? JSON.stringify(patch.quotas) : null); }
    if (patch.panels !== undefined) { sets.push('panels = ?'); vals.push(patch.panels.length ? JSON.stringify(patch.panels) : null); }
    vals.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  /** Копия проекта (новая волна): анкета, настройки сбора, квоты и панели — без ответов, в статусе «Разработка» */
  async copy(id: string, title: string): Promise<ProjectRow> {
    const src = (await this.get(id))!;
    const p = await this.create({ title, surveyId: src.surveyId });
    await this.update(p.id, { settings: src.settings, quotas: src.quotas, panels: src.panels });
    return (await this.get(p.id))!;
  },

  async setNotify(id: string, notify: NotifyConfig | null): Promise<void> {
    db.prepare('UPDATE projects SET notify = ? WHERE id = ?').run(notify ? JSON.stringify(notify) : null, id);
  },

  async setSheets(id: string, sheets: SheetsConfig | null): Promise<void> {
    db.prepare('UPDATE projects SET sheets = ? WHERE id = ?').run(sheets ? JSON.stringify(sheets) : null, id);
  },

  async remove(id: string): Promise<void> {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },
};

export const responses = {
  async create(r: Omit<StoredResponse, 'id' | 'updatedAt' | 'completedAt' | 'durationSec'>): Promise<StoredResponse> {
    const id = newId(12);
    const t = now();
    db.prepare(`INSERT INTO responses
      (id, project_id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, r.projectId, r.surveyId, r.version, r.status, r.isTest ? 1 : 0, JSON.stringify(r.answers), JSON.stringify(r.history),
      r.currentPage, JSON.stringify(r.params), r.ip, r.userAgent, r.startedAt, t,
    );
    return (await this.get(id))!;
  },

  async get(id: string): Promise<StoredResponse | null> {
    const r = db.prepare('SELECT * FROM responses WHERE id = ?').get(id) as Row | undefined;
    return r ? toResponse(r) : null;
  },

  async update(id: string, patch: {
    answers?: Answers; history?: string[]; currentPage?: string | null; status?: ResponseStatus;
    completedAt?: string | null; durationSec?: number | null; version?: number;
    ending?: { message?: string; redirect?: string } | null;
    timings?: Record<string, number>; rejected?: boolean;
  }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const vals: (string | number | null)[] = [now()];
    if (patch.answers !== undefined) { sets.push('answers = ?'); vals.push(JSON.stringify(patch.answers)); }
    if (patch.history !== undefined) { sets.push('history = ?'); vals.push(JSON.stringify(patch.history)); }
    if (patch.currentPage !== undefined) { sets.push('current_page = ?'); vals.push(patch.currentPage); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); vals.push(patch.completedAt); }
    if (patch.durationSec !== undefined) { sets.push('duration_sec = ?'); vals.push(patch.durationSec); }
    if (patch.version !== undefined) { sets.push('version = ?'); vals.push(patch.version); }
    if (patch.timings !== undefined) { sets.push('timings = ?'); vals.push(JSON.stringify(patch.timings)); }
    if (patch.rejected !== undefined) { sets.push('rejected = ?'); vals.push(patch.rejected ? 1 : 0); }
    if (patch.ending !== undefined) { sets.push('ending = ?'); vals.push(patch.ending ? JSON.stringify(patch.ending) : null); }
    vals.push(id);
    db.prepare(`UPDATE responses SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  /** Ответы проекта; бракованные — только с includeRejected, from / to — по времени начала (ISO) */
  async list(projectId: string, opts: {
    includeTest?: boolean; statuses?: ResponseStatus[]; includeRejected?: boolean; from?: string; to?: string;
  } = {}): Promise<StoredResponse[]> {
    let sql = 'SELECT * FROM responses WHERE project_id = ?';
    const vals: (string | number)[] = [projectId];
    if (!opts.includeTest) sql += ' AND is_test = 0';
    if (!opts.includeRejected) sql += ' AND rejected = 0';
    if (opts.from) { sql += ' AND started_at >= ?'; vals.push(opts.from); }
    if (opts.to) { sql += ' AND started_at < ?'; vals.push(opts.to); }
    if (opts.statuses?.length) {
      sql += ` AND status IN (${opts.statuses.map(() => '?').join(',')})`;
      vals.push(...opts.statuses);
    }
    sql += ' ORDER BY started_at';
    return (db.prepare(sql).all(...vals) as Row[]).map(toResponse);
  },

  /** Последняя настоящая (не тестовая) анкета с этими значениями параметров ссылки */
  async findByParam(projectId: string, match: Record<string, string>): Promise<StoredResponse | null> {
    const keys = Object.keys(match);
    const r = db.prepare(`SELECT * FROM responses WHERE project_id = ? AND is_test = 0
      ${keys.map(() => 'AND json_extract(params, ?) = ?').join(' ')} ORDER BY started_at DESC LIMIT 1`)
      .get(projectId, ...keys.flatMap((k) => [paramPath(k), match[k]])) as Row | undefined;
    return r ? toResponse(r) : null;
  },

  /** Сколько настоящих завершённых анкет пришло с панели */
  async completedFromPanel(projectId: string, panel: string): Promise<number> {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM responses WHERE project_id = ? AND is_test = 0 AND rejected = 0
      AND status = 'completed' AND json_extract(params, ?) = ?`).get(projectId, paramPath(PANEL_PARAM), panel) as Row;
    return r.n as number;
  },

  /** Настоящие (не бракованные) анкеты для динамики по дням: начало, окончание, статус, панель */
  async timeline(projectId: string): Promise<{ startedAt: string; completedAt: string | null; status: ResponseStatus; panel: string | null }[]> {
    return (db.prepare(`SELECT started_at, completed_at, status, json_extract(params, ?) AS panel FROM responses
      WHERE project_id = ? AND is_test = 0 AND rejected = 0`).all(paramPath(PANEL_PARAM), projectId) as Row[])
      .map((r) => ({
        startedAt: r.started_at as string, completedAt: (r.completed_at as string) ?? null, status: r.status as ResponseStatus,
        panel: r.panel === null || r.panel === '' ? null : String(r.panel),
      }));
  },

  /** Счётчики настоящих анкет по панелям (источникам) */
  async countsByPanel(projectId: string): Promise<PanelCounts[]> {
    const rows = db.prepare(`SELECT json_extract(params, ?) AS panel, status, rejected, COUNT(*) AS n FROM responses
      WHERE project_id = ? AND is_test = 0 GROUP BY panel, status, rejected`).all(paramPath(PANEL_PARAM), projectId) as Row[];
    const out = new Map<string | null, PanelCounts>();
    const of = (panel: string | null) => {
      if (!out.has(panel)) out.set(panel, { panel, statuses: {}, rejected: 0, medianSec: null });
      return out.get(panel)!;
    };
    for (const r of rows) {
      const c = of(r.panel === null || r.panel === '' ? null : String(r.panel));
      if (r.rejected === 1) c.rejected += r.n as number;
      else c.statuses[r.status as string] = (c.statuses[r.status as string] ?? 0) + (r.n as number);
    }
    const durations = db.prepare(`SELECT json_extract(params, ?) AS panel, duration_sec AS d FROM responses
      WHERE project_id = ? AND is_test = 0 AND rejected = 0 AND status = 'completed' AND duration_sec IS NOT NULL`)
      .all(paramPath(PANEL_PARAM), projectId) as Row[];
    const byPanel = new Map<string | null, number[]>();
    for (const r of durations) {
      const k = r.panel === null || r.panel === '' ? null : String(r.panel);
      byPanel.set(k, [...(byPanel.get(k) ?? []), r.d as number]);
    }
    for (const [k, list] of byPanel) of(k).medianSec = median(list);
    return [...out.values()];
  },

  /** Сколько настоящих анкет начато с этого IP за последние sinceSec секунд */
  async countByIp(projectId: string, ip: string, sinceSec: number): Promise<number> {
    const since = new Date(Date.now() - sinceSec * 1000).toISOString();
    const r = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE project_id = ? AND is_test = 0 AND ip = ? AND started_at >= ?')
      .get(projectId, ip, since) as Row;
    return r.n as number;
  },

  /** Счётчики по статусам; бракованные анкеты считаются отдельно (rejected) и в статусы не входят */
  async counts(projectId: string): Promise<{ real: Record<string, number>; test: number; rejected: number }> {
    const rows = db.prepare('SELECT is_test, status, rejected, COUNT(*) AS n FROM responses WHERE project_id = ? GROUP BY is_test, status, rejected')
      .all(projectId) as Row[];
    const real: Record<string, number> = {};
    let test = 0;
    let rejected = 0;
    for (const r of rows) {
      if (r.is_test === 1) test += r.n as number;
      else if (r.rejected === 1) rejected += r.n as number;
      else real[r.status as string] = (real[r.status as string] ?? 0) + (r.n as number);
    }
    return { real, test, rejected };
  },

  async remove(id: string): Promise<void> {
    db.prepare('DELETE FROM responses WHERE id = ?').run(id);
  },

  async deleteTest(projectId: string): Promise<number> {
    return Number(db.prepare('DELETE FROM responses WHERE project_id = ? AND is_test = 1').run(projectId).changes);
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
    return (db.prepare('SELECT * FROM users ORDER BY login').all() as Row[]).map(toUser);
  },
  async get(login: string): Promise<(UserRow & { passwordHash: string }) | null> {
    const r = db.prepare('SELECT * FROM users WHERE login = ?').get(login) as Row | undefined;
    return r ? { ...toUser(r), passwordHash: r.password as string } : null;
  },
  async create(login: string, passwordHash: string, role: Role): Promise<void> {
    db.prepare('INSERT INTO users (login, password, role, created_at) VALUES (?, ?, ?, ?)').run(login, passwordHash, role, now());
  },
  async update(login: string, patch: { passwordHash?: string; role?: Role; disabled?: boolean; projects?: string[] }): Promise<void> {
    if (patch.projects !== undefined) db.prepare('UPDATE users SET projects = ? WHERE login = ?').run(patch.projects.length ? JSON.stringify(patch.projects) : null, login);
    if (patch.passwordHash !== undefined) db.prepare('UPDATE users SET password = ? WHERE login = ?').run(patch.passwordHash, login);
    if (patch.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE login = ?').run(patch.role, login);
    if (patch.disabled !== undefined) db.prepare('UPDATE users SET disabled = ? WHERE login = ?').run(patch.disabled ? 1 : 0, login);
  },
  async touch(login: string): Promise<void> {
    db.prepare('UPDATE users SET last_login_at = ? WHERE login = ?').run(now(), login);
  },
  async remove(login: string): Promise<void> {
    db.prepare('DELETE FROM users WHERE login = ?').run(login);
  },
};

// ---- OAuth для ИИ-коннекторов (Claude, ChatGPT) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    login TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    scope TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    login TEXT NOT NULL COLLATE NOCASE,
    scope TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_login ON oauth_tokens(login);
`);

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
    db.prepare('INSERT INTO oauth_clients (id, name, secret_hash, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, c.name, c.secretHash, JSON.stringify(c.redirectUris), now());
    return (await this.client(id))!;
  },
  async client(id: string): Promise<OAuthClient | null> {
    const r = db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id) as Row | undefined;
    return r ? toClient(r) : null;
  },
  async saveCode(codeHash: string, g: OAuthGrant & { redirectUri: string; challenge: string }): Promise<void> {
    db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO oauth_codes (code_hash, client_id, login, redirect_uri, challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(codeHash, g.clientId, g.login, g.redirectUri, g.challenge, g.scope, g.expiresAt);
  },
  /** Код одноразовый: читается и сразу удаляется */
  async takeCode(codeHash: string): Promise<(OAuthGrant & { redirectUri: string; challenge: string }) | null> {
    const r = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as Row | undefined;
    if (!r) return null;
    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
    if ((r.expires_at as string) < now()) return null;
    return {
      clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null,
      expiresAt: r.expires_at as string, redirectUri: r.redirect_uri as string, challenge: r.challenge as string,
    };
  },
  async saveToken(tokenHash: string, kind: 'access' | 'refresh', g: OAuthGrant): Promise<void> {
    db.prepare('INSERT INTO oauth_tokens (token_hash, kind, client_id, login, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash, kind, g.clientId, g.login, g.scope, g.expiresAt, now());
  },
  /** Действующий токен (просроченные удаляются) */
  async token(tokenHash: string, kind: 'access' | 'refresh'): Promise<OAuthGrant | null> {
    const r = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?').get(tokenHash, kind) as Row | undefined;
    if (!r) return null;
    if ((r.expires_at as string) < now()) {
      db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    if (kind === 'access') db.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE token_hash = ?').run(now(), tokenHash);
    return { clientId: r.client_id as string, login: r.login as string, scope: (r.scope as string) ?? null, expiresAt: r.expires_at as string };
  },
  async deleteToken(tokenHash: string): Promise<void> {
    db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
  },
  /** Подключённые приложения пользователя: по клиенту — когда выдан доступ и когда им пользовались */
  async connections(login: string): Promise<{ clientId: string; name: string; since: string; lastUsedAt: string | null }[]> {
    const rows = db.prepare(`SELECT t.client_id, c.name, MIN(t.created_at) AS since, MAX(t.last_used_at) AS last_used
      FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE t.login = ? AND t.expires_at >= ?
      GROUP BY t.client_id, c.name ORDER BY since`).all(login, now()) as Row[];
    return rows.map((r) => ({
      clientId: r.client_id as string, name: r.name as string, since: r.since as string, lastUsedAt: (r.last_used as string) ?? null,
    }));
  },
  /** Отозвать доступ приложения (или всех приложений, если clientId не задан) */
  async revoke(login: string, clientId?: string): Promise<number> {
    const res = clientId
      ? db.prepare('DELETE FROM oauth_tokens WHERE login = ? AND client_id = ?').run(login, clientId)
      : db.prepare('DELETE FROM oauth_tokens WHERE login = ?').run(login);
    return Number(res.changes);
  },
};
