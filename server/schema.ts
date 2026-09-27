// Схема базы для SQLite и PostgreSQL. SQLite-базы, созданные старыми версиями, доводятся до текущей схемы;
// в PostgreSQL схема создаётся сразу в текущем виде.
import type { DatabaseSync } from 'node:sqlite';
import { sqliteHandle, type Sql } from './sql.ts';
import { stripProjectFields, type ProjectStatus, type Survey } from '../shared/types.ts';

/** SQLite: таблицы создавались по мере развития сервиса — старые базы доводятся до текущей схемы */
function initSqlite(db: DatabaseSync) {
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const addCol = (table: string, col: string, def: string) => { if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
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
  addCol('surveys', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  addCol('surveys', 'notify', 'TEXT');
  addCol('responses', 'ending', 'TEXT');
  addCol('responses', 'timings', 'TEXT');
  addCol('responses', 'rejected', 'INTEGER NOT NULL DEFAULT 0');
  addCol('survey_versions', 'published_by', 'TEXT');
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
  migrateToProjects(db);
  // Пометки качества ответа (после перехода на проекты — он пересоздаёт таблицу ответов)
  addCol('responses', 'flags', 'TEXT');
  addCol('projects', 'panels', 'TEXT');
  addCol('projects', 'tables', 'TEXT');
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
  addCol('users', 'projects', 'TEXT');
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

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      login TEXT,
      via TEXT NOT NULL DEFAULT 'ui',
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_title TEXT,
      details TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    CREATE INDEX IF NOT EXISTS audit_target ON audit(target_type, target_id);

    CREATE TABLE IF NOT EXISTS invitees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      ext_id TEXT,
      fields TEXT NOT NULL DEFAULT '{}',
      response_id TEXT,
      opened_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invitees_project ON invitees(project_id);
    CREATE TABLE IF NOT EXISTS mailings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      audience TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      email_field TEXT NOT NULL,
      base_url TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      finished_at TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS mailings_project ON mailings(project_id);
  `);
  // Рассылка: письмо в очереди (ID рассылки), когда ушло последнее, сколько всего, последняя ошибка
  addCol('invitees', 'mail_pending', 'INTEGER');
  addCol('invitees', 'mail_sent_at', 'TEXT');
  addCol('invitees', 'mail_count', 'INTEGER NOT NULL DEFAULT 0');
  addCol('invitees', 'mail_error', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS invitees_mail_pending ON invitees(mail_pending)');
}

/**
 * PostgreSQL: схема сразу в текущем виде. Новые столбцы в будущем — через ADD COLUMN IF NOT EXISTS ниже.
 * Типы — как в SQLite (TEXT для JSON и дат ISO, INTEGER для флагов): код и выгрузки одинаковы для обеих баз.
 */
const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    draft TEXT NOT NULL,
    published TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    sheets TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    notify TEXT
  );
  CREATE TABLE IF NOT EXISTS survey_versions (
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    published_at TEXT NOT NULL,
    published_by TEXT,
    PRIMARY KEY (survey_id, version)
  );
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
    updated_at TEXT NOT NULL,
    panels TEXT,
    tables TEXT
  );
  CREATE INDEX IF NOT EXISTS projects_survey ON projects(survey_id);
  CREATE TABLE IF NOT EXISTS responses (
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
    rejected INTEGER NOT NULL DEFAULT 0,
    flags TEXT
  );
  CREATE INDEX IF NOT EXISTS responses_project ON responses(project_id, is_test, status);
  CREATE INDEX IF NOT EXISTS responses_survey ON responses(survey_id);
  CREATE TABLE IF NOT EXISTS users (
    login TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    projects TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_login_ci ON users(lower(login));
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
    login TEXT NOT NULL,
    scope TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_login ON oauth_tokens(lower(login));
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL,
    login TEXT,
    via TEXT NOT NULL DEFAULT 'ui',
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    target_title TEXT,
    details TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
  CREATE INDEX IF NOT EXISTS audit_target ON audit(target_type, target_id);
  CREATE TABLE IF NOT EXISTS invitees (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    ext_id TEXT,
    fields TEXT NOT NULL DEFAULT '{}',
    response_id TEXT,
    opened_at TEXT,
    created_at TEXT NOT NULL,
    mail_pending INTEGER,
    mail_sent_at TEXT,
    mail_count INTEGER NOT NULL DEFAULT 0,
    mail_error TEXT
  );
  CREATE INDEX IF NOT EXISTS invitees_project ON invitees(project_id);
  CREATE INDEX IF NOT EXISTS invitees_mail_pending ON invitees(mail_pending);
  CREATE TABLE IF NOT EXISTS mailings (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    email_field TEXT NOT NULL,
    base_url TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    finished_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS mailings_project ON mailings(project_id);
`;

/** Таблицы в порядке зависимостей — для переноса данных и резервных копий */
export const TABLES = ['surveys', 'survey_versions', 'projects', 'responses', 'users', 'oauth_clients', 'oauth_codes', 'oauth_tokens', 'audit', 'invitees', 'mailings'] as const;
/** Таблицы с автоматическим числовым id (в PostgreSQL после переноса данных сдвигается счётчик) */
export const IDENTITY_TABLES = ['audit', 'invitees', 'mailings'] as const;

/**
 * Переход на проекты (один раз, только старые базы SQLite): каждая анкета становится проектом с тем же ID — ссылки
 * респондентов и ответы сохраняются. Настройки сбора, квоты, Google Sheets и уведомления переезжают из анкеты в проект.
 */
function migrateToProjects(db: DatabaseSync) {
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

/** Создать таблицы (и довести старую SQLite-базу до текущей схемы) */
export async function initSchema(sql: Sql): Promise<void> {
  if (sql.kind === 'postgres') await sql.exec(PG_SCHEMA);
  else initSqlite(sqliteHandle(sql)!);
}
