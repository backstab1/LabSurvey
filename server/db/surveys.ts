// Анкеты: черновик, опубликованная версия и история версий.
// Старые столбцы status, sheets, notify читает только перенос в проекты (schema.ts).
import type { Row } from '../sql.ts';
import { flag, newId, now, sql } from './connection.ts';
import { migrateSurvey } from '../../shared/migrate.ts';
import type { Survey } from '../../shared/types.ts';

export interface SurveyRow {
  id: string;
  title: string;
  draft: Survey;
  published: Survey | null;
  version: number;
  /** В архиве: скрыта из основного списка, сбор закрыт */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SurveyVersion {
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  questions: number;
}

/** Анкеты старого формата переводятся в текущий при чтении */
const readDef = (v: unknown) => migrateSurvey(JSON.parse(v as string)) as Survey;

function toSurvey(r: Row): SurveyRow {
  return {
    id: r.id as string,
    title: r.title as string,
    draft: readDef(r.draft),
    published: r.published ? readDef(r.published) : null,
    version: r.version as number,
    archived: r.archived === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

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
    return rows.map((r) => ({
      version: r.version as number, publishedAt: r.published_at as string, publishedBy: (r.published_by as string) ?? null,
      questions: readDef(r.definition).blocks.reduce((n, b) => n + b.questions.length, 0),
    }));
  },

  async version(id: string, version: number): Promise<Survey | null> {
    const r = await sql.get('SELECT definition FROM survey_versions WHERE survey_id = ? AND version = ?', [id, version]);
    return r ? readDef(r.definition) : null;
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM surveys WHERE id = ?', [id]);
  },
};
