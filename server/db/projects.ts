// Проекты: сбор ответов по анкете — настройки, квоты, панели, наборы таблиц, интеграции
import type { Row } from '../sql.ts';
import { enc, jsonGet, jsonKey, newId, now, parseJson, sql, updateRow } from './connection.ts';
import type { DashboardConfig, Panel, ProjectSettings, ProjectStatus, Quota } from '../../shared/types.ts';
import type { SheetsConfig, NotifyConfig, TableSet } from '../../shared/api.ts';
export type { SheetsConfig, NotifyConfig, TableSet };

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
  /** Живой дашборд для заказчика */
  dashboard: DashboardConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPatch {
  title?: string; surveyId?: string; status?: ProjectStatus; settings?: ProjectSettings; quotas?: Quota[]; panels?: Panel[]; tables?: TableSet[];
  dashboard?: DashboardConfig | null;
}

const toProject = (r: Row): ProjectRow => ({
  id: r.id as string,
  title: r.title as string,
  surveyId: r.survey_id as string,
  status: r.status as ProjectStatus,
  settings: parseJson(r.settings, {}),
  quotas: parseJson(r.quotas, []),
  panels: parseJson(r.panels, []),
  tables: parseJson(r.tables, []),
  sheets: parseJson(r.sheets, null),
  notify: parseJson(r.notify, null),
  dashboard: parseJson(r.dashboard, null),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

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

  async update(id: string, patch: ProjectPatch): Promise<void> {
    await updateRow('projects', 'id = ?', id, patch, {
      title: 'title', surveyId: 'survey_id', status: 'status',
      settings: ['settings', enc.jsonOrNull], quotas: ['quotas', enc.jsonOrNull], panels: ['panels', enc.jsonOrNull], tables: ['tables', enc.jsonOrNull],
      dashboard: ['dashboard', enc.nullableJson],
    }, [['updated_at', now()]]);
  },

  /** Проект по секретному адресу дашборда (только включённый) */
  async byDashboard(token: string): Promise<ProjectRow | null> {
    const r = await sql.get(`SELECT * FROM projects WHERE ${jsonGet('dashboard')} = ?`, [jsonKey('token'), token]);
    const p = r ? toProject(r) : null;
    return p?.dashboard?.enabled && p.dashboard.token === token ? p : null;
  },

  /** Копия проекта (новая волна): анкета, настройки сбора, квоты и панели — без ответов, в статусе «Разработка» */
  async copy(id: string, title: string): Promise<ProjectRow> {
    const src = (await this.get(id))!;
    const p = await this.create({ title, surveyId: src.surveyId });
    await this.update(p.id, { settings: src.settings, quotas: src.quotas, panels: src.panels, tables: src.tables });
    return (await this.get(p.id))!;
  },

  async setNotify(id: string, notify: NotifyConfig | null): Promise<void> {
    await sql.run('UPDATE projects SET notify = ? WHERE id = ?', [enc.nullableJson(notify), id]);
  },

  async setSheets(id: string, sheets: SheetsConfig | null): Promise<void> {
    await sql.run('UPDATE projects SET sheets = ? WHERE id = ?', [enc.nullableJson(sheets), id]);
  },

  async remove(id: string): Promise<void> {
    await sql.run('DELETE FROM projects WHERE id = ?', [id]);
  },
};
