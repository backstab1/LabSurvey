// Персональные ссылки: список приглашённых и рассылка приглашений по e-mail
import type { FastifyInstance } from 'fastify';
import { invitees, isEmail, mailings } from '../../db.ts';
import { projectOf } from '../../projectCtx.ts';
import { kickMailer, mailConfigured, mailServerError, sendTest } from '../../mail.ts';
import { baseUrl } from '../../oauth.ts';
import { config } from '../../config.ts';
import { fail } from '../../http.ts';
import type { MailStatus } from '../../../shared/api.ts';
import { hasLinkPlaceholder } from '../../../shared/mailTemplate.ts';
import { RESERVED_PARAMS } from '../../../shared/types.ts';

const MAX_INVITEES = 20_000;
const FIELD_KEY = /^[A-Za-z][\w.-]{0,49}$/;
const MAIL_AUDIENCES = ['not_sent', 'not_completed', 'all', 'ids'] as const;

type Person = { extId: string | null; fields: Record<string, string> };
type MailBody = { audience?: string; ids?: unknown; subject?: unknown; body?: unknown; emailField?: unknown; to?: unknown };

/** Строка списка из запроса; ошибка — с номером строки */
function cleanPerson(p: { extId?: unknown; fields?: unknown } | undefined, row: number): Person {
  const fields: Record<string, string> = {};
  const raw = p?.fields && typeof p.fields === 'object' ? Object.entries(p.fields as Record<string, unknown>) : [];
  if (raw.length > 30) fail(400, `Строка ${row}: не больше 30 столбцов`);
  for (const [k, v] of raw) {
    if (!FIELD_KEY.test(k) || RESERVED_PARAMS.includes(k) || k === 'panel' || k === 'inv_id') {
      fail(400, `Столбец «${k}»: латиница, цифры, _ . -, начинается с буквы; нельзя ${RESERVED_PARAMS.join(', ')}, panel, inv_id`);
    }
    if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = String(v).trim().slice(0, 300);
  }
  const extId = p?.extId === undefined || p.extId === null || String(p.extId).trim() === '' ? null : String(p.extId).trim().slice(0, 100);
  return { extId, fields };
}

/** Проверка шаблона письма */
function checkTemplate(b: MailBody): { subject: string; body: string } {
  if (typeof b.subject !== 'string' || !b.subject.trim()) fail(400, 'Укажите тему письма');
  if (b.subject.length > 200) fail(400, 'Тема длиннее 200 символов');
  if (typeof b.body !== 'string' || !b.body.trim()) fail(400, 'Напишите текст письма');
  if (b.body.length > 10_000) fail(400, 'Текст письма длиннее 10 000 символов');
  if (!hasLinkPlaceholder(b.body)) fail(400, 'В тексте нет {{link}} — без неё человек не получит свою ссылку');
  return { subject: b.subject, body: b.body };
}

function requireMail() {
  if (!mailConfigured()) fail(400, 'Почта не настроена: задайте SMTP_HOST и MAIL_FROM в .env сервера');
}

export async function inviteesRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/admin/projects/:id/invitees', async (req) => {
    await projectOf(req.params.id);
    return invitees.list(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { people?: { extId?: unknown; fields?: unknown }[] } }>('/api/admin/projects/:id/invitees', async (req) => {
    await projectOf(req.params.id);
    const list = req.body?.people;
    if (!Array.isArray(list) || !list.length) fail(400, 'Список пуст');
    if ((await invitees.count(req.params.id)) + list.length > MAX_INVITEES) fail(400, `В проекте может быть не больше ${MAX_INVITEES} человек`);
    return invitees.add(req.params.id, list.map((p, i) => cleanPerson(p, i + 1)));
  });

  app.post<{ Params: { id: string }; Body: { ids?: number[]; all?: boolean } }>('/api/admin/projects/:id/invitees/delete', async (req) => {
    const ids = req.body?.all ? 'all' as const : Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => Number.isInteger(x)) : null;
    if (!ids) fail(400, 'Укажите ids или all');
    return { deleted: await invitees.remove(req.params.id, ids) };
  });

  app.post<{ Params: { id: string; iid: string } }>('/api/admin/projects/:id/invitees/:iid/reissue', async (req) => {
    await invitees.reissue(req.params.id, Number(req.params.iid));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/admin/projects/:id/mailings', async (req): Promise<MailStatus> => {
    await projectOf(req.params.id);
    return {
      configured: mailConfigured(), from: config.smtp.from || null, perMinute: config.smtp.perMinute,
      serverError: mailServerError, list: await mailings.list(req.params.id),
    };
  });

  app.post<{ Params: { id: string }; Body: MailBody }>('/api/admin/projects/:id/mailings', async (req) => {
    await projectOf(req.params.id);
    requireMail();
    const b = req.body ?? {};
    const { subject, body } = checkTemplate(b);
    const audience = MAIL_AUDIENCES.find((a) => a === b.audience);
    if (!audience) fail(400, 'Укажите, кому отправить');
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)) : [];
    if (audience === 'ids' && !ids.length) fail(400, 'Не выбраны люди');
    const people = await invitees.list(req.params.id);
    const emailField = b.emailField;
    if (typeof emailField !== 'string' || !people.some((p) => emailField in p.fields)) fail(400, 'Выберите столбец списка с адресами');
    const r = await mailings.create({
      projectId: req.params.id, audience, subject: subject.trim(), body, emailField,
      baseUrl: baseUrl(req), createdBy: req.user?.login ?? null,
    }, ids);
    if (r.mailing.total) kickMailer();
    return r;
  });

  app.post<{ Params: { id: string }; Body: MailBody }>('/api/admin/projects/:id/mailings/test', async (req) => {
    await projectOf(req.params.id);
    requireMail();
    const b = req.body ?? {};
    const template = checkTemplate(b);
    if (!isEmail(b.to)) fail(400, 'Проверьте адрес для теста');
    const first = (await invitees.list(req.params.id))[0];
    try {
      await sendTest(b.to.trim(), template, first ?? { fields: {}, extId: null, token: 'TEST' }, baseUrl(req), req.params.id);
    } catch (e) {
      fail(502, `Почтовый сервер не принял письмо: ${(e as Error).message}`);
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string; mid: string } }>('/api/admin/projects/:id/mailings/:mid/cancel', async (req) => {
    if (!(await mailings.cancel(req.params.id, Number(req.params.mid)))) fail(404, 'Рассылка не найдена или уже закончилась');
    return { ok: true };
  });
}
