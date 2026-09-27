// Интеграции проекта: Google Sheets и уведомления (вебхук, Telegram)
import { useState } from 'react';
import { api } from '../../api.ts';
import { toast } from '../common.tsx';
import { STATUS_LABELS, type ResponseStatus } from '../../../../shared/variables.ts';
import type { ProjectInfo, SheetsConfig } from '../../../../shared/api.ts';
import { EXPORT_STATUSES, fmtDate } from './format.ts';

export function SheetsCard({ info, reload }: { info: ProjectInfo; reload: () => Promise<unknown> }) {
  const cfg = info.sheets;
  const [form, setForm] = useState({
    spreadsheetId: cfg?.spreadsheetId ?? '',
    sheetName: cfg?.sheetName ?? 'Ответы',
    auto: cfg?.auto ?? true,
    values: cfg?.values ?? 'labels',
    statuses: (cfg?.statuses ?? ['completed']) as ResponseStatus[],
  });
  const [busy, setBusy] = useState(false);

  if (!info.sheetsAccount.configured) {
    return (
      <div className="card stack">
        <h2>Google Sheets</h2>
        <div className="warn-box">
          Не настроен сервисный аккаунт Google. Укажите путь к JSON-ключу в <code>GOOGLE_APPLICATION_CREDENTIALS</code> (файл .env) и перезапустите сервер.
          Инструкция — в README.
        </div>
      </div>
    );
  }

  const save = async () => {
    await api('PUT', `/api/admin/projects/${info.id}/sheets`, form);
    await reload();
    toast('Настройки Google Sheets сохранены');
  };

  return (
    <div className="card stack">
      <h2>Google Sheets</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Откройте таблицу на редактирование для <code>{info.sheetsAccount.email}</code>, затем вставьте ссылку на неё.
      </p>
      <div className="grid2">
        <label className="field"><span>Ссылка на таблицу или её ID</span>
          <input className="input" value={form.spreadsheetId} placeholder="https://docs.google.com/spreadsheets/d/…"
            onChange={(e) => setForm({ ...form, spreadsheetId: e.target.value })} />
        </label>
        <label className="field"><span>Лист</span>
          <input className="input" value={form.sheetName} onChange={(e) => setForm({ ...form, sheetName: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} />Дописывать каждого нового респондента</label>
        <select className="input" style={{ width: 'auto' }} value={form.values} onChange={(e) => setForm({ ...form, values: e.target.value as SheetsConfig['values'] })}>
          <option value="labels">Тексты ответов</option>
          <option value="codes">Коды ответов</option>
        </select>
      </div>
      <div className="row">
        {EXPORT_STATUSES.filter((s) => s !== 'in_progress').map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={form.statuses.includes(s)}
              onChange={(e) => setForm({ ...form, statuses: e.target.checked ? [...form.statuses, s] : form.statuses.filter((x) => x !== s) })} />
            {STATUS_LABELS[s]}
          </label>
        ))}
      </div>
      {cfg?.lastError && <div className="error-box">Последняя ошибка: {cfg.lastError}</div>}
      {cfg?.lastSyncAt && !cfg.lastError && <div className="ok-box">Последняя синхронизация: {fmtDate(cfg.lastSyncAt, '—')}</div>}
      <div className="row">
        <button className="btn btn-secondary" onClick={save}>Сохранить</button>
        <button className="btn btn-primary" disabled={!cfg?.spreadsheetId || busy} onClick={async () => {
          setBusy(true);
          try {
            const r = await api('POST', `/api/admin/projects/${info.id}/sheets/sync`);
            toast(`Выгружено строк: ${r.rows}`);
          } catch (e) {
            toast((e as Error).message);
          } finally {
            setBusy(false);
            await reload();
          }
        }}>{busy ? 'Выгрузка…' : 'Полная синхронизация'}</button>
      </div>
    </div>
  );
}

/** Уведомления: вебхук (JSON) и Telegram — о завершённых анкетах, набранных квотах и лимите */
export function NotifyCard({ info, reload }: { info: ProjectInfo; reload: () => Promise<unknown> }) {
  const cfg = info.notify;
  const [form, setForm] = useState({
    webhookUrl: cfg?.webhookUrl ?? '', telegramChatId: cfg?.telegramChatId ?? '',
    everyN: cfg?.everyN ?? 0, quotaFull: cfg?.quotaFull ?? true, limitReached: cfg?.limitReached ?? true,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    try {
      await api('PUT', `/api/admin/projects/${info.id}/notify`, form);
      await reload();
      toast('Уведомления сохранены');
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  };
  return (
    <div className="card stack">
      <h2>Уведомления</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Сообщения о ходе сбора. Вебхук получает JSON (для завершённых анкет — с ответами); в Telegram приходит короткий текст.
      </p>
      <div className="grid2">
        <label className="field"><span>Вебхук (POST JSON)</span>
          <input className="input mono" placeholder="https://…" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />
        </label>
        <label className="field"><span>Чат Telegram</span>
          <input className="input mono" placeholder="-1001234567890 или @channel" value={form.telegramChatId}
            disabled={!info.telegramConfigured} onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })} />
          <span className="field-help">
            {info.telegramConfigured
              ? 'Добавьте бота в чат или канал; ID чата покажет, например, @userinfobot'
              : 'Чтобы включить, задайте TELEGRAM_BOT_TOKEN в .env и перезапустите сервер'}
          </span>
        </label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="check">
          <input type="checkbox" checked={form.everyN > 0} onChange={(e) => setForm({ ...form, everyN: e.target.checked ? 1 : 0 })} />
          Завершённые анкеты: каждая
        </label>
        {form.everyN > 0 && (
          <label className="row" style={{ gap: 6 }}><span className="muted small">или каждая N-я:</span>
            <input className="input mini" type="number" min={1} value={form.everyN} onChange={(e) => setForm({ ...form, everyN: Math.max(1, Number(e.target.value) || 1) })} />
          </label>
        )}
        <label className="check"><input type="checkbox" checked={form.quotaFull} onChange={(e) => setForm({ ...form, quotaFull: e.target.checked })} />Квота набрана</label>
        <label className="check"><input type="checkbox" checked={form.limitReached} onChange={(e) => setForm({ ...form, limitReached: e.target.checked })} />Лимит анкет набран</label>
      </div>
      {cfg?.lastError && <div className="error-box">Последняя ошибка: {cfg.lastError}</div>}
      <div className="row">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Сохранить</button>
        <button className="btn btn-secondary btn-sm" disabled={busy || (!form.webhookUrl && !form.telegramChatId)} onClick={async () => {
          setBusy(true);
          try {
            if (!(await save())) return;
            await api('POST', `/api/admin/projects/${info.id}/notify/test`);
            toast('Тестовое уведомление отправлено');
          } catch (e) {
            toast((e as Error).message);
          } finally {
            setBusy(false);
            await reload();
          }
        }}>Отправить тест</button>
        {cfg?.lastSentAt && <span className="muted small">последнее: {fmtDate(cfg.lastSentAt, '—')}</span>}
      </div>
    </div>
  );
}
