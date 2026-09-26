import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// База «до проектов»: анкета со статусом, настройками сбора, квотой и ответом
const dir = mkdtempSync(join(tmpdir(), 'surveylab-migrate-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'secret';
const survey = {
  formatVersion: 2, title: 'Старая анкета',
  settings: { password: 'kod', maxResponses: 50, completeMessage: 'Спасибо!' },
  quotas: [{ id: 'QT1', if: { q: 'Q1', op: 'eq', value: 1 }, limit: 10 }],
  blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'single', text: 'Да?', options: [{ code: 1, text: 'Да' }, { code: 2, text: 'Нет' }] }] }],
};
{
  const old = new DatabaseSync(join(dir, 'surveylab.db'));
  old.exec(`
    CREATE TABLE surveys (id TEXT PRIMARY KEY, title TEXT NOT NULL, draft TEXT NOT NULL, published TEXT, version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', sheets TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, notify TEXT);
    CREATE TABLE survey_versions (survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, version INTEGER NOT NULL,
      definition TEXT NOT NULL, published_at TEXT NOT NULL, published_by TEXT, PRIMARY KEY (survey_id, version));
    CREATE TABLE responses (id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE, version INTEGER NOT NULL,
      status TEXT NOT NULL, is_test INTEGER NOT NULL DEFAULT 0, answers TEXT NOT NULL DEFAULT '{}', history TEXT NOT NULL DEFAULT '[]',
      current_page TEXT, params TEXT NOT NULL DEFAULT '{}', ip TEXT, user_agent TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT, duration_sec INTEGER, ending TEXT, timings TEXT, rejected INTEGER NOT NULL DEFAULT 0);
  `);
  const json = JSON.stringify(survey);
  const t = new Date().toISOString();
  old.prepare(`INSERT INTO surveys (id, title, draft, published, version, status, notify, created_at, updated_at)
    VALUES ('oldsrv01', 'Старая анкета', ?, ?, 1, 'active', '{"webhookUrl":"https://hook.example"}', ?, ?)`).run(json, json, t, t);
  old.prepare(`INSERT INTO survey_versions VALUES ('oldsrv01', 1, ?, ?, 'admin')`).run(json, t);
  old.prepare(`INSERT INTO responses (id, survey_id, version, status, answers, started_at, updated_at, completed_at)
    VALUES ('resp01', 'oldsrv01', 1, 'completed', '{"Q1":{"v":1}}', ?, ?, ?)`).run(t, t, t);
  old.close();
}

const { buildApp } = await import('../server/app.ts');
const app = await buildApp();
after(() => app.close());

test('surveys become projects with the same ID: links, responses, settings and quotas survive', async () => {
  const lr = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: 'admin', password: 'secret' } });
  const cookie = String(lr.headers['set-cookie']).split(';')[0];
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie } })).json();

  const p = await get('/api/admin/projects/oldsrv01');
  assert.equal(p.status, 'collecting');
  assert.equal(p.survey.id, 'oldsrv01');
  assert.deepEqual(p.settings, { password: 'kod', maxResponses: 50 });
  assert.deepEqual(p.quotaDefs.map((q: { id: string }) => q.id), ['QT1']);
  assert.equal(p.quotas[0].count, 1);
  assert.equal(p.notify.webhookUrl, 'https://hook.example');
  assert.equal(p.counts.real.completed, 1);

  // В анкете остались только её собственные настройки; опубликованная версия совпадает с черновиком
  const s = await get('/api/admin/surveys/oldsrv01');
  assert.deepEqual(s.draft.settings, { completeMessage: 'Спасибо!' });
  assert.equal(s.draft.quotas, undefined);
  assert.deepEqual(s.draft, s.published);
  assert.deepEqual(s.projects.map((x: { id: string }) => x.id), ['oldsrv01']);

  // Старая ссылка респондента работает — с паролем из проекта
  const start = await app.inject({ method: 'POST', url: '/api/s/oldsrv01/start', payload: {} });
  assert.equal(start.json().needPassword, true);
});
