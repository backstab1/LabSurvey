// Хранилище. Сейчас SQLite (встроенный node:sqlite); методы асинхронные,
// чтобы переход на PostgreSQL не менял код маршрутов.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import type { Answers, Survey } from '../shared/types.ts';
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
  questions: number;
}

export interface StoredResponse extends ResponseRecord {
  surveyId: string;
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

function toResponse(r: Row): StoredResponse {
  return {
    id: r.id as string,
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
  };
}

export const surveys = {
  async list(): Promise<(Omit<SurveyRow, 'draft' | 'published' | 'notify'> & { counts: Record<string, number> })[]> {
    const rows = db.prepare('SELECT id, title, version, status, sheets, archived, created_at, updated_at FROM surveys ORDER BY updated_at DESC').all() as Row[];
    const counts = db.prepare(
      'SELECT survey_id, status, COUNT(*) AS n FROM responses WHERE is_test = 0 GROUP BY survey_id, status',
    ).all() as Row[];
    return rows.map((r) => {
      const c: Record<string, number> = {};
      for (const x of counts) if (x.survey_id === r.id) c[x.status as string] = x.n as number;
      return {
        id: r.id as string, title: r.title as string, version: r.version as number, status: r.status as SurveyStatus,
        sheets: r.sheets ? JSON.parse(r.sheets as string) : null, archived: r.archived === 1,
        createdAt: r.created_at as string, updatedAt: r.updated_at as string, counts: c,
      };
    });
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

  async publish(id: string): Promise<number> {
    const s = (await this.get(id))!;
    const version = s.version + 1;
    const t = now();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE surveys SET published = draft, version = ?, status = CASE status WHEN \'draft\' THEN \'active\' ELSE status END, updated_at = ? WHERE id = ?')
        .run(version, t, id);
      db.prepare('INSERT INTO survey_versions (survey_id, version, definition, published_at) VALUES (?, ?, ?, ?)')
        .run(id, version, JSON.stringify(s.draft), t);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return version;
  },

  async setStatus(id: string, status: SurveyStatus): Promise<void> {
    db.prepare('UPDATE surveys SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    // Архивная анкета не собирает ответы
    db.prepare(`UPDATE surveys SET archived = ?, status = CASE WHEN ? = 1 AND status = 'active' THEN 'closed' ELSE status END WHERE id = ?`)
      .run(archived ? 1 : 0, archived ? 1 : 0, id);
  },

  async versions(id: string): Promise<SurveyVersion[]> {
    const rows = db.prepare('SELECT version, definition, published_at FROM survey_versions WHERE survey_id = ? ORDER BY version DESC').all(id) as Row[];
    return rows.map((r) => {
      const def = migrateSurvey(JSON.parse(r.definition as string)) as Survey;
      return { version: r.version as number, publishedAt: r.published_at as string, questions: def.blocks.reduce((n, b) => n + b.questions.length, 0) };
    });
  },

  async version(id: string, version: number): Promise<Survey | null> {
    const r = db.prepare('SELECT definition FROM survey_versions WHERE survey_id = ? AND version = ?').get(id, version) as Row | undefined;
    return r ? (migrateSurvey(JSON.parse(r.definition as string)) as Survey) : null;
  },

  async setNotify(id: string, notify: NotifyConfig | null): Promise<void> {
    db.prepare('UPDATE surveys SET notify = ? WHERE id = ?').run(notify ? JSON.stringify(notify) : null, id);
  },

  async setSheets(id: string, sheets: SheetsConfig | null): Promise<void> {
    db.prepare('UPDATE surveys SET sheets = ? WHERE id = ?').run(sheets ? JSON.stringify(sheets) : null, id);
  },

  async remove(id: string): Promise<void> {
    db.prepare('DELETE FROM surveys WHERE id = ?').run(id);
  },
};

export const responses = {
  async create(r: Omit<StoredResponse, 'id' | 'updatedAt' | 'completedAt' | 'durationSec'>): Promise<StoredResponse> {
    const id = newId(12);
    const t = now();
    db.prepare(`INSERT INTO responses
      (id, survey_id, version, status, is_test, answers, history, current_page, params, ip, user_agent, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, r.surveyId, r.version, r.status, r.isTest ? 1 : 0, JSON.stringify(r.answers), JSON.stringify(r.history),
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
    vals.push(id);
    db.prepare(`UPDATE responses SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  async list(surveyId: string, opts: { includeTest?: boolean; statuses?: ResponseStatus[] } = {}): Promise<StoredResponse[]> {
    let sql = 'SELECT * FROM responses WHERE survey_id = ?';
    const vals: (string | number)[] = [surveyId];
    if (!opts.includeTest) sql += ' AND is_test = 0';
    if (opts.statuses?.length) {
      sql += ` AND status IN (${opts.statuses.map(() => '?').join(',')})`;
      vals.push(...opts.statuses);
    }
    sql += ' ORDER BY started_at';
    return (db.prepare(sql).all(...vals) as Row[]).map(toResponse);
  },

  /** Последняя настоящая (не тестовая) анкета с этим значением параметра ссылки */
  async findByParam(surveyId: string, key: string, value: string): Promise<StoredResponse | null> {
    const r = db.prepare(`SELECT * FROM responses WHERE survey_id = ? AND is_test = 0 AND json_extract(params, ?) = ?
      ORDER BY started_at DESC LIMIT 1`).get(surveyId, `$."${key.replace(/"/g, '')}"`, value) as Row | undefined;
    return r ? toResponse(r) : null;
  },

  /** Сколько настоящих анкет начато с этого IP за последние sinceSec секунд */
  async countByIp(surveyId: string, ip: string, sinceSec: number): Promise<number> {
    const since = new Date(Date.now() - sinceSec * 1000).toISOString();
    const r = db.prepare('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND is_test = 0 AND ip = ? AND started_at >= ?')
      .get(surveyId, ip, since) as Row;
    return r.n as number;
  },

  async counts(surveyId: string): Promise<{ real: Record<string, number>; test: number }> {
    const rows = db.prepare('SELECT is_test, status, COUNT(*) AS n FROM responses WHERE survey_id = ? GROUP BY is_test, status')
      .all(surveyId) as Row[];
    const real: Record<string, number> = {};
    let test = 0;
    for (const r of rows) {
      if (r.is_test === 1) test += r.n as number;
      else real[r.status as string] = r.n as number;
    }
    return { real, test };
  },

  async remove(id: string): Promise<void> {
    db.prepare('DELETE FROM responses WHERE id = ?').run(id);
  },

  async deleteTest(surveyId: string): Promise<number> {
    return Number(db.prepare('DELETE FROM responses WHERE survey_id = ? AND is_test = 1').run(surveyId).changes);
  },
};
