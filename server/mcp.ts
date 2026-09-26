// MCP-сервер для ИИ-коннекторов (Claude, ChatGPT): ИИ создаёт и правит черновики анкет от имени пользователя.
// Публикация, запуск сбора и ответы респондентов ИИ недоступны — это делает человек в интерфейсе.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import { baseUrl, bearerUser } from './oauth.ts';
import { oauth, surveys } from './db.ts';
import { auditAi } from './audit.ts';
import type { SessionUser } from './auth.ts';
import { draftShapeOk } from './routes/admin.ts';
import { migrateSurvey } from '../shared/migrate.ts';
import { validateSurvey, type ValidationResult } from '../shared/validate.ts';
import type { Survey } from '../shared/types.ts';

const FORMAT_DOC = readFileSync(resolve('docs/survey-format.md'), 'utf8');

const INSTRUCTIONS = `SurveyLAB — сервис опросов команды. Через этот коннектор ты создаёшь и правишь черновики анкет.
Порядок работы:
1. Перед первой анкетой в разговоре вызови get_format_guide — там формат JSON анкеты, типы вопросов, логика и примеры.
2. Составь анкету по заданию пользователя (язык анкеты — как у пользователя, обычно русский).
3. Проверь её через validate_survey и исправь все ошибки (errors). Предупреждения (warnings) — на твоё усмотрение, но упомяни важные.
4. Сохрани через create_survey (новая) или update_survey (правка существующей: сначала get_survey, потом update_survey с его updatedAt).
5. Дай пользователю ссылку на конструктор из ответа инструмента. Анкета сохраняется как черновик: опубликовать её
   и запустить сбор пользователь должен сам в SurveyLAB — не говори, что анкета опубликована или запущена.`;

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ ...text(message), isError: true });

/** Анкета от ИИ: объект или JSON-строка; старый формат переводится в текущий */
function parseDefinition(raw: unknown): { def?: unknown; error?: string } {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return { error: `definition: некорректный JSON — ${(e as Error).message}` }; }
  }
  if (!v || typeof v !== 'object') return { error: 'definition: ожидается объект анкеты' };
  return { def: migrateSurvey(v) };
}

const issues = (v: ValidationResult) => ({
  ok: v.ok,
  errors: v.errors.map((e) => `${e.where}: ${e.message}`),
  warnings: v.warnings.map((e) => `${e.where}: ${e.message}`),
});

const definition = z.union([z.record(z.string(), z.unknown()), z.string()])
  .describe('Анкета в формате SurveyLAB (formatVersion 2) — объект или JSON-строка. Формат: get_format_guide.');

