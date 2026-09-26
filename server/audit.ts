// Журнал действий: что и кто сделал в админке и через ИИ-коннектор. Правила ниже описывают, какие запросы
// записываются; запись делает хук после успешного ответа, название объекта берётся до изменения (для удаления).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit, projects, surveys } from './db.ts';
import { PROJECT_STATUS_LABELS, type ProjectStatus } from '../shared/types.ts';

type Req = FastifyRequest<{ Params: Record<string, string>; Body: Record<string, unknown>; Querystring: Record<string, string> }>;

interface Rule {
  action: string | ((req: Req, res: Record<string, unknown> | null) => string);
  /** Тип и ID объекта */
  target?: (req: Req, res: Record<string, unknown> | null) => [string, string | undefined] | null;
  details?: (req: Req, res: Record<string, unknown> | null) => Record<string, unknown> | null;
  /** Склеивать повторы за столько минут */
  coalesceMin?: number;
}

const p = (req: Req, k: string) => req.params?.[k];
const survey = (k = 'id') => (req: Req) => ['survey', p(req, k)] as [string, string];
const project = (k = 'id') => (req: Req) => ['project', p(req, k)] as [string, string];
const created = (type: string) => (_req: Req, res: Record<string, unknown> | null) => [type, res?.id as string | undefined] as [string, string | undefined];

const PROJECT_FIELDS: Record<string, string> = { title: 'название', surveyId: 'анкета', settings: 'настройки сбора', quotas: 'квоты', panels: 'панели' };

const RULES: Record<string, Rule> = {
  'POST /api/admin/me/password': { action: 'Сменил свой пароль' },
  'DELETE /api/admin/me/connections/:clientId': { action: 'Отозвал доступ ИИ-приложения', details: (req) => ({ app: p(req, 'clientId') }) },

  'POST /api/admin/users': {
    action: 'Создал пользователя', target: (req) => ['user', String(req.body?.login ?? '')],
    details: (req) => ({ role: req.body?.role, ...(Array.isArray(req.body?.projects) ? { projects: req.body.projects.length } : {}) }),
  },
  'PUT /api/admin/users/:login': {
    action: 'Изменил пользователя', target: (req) => ['user', p(req, 'login')],
    details: (req) => {
      const b = req.body ?? {};
      return {
        ...(b.role !== undefined ? { role: b.role } : {}), ...(b.disabled !== undefined ? { disabled: b.disabled } : {}),
        ...(b.password !== undefined ? { password: 'изменён' } : {}), ...(Array.isArray(b.projects) ? { projects: b.projects.length } : {}),
      };
    },
  },
  'DELETE /api/admin/users/:login': { action: 'Удалил пользователя', target: (req) => ['user', p(req, 'login')] },
  'POST /api/admin/backups': { action: 'Сделал резервную копию' },
  'GET /api/admin/backups/:name': { action: 'Скачал резервную копию', details: (req) => ({ file: p(req, 'name') }) },

  'POST /api/admin/surveys': { action: 'Создал анкету', target: created('survey') },
  'PUT /api/admin/surveys/:id': { action: 'Изменил черновик анкеты', target: survey(), coalesceMin: 30 },
  'POST /api/admin/surveys/:id/publish': { action: 'Опубликовал анкету', target: survey(), details: (_r, res) => (res?.version ? { version: res.version } : null) },
  'POST /api/admin/surveys/:id/archive': { action: (req) => (req.body?.archived ? 'Убрал анкету в архив' : 'Вернул анкету из архива'), target: survey() },
  'POST /api/admin/surveys/:id/versions/:v/restore': { action: 'Вернул черновик к опубликованной версии', target: survey(), details: (req) => ({ version: Number(p(req, 'v')) }) },
  'POST /api/admin/surveys/:id/duplicate': { action: 'Скопировал анкету', target: created('survey'), details: (req) => ({ from: p(req, 'id') }) },
  'DELETE /api/admin/surveys/:id': { action: 'Удалил анкету', target: survey() },
  'GET /api/admin/surveys/:id/export.json': { action: 'Скачал анкету (JSON)', target: survey() },

  'POST /api/admin/projects': { action: 'Создал проект', target: created('project'), details: (req) => ({ survey: req.body?.surveyId }) },
  'POST /api/admin/projects/:id/copy': { action: 'Скопировал проект', target: created('project'), details: (req) => ({ from: p(req, 'id') }) },
  'PUT /api/admin/projects/:id': {
    action: (req) => {
      const fields = Object.keys(req.body ?? {}).filter((k) => PROJECT_FIELDS[k]).map((k) => PROJECT_FIELDS[k]);
      return `Изменил проект${fields.length ? `: ${fields.join(', ')}` : ''}`;
    },
    target: project(),
  },
  'POST /api/admin/projects/:id/status': {
    action: 'Сменил статус проекта', target: project(),
    details: (req) => ({ status: PROJECT_STATUS_LABELS[req.body?.status as ProjectStatus] ?? req.body?.status }),
  },
  'DELETE /api/admin/projects/:id': { action: 'Удалил проект', target: project() },
  'DELETE /api/admin/projects/:id/test-responses': { action: 'Удалил тестовые ответы', target: project(), details: (_r, res) => ({ deleted: res?.deleted }) },
  'POST /api/admin/projects/:id/simulate': { action: 'Заполнил тестовыми ответами', target: project(), details: (_r, res) => ({ count: res?.count }) },
  'POST /api/admin/projects/:id/responses/:rid/reject': {
    action: (req) => (req.body?.rejected ? 'Забраковал анкету респондента' : 'Снял брак с анкеты'), target: project(), details: (req) => ({ response: p(req, 'rid') }),
  },
  'DELETE /api/admin/projects/:id/responses/:rid': { action: 'Удалил ответ респондента', target: project(), details: (req) => ({ response: p(req, 'rid') }) },
  'GET /api/admin/projects/:id/export.:format': {
    action: (req) => `Выгрузил данные (${String(p(req, 'format')).toUpperCase()})`, target: project(),
    details: (req) => {
      const q = req.query ?? {};
      return { statuses: q.statuses ?? 'completed', ...(q.test === '1' ? { test: true } : {}), ...(q.panel ? { panel: q.panel } : {}), ...(q.from || q.to ? { period: `${q.from ?? ''}…${q.to ?? ''}` } : {}) };
    },
  },
  'PUT /api/admin/projects/:id/notify': { action: 'Настроил уведомления', target: project() },
  'PUT /api/admin/projects/:id/sheets': { action: 'Настроил Google Sheets', target: project() },
  'POST /api/admin/projects/:id/sheets/sync': { action: 'Синхронизировал Google Sheets', target: project() },
};

