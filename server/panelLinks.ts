// Панели: подпись ссылок (HMAC), проверка подписи входящей ссылки и постбэк (S2S) о статусе респондента.
// Подпись считается от полного адреса без параметра подписи и добавляется к нему последним параметром.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { projects, responses, type StoredResponse } from './db.ts';
import { panelOf } from './session.ts';
import { withLoops } from '../shared/loops.ts';
import { pipeUrl } from '../shared/logic.ts';
import type { Panel, PanelStatus, Survey } from '../shared/types.ts';
import type { ResponseStatus } from '../shared/variables.ts';

export function panelSignature(p: Panel, message: string): string {
  const mac = createHmac(p.hashAlgo ?? 'sha256', p.hashSecret ?? '').update(message).digest();
  const fmt = p.hashFormat ?? 'hex';
  return fmt === 'hex' ? mac.toString('hex') : fmt === 'base64' ? mac.toString('base64') : mac.toString('base64url');
}

/** Адрес с подписью панели (если у панели задан секрет) */
export function signUrl(p: Panel | undefined, url: string): string {
  if (!p?.hashSecret) return url;
  const param = p.hashParam || 'hash';
  return `${url}${url.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(panelSignature(p, url))}`;
}

/**
 * Проверка подписи входящей ссылки: подпись — последний параметр; подписан адрес целиком до неё.
 * Сравниваются оба варианта адреса: как его видит браузер и с раскодированными символами.
 */
export function verifyEntry(p: Panel, href: string): boolean {
  if (!p.hashSecret) return true;
  const param = p.hashParam || 'hash';
  const m = href.match(new RegExp(`^(.*)[?&]${param.replace(/[^\w-]/g, '')}=([^&#]*)$`));
  if (!m) return false;
  let got = m[2];
  try { got = decodeURIComponent(got); } catch { /* как есть */ }
  const variants = [m[1]];
  try { variants.push(decodeURI(m[1])); } catch { /* */ }
  return variants.some((msg) => {
    const want = panelSignature(p, msg);
    const a = Buffer.from(want);
    const b = Buffer.from(p.hashFormat === 'hex' || !p.hashFormat ? got.toLowerCase() : got);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Статус для панели: брак по качеству важнее остального */
export function panelStatus(status: ResponseStatus, rejected: boolean): PanelStatus | null {
  if (rejected && status === 'completed') return 'quality';
  switch (status) {
    case 'completed': return 'complete';
    case 'screened_out': return 'screenout';
    case 'overquota': return 'overquota';
    case 'terminated': return 'terminate';
    default: return null;
  }
}

const RETRIES = [0, 3_000, 15_000];
/** Для тестов: пауза между попытками */
export const postbackTiming = { scale: 1 };

/**
 * Постбэк панели о статусе анкеты: GET на адрес панели с подстановками и подписью. До трёх попыток;
 * результат сохраняется в анкете. Ничего не делает, если у панели нет адреса постбэка.
 */
export async function sendPostback(survey: Survey, r: StoredResponse, status: PanelStatus): Promise<void> {
  if (r.isTest || !r.projectId) return;
  const project = await projects.get(r.projectId);
  const panel = panelOf(project?.panels ?? [], r.params);
  if (!panel?.postbackUrl) return;
  const ctx = withLoops({ survey, answers: r.answers, params: r.params, seed: r.id });
  const url = signUrl(panel, pipeUrl(panel.postbackUrl.replace(/\{\{\s*status\s*\}\}/g, status), ctx, r.id));
  let error = '';
  for (const wait of RETRIES) {
    if (wait) await new Promise((res) => setTimeout(res, wait * postbackTiming.scale));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (res.ok) {
        await responses.update(r.id, { postback: { status, at: new Date().toISOString(), ok: true } });
        return;
      }
      error = `HTTP ${res.status}`;
    } catch (e) { error = (e as Error).message; }
  }
  await responses.update(r.id, { postback: { status, at: new Date().toISOString(), ok: false, error } });
}

/** Постбэк в фоне: респондент и команда не ждут */
export function postbackLater(survey: Survey, r: StoredResponse, status: PanelStatus | null): void {
  if (!status) return;
  sendPostback(survey, r, status).catch((e) => console.error('Постбэк панели не отправлен:', e));
}