function buildServer(user: SessionUser, base: string, app: string, ip: string | null): McpServer {
  const server = new McpServer({ name: 'surveylab', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const log = (action: string, id: string, title: string, coalesceMin = 0) =>
    auditAi({ login: user.login, app, action, targetType: 'survey', targetId: id, targetTitle: title, ip }, coalesceMin);
  const canWrite = user.role === 'admin' || user.role === 'editor';
  const editorUrl = (id: string) => `${base}/admin/s/${id}`;

  server.registerTool('get_format_guide', {
    title: 'Инструкция по формату анкеты',
    description: 'Полное описание JSON-формата анкеты SurveyLAB: блоки, типы вопросов, варианты, логика, действия, настройки, примеры. Вызывай перед созданием или правкой анкеты.',
    annotations: { readOnlyHint: true },
  }, async () => text(FORMAT_DOC));

  server.registerTool('list_surveys', {
    title: 'Список анкет',
    description: 'Анкеты SurveyLAB: ID, название, опубликованная версия, есть ли неопубликованные правки. Необязательный поиск по названию.',
    inputSchema: { query: z.string().optional().describe('Часть названия') },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const q = (query ?? '').trim().toLowerCase();
    const list = (await surveys.list()).filter((s) => !s.archived && (!q || s.title.toLowerCase().includes(q)));
    return text(list.slice(0, 100).map((s) => ({
      id: s.id, title: s.title, publishedVersion: s.version || null, unpublishedChanges: s.unpublished, updatedAt: s.updatedAt, editorUrl: editorUrl(s.id),
    })));
  });

  server.registerTool('get_survey', {
    title: 'Открыть анкету',
    description: 'Черновик анкеты целиком (JSON), результат проверки и updatedAt — его нужно передать в update_survey.',
    inputSchema: { id: z.string().describe('ID анкеты из list_surveys') },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => {
    const s = await surveys.get(id);
    if (!s) return fail('Анкета не найдена');
    return text({
      id: s.id, updatedAt: s.updatedAt, publishedVersion: s.version || null, editorUrl: editorUrl(s.id),
      check: issues(validateSurvey(s.draft)), definition: s.draft,
    });
  });

  server.registerTool('validate_survey', {
    title: 'Проверить анкету',
    description: 'Проверяет анкету без сохранения: ошибки структуры и логики (errors) и предупреждения (warnings).',
    inputSchema: { definition },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const { def, error } = parseDefinition(args.definition);
    if (error) return fail(error);
    return text(issues(validateSurvey(def)));
  });

  server.registerTool('create_survey', {
    title: 'Создать анкету',
    description: 'Сохраняет новую анкету как черновик и возвращает ссылку на конструктор. Сначала проверь её через validate_survey.',
    inputSchema: { definition },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args) => {
    if (!canWrite) return fail('У пользователя доступ только на просмотр — создавать анкеты нельзя');
    const { def, error } = parseDefinition(args.definition);
    if (error) return fail(error);
    const v = validateSurvey(def);
    if (!draftShapeOk(def)) return fail(`Анкета не сохранена — сломана структура. ${JSON.stringify(issues(v))}`);
    const s = await surveys.create(def as Survey);
    await log('Создал анкету', s.id, s.title);
    return text({
      id: s.id, title: s.title, updatedAt: s.updatedAt, editorUrl: editorUrl(s.id), check: issues(v),
      note: v.ok ? 'Сохранено как черновик. Опубликовать и запустить сбор пользователь может в конструкторе.'
        : 'Сохранено как черновик, но есть ошибки — исправь их через update_survey.',
    });
  });

  server.registerTool('update_survey', {
    title: 'Изменить анкету',
    description: 'Заменяет черновик анкеты целиком. Опубликованная версия не меняется. Передай updatedAt из get_survey: если анкету за это время меняли, правка не применится — перечитай её.',
    inputSchema: {
      id: z.string().describe('ID анкеты'),
      updatedAt: z.string().describe('updatedAt из get_survey / create_survey'),
      definition,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => {
    if (!canWrite) return fail('У пользователя доступ только на просмотр — менять анкеты нельзя');
    const s = await surveys.get(args.id);
    if (!s) return fail('Анкета не найдена');
    if (s.updatedAt !== args.updatedAt) {
      return fail(`Анкету изменили после того, как ты её прочитал (сейчас updatedAt = ${s.updatedAt}). Вызови get_survey и внеси правку в свежую версию.`);
    }
    const { def, error } = parseDefinition(args.definition);
    if (error) return fail(error);
    const v = validateSurvey(def);
    if (!draftShapeOk(def)) return fail(`Черновик не сохранён — сломана структура. ${JSON.stringify(issues(v))}`);
    await surveys.saveDraft(s.id, def as Survey);
    const saved = (await surveys.get(s.id))!;
    await log('Изменил черновик анкеты', s.id, saved.title, 30);
    return text({ id: s.id, updatedAt: saved.updatedAt, editorUrl: editorUrl(s.id), check: issues(v) });
  });

  return server;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', async (req, reply) => {
    const auth = await bearerUser(req);
    if (!auth) {
      return reply.code(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`)
        .send({ error: 'invalid_token', error_description: 'Нужен вход через OAuth' });
    }
    // Без сессий: на каждый запрос — свой сервер и транспорт, ответ — JSON
    const client = await oauth.client(auth.clientId);
    const server = buildServer(auth.user, baseUrl(req), client?.name ?? 'ИИ-приложение', req.ip ?? null);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (e) {
      req.log.error(e, 'MCP');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Внутренняя ошибка' }, id: null }));
      }
    }
  });
  // Без сессий потоки и завершение сессии не нужны
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method, url: '/mcp',
      handler: async (_req, reply) => reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
    });
  }
}
