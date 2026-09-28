// Живой дашборд для заказчика: /d/<token> без входа. Только агрегаты по завершённым настоящим анкетам —
// без открытых ответов, «Другое», файлов, телефонов и скрытых переменных.
import type { FastifyInstance } from 'fastify';
import { projects, responses } from '../db.ts';
import { loadProject } from '../projectCtx.ts';
import { quotaCounts } from '../quotas.ts';
import { dailyStats } from '../daily.ts';
import { found } from '../http.ts';
import { buildReport } from '../../shared/report.ts';
import { allOptions, allQuestions } from '../../shared/logic.ts';
import { expandAllLoops } from '../../shared/loops.ts';
import { flatQuotas } from '../../shared/quotas.ts';
import { plainText } from '../../shared/text.ts';
import type { DashboardData, DashboardFilter } from '../../shared/api.ts';
import type { Question, Survey } from '../../shared/types.ts';

/** Типы вопросов, которые не попадают на дашборд: там могут быть персональные данные */
const PRIVATE_TYPES = new Set<Question['type']>(['text', 'phone', 'file', 'hidden', 'consent', 'info', 'date']);

/** Вопросы для подгруппы: один ответ, список, шкала */
function filtersOf(def: Survey, hidden: Set<string>): DashboardFilter[] {
  return allQuestions(def).flatMap((q) => {
    if (hidden.has(q.id)) return [];
    if (q.type === 'single' || q.type === 'dropdown') {
      return [{ id: q.id, text: plainText(q.text), options: allOptions(def, q).filter((o) => !o.group && !o.hidden).map((o) => ({ code: o.code, label: plainText(o.text) })) }];
    }
    if (q.type === 'scale' && q.to - q.from <= 10) {
      const pts = Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i);
      return [{ id: q.id, text: plainText(q.text), options: pts.map((p) => ({ code: p, label: q.labels?.[String(p)] ? `${p} – ${q.labels[String(p)]}` : String(p) })) }];
    }
    return [];
  });
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string }; Querystring: { q?: string; c?: string } }>('/api/dash/:token', async (req, reply): Promise<DashboardData> => {
    reply.header('cache-control', 'no-store');
    const token = String(req.params.token).slice(0, 64);
    const p = found(await projects.byDashboard(token), 'Дашборд не найден или выключен');
    const l = found(await loadProject(p.id), 'Дашборд не найден или выключен');
    const cfg = p.dashboard!;
    const def = expandAllLoops(l.live ?? l.draft);
    const hidden = new Set(cfg.hideQuestions ?? []);
    const counts = await responses.counts(p.id);
    const c = counts.real;
    const started = Object.values(c).reduce((a, b) => a + b, 0);
    const out: DashboardData = {
      title: cfg.title || p.title,
      status: p.status,
      generatedAt: new Date().toISOString(),
      counts: {
        completed: c.completed ?? 0, screenedOut: c.screened_out ?? 0, overquota: c.overquota ?? 0,
        inProgress: (c.in_progress ?? 0) + (c.terminated ?? 0), started,
      },
      target: p.settings.maxResponses ?? null,
      filters: [],
    };
    if (!cfg.hideDaily) out.daily = dailyStats(await responses.timeline(p.id));
    if (!cfg.hideQuotas && p.quotas.length && l.live) {
      const qc = await quotaCounts(p.id, l.live, false);
      out.quotas = flatQuotas(p.quotas).map((q) => ({ id: q.id, title: q.title, limit: q.limit, count: qc.get(q.id) ?? 0, depth: q.depth, parentId: q.parentId }));
    }
    if (!cfg.hideSources && p.panels.length) {
      const byPanel = new Map((await responses.countsByPanel(p.id)).map((x) => [x.panel, x]));
      out.sources = p.panels.map((x) => {
        const s = byPanel.get(x.id)?.statuses ?? {};
        return { title: x.title || x.id, started: Object.values(s).reduce((a, b) => a + b, 0), completed: s.completed ?? 0 };
      });
    }
    if (!cfg.hideReport && l.live) {
      out.filters = filtersOf(def, hidden);
      let list = await responses.list(p.id, { statuses: ['completed'] });
      const f = out.filters.find((x) => x.id === req.query.q);
      const code = Number(req.query.c);
      const opt = f?.options.find((o) => o.code === code);
      if (f && opt) {
        list = list.filter((r) => {
          const v = r.answers[f.id]?.v;
          return Array.isArray(v) ? v.includes(code) : v === code;
        });
        out.filter = { q: f.id, code, label: `${f.text}: ${opt.label}` };
      }
      const report = buildReport(def, list);
      report.questions = report.questions
        .filter((q) => !PRIVATE_TYPES.has(q.type) && !hidden.has(q.id))
        .map(({ texts: _t, files: _f, ...q }) => q);
      report.dropOff = [];
      out.report = report;
    }
    return out;
  });
}