/** Название объекта (анкета, проект) на момент действия */
async function titleOf(type: string | undefined, id: string | undefined): Promise<string | null> {
  if (!type || !id) return null;
  if (type === 'survey') return (await surveys.get(id))?.title ?? null;
  if (type === 'project') return (await projects.get(id))?.title ?? null;
  return null;
}

declare module 'fastify' {
  interface FastifyRequest { auditTitle?: string | null; auditPayload?: Record<string, unknown> | null }
}

const ruleOf = (req: FastifyRequest) => RULES[`${req.method} ${req.routeOptions.url}`];

/** Хуки журнала для маршрутов админки (регистрируются внутри контекста с входом) */
export function auditHooks(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const rule = ruleOf(req);
    if (!rule?.target) return;
    const t = rule.target(req as Req, null);
    req.auditTitle = t ? await titleOf(t[0], t[1]) : null;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (ruleOf(req) && reply.statusCode < 400 && typeof payload === 'string' && payload.startsWith('{')) {
      try { req.auditPayload = JSON.parse(payload); } catch { req.auditPayload = null; }
    }
    return payload;
  });
  app.addHook('onResponse', async (req, reply) => {
    const rule = ruleOf(req);
    if (!rule || reply.statusCode >= 400 || !req.user) return;
    const r = req as Req;
    const res = req.auditPayload ?? null;
    const t = rule.target?.(r, res) ?? null;
    try {
      await audit.add({
        login: req.user.login, via: 'ui',
        action: typeof rule.action === 'function' ? rule.action(r, res) : rule.action,
        targetType: t?.[0] ?? null, targetId: t?.[1] ?? null,
        // Название после действия; у удалённого объекта — каким оно было до удаления
        targetTitle: (t ? await titleOf(t[0], t[1]) : null) ?? req.auditTitle ?? null,
        details: rule.details?.(r, res) ?? null, ip: req.ip ?? null,
      }, rule.coalesceMin);
    } catch (e) { req.log.error(e, 'Журнал действий'); }
  });
}

/** Вход в админку: успешный и неудачный */
export async function auditLogin(req: FastifyRequest, login: string, ok: boolean): Promise<void> {
  await audit.add({
    login: login || null, via: 'ui', action: ok ? 'Вошёл в админку' : 'Неудачная попытка входа',
    targetType: null, targetId: null, targetTitle: null, details: null, ip: req.ip ?? null,
  }).catch(() => {});
}

/** Действие ИИ-коннектора от имени пользователя */
export async function auditAi(e: { login: string; app: string; action: string; targetType?: string; targetId?: string; targetTitle?: string | null; ip?: string | null }, coalesceMin = 0) {
  await audit.add({
    login: e.login, via: 'ai', action: e.action, targetType: e.targetType ?? null, targetId: e.targetId ?? null,
    targetTitle: e.targetTitle ?? null, details: { app: e.app }, ip: e.ip ?? null,
  }, coalesceMin).catch(() => {});
}
