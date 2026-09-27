// Рассылка приглашений по e-mail: окно письма и история рассылок (вкладка «Список» проекта).
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { Modal, toast } from '../common.tsx';
import { fillMailTemplate, hasLinkPlaceholder, isEmail } from '../../../../shared/mailTemplate.ts';
import { INVITE_PARAM } from '../../../../shared/types.ts';
import type { Invitee, MailAudience, Mailing, MailStatus } from '../../../../shared/api.ts';
import { fmtDate } from './format.ts';

/** Кому отправить из диалога (выбранным — из таблицы людей) */
type Audience = Exclude<MailAudience, 'ids'>;

export const AUDIENCE_LABELS: Record<Mailing['audience'], string> = {
  not_sent: 'кому ещё не отправляли', not_completed: 'напоминание: не завершили', all: 'всем', ids: 'выбранным',
};

const EMAIL_HEADERS = /^(e-?mail|email|mail|pochta|elektronnaya-pochta|адрес)/i;
const NAME_HEADERS = /^(name|imya|fio|first_?name)$/i;

/** Столбец с адресами: по названию, иначе где больше всего адресов */
export function guessEmailField(people: Invitee[]): string {
  const cols = [...new Set(people.flatMap((p) => Object.keys(p.fields)))];
  const byName = cols.find((c) => EMAIL_HEADERS.test(c));
  if (byName) return byName;
  let best = '';
  let bestN = 0;
  for (const c of cols) {
    const n = people.filter((p) => isEmail(p.fields[c])).length;
    if (n > bestN) { best = c; bestN = n; }
  }
  return best;
}

const done = (p: Invitee) => !!p.status && p.status !== 'in_progress';

/** Кто попадёт в рассылку (как на сервере) */
export function audienceOf(people: Invitee[], audience: Audience, emailField: string): Invitee[] {
  return people.filter((p) => !p.mailPending && isEmail(p.fields[emailField])
    && (audience === 'all' || (audience === 'not_sent' ? !p.mailSentAt : !done(p))));
}

function defaultTemplate(people: Invitee[], title: string): { subject: string; body: string } {
  const nameCol = [...new Set(people.flatMap((p) => Object.keys(p.fields)))].find((c) => NAME_HEADERS.test(c));
  return {
    subject: `Приглашение на опрос: ${title}`,
    body: `${nameCol ? `Здравствуйте, {{param.${nameCol}}}!` : 'Здравствуйте!'}\n\n`
      + 'Приглашаем вас пройти короткий опрос — это займёт около 10 минут. Ваши ответы помогут нам стать лучше.\n\n{{link}}\n\n'
      + 'Ссылка персональная, пожалуйста, не пересылайте её. Начатую анкету можно продолжить позже по той же ссылке.\n\nСпасибо!',
  };
}

export function MailDialog({ projectId, projectTitle, people, status, onClose, onSent }: {
  projectId: string; projectTitle: string; people: Invitee[]; status: MailStatus; onClose: () => void; onSent: () => void;
}) {
  const last = status.list[0];
  const initial = last ? { subject: last.subject, body: last.body } : defaultTemplate(people, projectTitle);
  const columns = useMemo(() => [...new Set(people.flatMap((p) => Object.keys(p.fields)))], [people]);
  const [emailField, setEmailField] = useState(() => (last && columns.includes(last.emailField) ? last.emailField : guessEmailField(people)));
  const [audience, setAudience] = useState<Audience>(() => (people.some((p) => p.mailSentAt) ? 'not_completed' : 'not_sent'));
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [testTo, setTestTo] = useState(() => { try { return localStorage.getItem('sl-mail-test') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const withEmail = people.filter((p) => isEmail(p.fields[emailField])).length;
  const counts = {
    not_sent: audienceOf(people, 'not_sent', emailField).length,
    not_completed: audienceOf(people, 'not_completed', emailField).length,
    all: audienceOf(people, 'all', emailField).length,
  };
  const recipients = counts[audience];
  const sample = audienceOf(people, audience, emailField)[0] ?? people[0];
  const sampleLink = sample ? `${window.location.origin}/s/${projectId}?${INVITE_PARAM}=${sample.token}` : '';
  const templateError = !subject.trim() ? 'Укажите тему письма' : !hasLinkPlaceholder(body) ? 'Добавьте в текст {{link}} — персональную ссылку' : '';

  const insert = (token: string) => {
    const el = bodyRef.current;
    if (!el) return setBody(body + token);
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setBody(body.slice(0, a) + token + body.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };

  const sendTest = async () => {
    setError('');
    setBusy(true);
    try {
      await api('POST', `/api/admin/projects/${projectId}/mailings/test`, { to: testTo.trim(), subject, body, emailField });
      try { localStorage.setItem('sl-mail-test', testTo.trim()); } catch { /* приватный режим */ }
      toast(`Тестовое письмо отправлено на ${testTo.trim()}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось отправить'); } finally { setBusy(false); }
  };

  const sendAll = async () => {
    if (!window.confirm(`Отправить ${recipients} ${plural(recipients, 'письмо', 'письма', 'писем')}? Это нельзя отменить для уже отправленных писем.`)) return;
    setError('');
    setBusy(true);
    try {
      const r = await api<{ mailing: Mailing; noEmail: number }>('POST', `/api/admin/projects/${projectId}/mailings`, { audience, subject, body, emailField });
      toast(`В очереди: ${r.mailing.total}. Письма уходят постепенно, до ${status.perMinute} в минуту`);
      onSent();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось запустить рассылку'); setBusy(false); }
  };

  if (!status.configured) {
    return (
      <Modal onClose={onClose} title="Рассылка по e-mail" actions={<button className="btn btn-primary" onClick={onClose}>Понятно</button>}>
        <div className="stack">
          <p style={{ margin: 0 }}>Почта для рассылки ещё не настроена. Это делает администратор сервера один раз: в файле <code>.env</code> указывается почтовый ящик, с которого уходят письма.</p>
          <pre className="mono small" style={{ background: 'var(--bg)', padding: 12, borderRadius: 8, margin: 0 }}>{'SMTP_HOST=smtp.yandex.ru\nSMTP_PORT=465\nSMTP_USER=surveys@example.ru\nSMTP_PASS=пароль приложения\nMAIL_FROM=Опросы <surveys@example.ru>'}</pre>
          <p className="muted small" style={{ margin: 0 }}>Подойдут Яндекс 360, Mail.ru для бизнеса, Unisender Go, SendPulse или корпоративный почтовый сервер. После изменения перезапустите сервис. Подробнее — в <a href="/docs.html#mailing" target="_blank" rel="noopener">документации</a>.</p>
          <p className="muted small" style={{ margin: 0 }}>Пока можно скачать ссылки в CSV и разослать их своей почтовой программой.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Рассылка по e-mail" wide actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
      <button className="btn btn-primary" disabled={busy || !recipients || !!templateError} onClick={sendAll}>
        {recipients ? `Отправить ${recipients} ${plural(recipients, 'письмо', 'письма', 'писем')}` : 'Некому отправить'}
      </button>
    </>}>
      <div className="mail-grid">
        <div className="stack">
          <label className="field"><span>Столбец с адресом</span>
            <select className="input" value={emailField} onChange={(e) => setEmailField(e.target.value)}>
              {!emailField && <option value="">— выберите —</option>}
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="field-help">Адрес есть у {withEmail} из {people.length}{withEmail < people.length ? ' — остальным письмо не уйдёт' : ''}</span>
          </label>
          <div className="field"><span>Кому</span>
            {(['not_sent', 'not_completed', 'all'] as Audience[]).map((a) => (
              <label key={a} className="check">
                <input type="radio" name="aud" checked={audience === a} onChange={() => setAudience(a)} />
                <span>{a === 'not_sent' ? 'Кому ещё не отправляли' : a === 'not_completed' ? 'Напоминание: кто не завершил' : 'Всем в списке'}
                  <small className="muted"> — {counts[a]}</small></span>
              </label>
            ))}
          </div>
          <label className="field"><span>Тема</span>
            <input className="input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="field"><span>Текст письма</span>
            <textarea ref={bodyRef} className="input" rows={11} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="mail-vars">
            <span className="muted small">Вставить:</span>
            <button type="button" className="mail-var" onClick={() => insert('{{link}}')} title="Персональная ссылка на опрос">ссылка</button>
            {columns.filter((c) => c !== emailField).map((c) => (
              <button key={c} type="button" className="mail-var" onClick={() => insert(`{{param.${c}}}`)}>{c}</button>
            ))}
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Строка, где стоит только <code>{'{{link}}'}</code>, станет кнопкой «Пройти опрос». <code>**жирный**</code> выделяет текст.
          </p>
        </div>
        <div className="stack">
          <div className="mail-preview">
            <div className="muted small">Так увидит {sample ? (sample.fields[emailField] || 'первый в списке') : 'респондент'}:</div>
            <div className="mail-subject">{fillMailTemplate(subject, sample ?? { fields: {}, extId: null }, sampleLink) || 'Без темы'}</div>
            <div className="mail-body">{renderPreview(fillMailTemplate(body, sample ?? { fields: {}, extId: null }, sampleLink), sampleLink)}</div>
          </div>
          <div className="field"><span>Проверить на себе</span>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="email" placeholder="ваш@адрес.ru" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <button className="btn btn-secondary" disabled={busy || !isEmail(testTo) || !!templateError} onClick={sendTest}>Отправить тест</button>
            </div>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Отправитель: {status.from}. Письма уходят постепенно — до {status.perMinute} в минуту; если закрыть страницу или перезапустить сервер, рассылка продолжится.
          </p>
          {status.serverError && <div className="error-box">Почтовый сервер недоступен: {status.serverError.message}. Очередь ждёт и пробует снова.</div>}
          {templateError && <div className="error-box">{templateError}</div>}
          {error && <div className="error-box">{error}</div>}
        </div>
      </div>
    </Modal>
  );
}

/** Предпросмотр: абзацы, **жирный**, строка со ссылкой — кнопкой (как в письме) */
function renderPreview(text: string, link: string) {
  return text.split(/\n{2,}/).map((para, i) => para.trim() === link && link
    ? <p key={i}><span className="mail-button">Пройти опрос</span></p>
    : <p key={i}>{para.split('\n').map((line, k) => (
      <span key={k}>{k > 0 && <br />}{line.split(/\*\*(.+?)\*\*/g).map((part, j) => (j % 2 ? <b key={j}>{part}</b> : part))}</span>
    ))}</p>);
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;


/** История рассылок проекта с прогрессом; пока что-то отправляется — обновляется сама */
export function MailingsHistory({ projectId, status, readOnly, onChange }: { projectId: string; status: MailStatus; readOnly: boolean; onChange: () => void }) {
  const active = status.list.some((m) => m.pending > 0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(onChange, 3000);
    return () => clearInterval(t);
  }, [active, onChange]);
  if (!status.list.length) return null;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Рассылки</h3>
      {status.serverError && active && <div className="error-box">Почтовый сервер недоступен: {status.serverError.message}. Очередь ждёт и пробует снова каждые 5 минут.</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Когда</th><th>Тема</th><th>Кому</th><th>Отправлено</th><th /></tr></thead>
          <tbody>
            {status.list.map((m) => (
              <tr key={m.id}>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.createdAt)}<div className="muted">{m.createdBy}</div></td>
                <td>{m.subject}</td>
                <td className="small">{AUDIENCE_LABELS[m.audience]}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {m.sent} из {m.total}
                  {m.failed > 0 && <span className="badge closed" style={{ marginLeft: 6 }}>ошибок: {m.failed}</span>}
                  {m.pending > 0 ? <span className="badge test" style={{ marginLeft: 6 }}>идёт</span>
                    : m.cancelled ? <span className="badge" style={{ marginLeft: 6 }}>остановлена</span> : null}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {m.pending > 0 && !readOnly && (
                    <button className="btn-link small" style={{ color: 'var(--danger)' }} onClick={async () => {
                      if (!window.confirm(`Остановить рассылку? Ещё не отправленные письма (${m.pending}) не уйдут.`)) return;
                      try { await api('POST', `/api/admin/projects/${projectId}/mailings/${m.id}/cancel`); } catch (e) { toast((e as Error).message); }
                      onChange();
                    }}>остановить</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Отметка о письме в строке человека */
export function MailMark({ p }: { p: Invitee }) {
  if (p.mailPending) return <span className="badge test">в очереди</span>;
  if (p.mailError) return <span className="badge closed" title={p.mailError}>ошибка</span>;
  if (p.mailSentAt) return <span className="muted small" title={`Писем: ${p.mailCount}`}>{fmtDate(p.mailSentAt)}{p.mailCount > 1 ? ` (×${p.mailCount})` : ''}</span>;
  return <span className="muted small">—</span>;
}
