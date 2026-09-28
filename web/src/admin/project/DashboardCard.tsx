// Живой дашборд для заказчика: включить, скопировать ссылку, выбрать, что показывать
import { useState } from 'react';
import { api } from '../../api.ts';
import { copyText, toast } from '../common.tsx';
import { allQuestions } from '../../../../shared/logic.ts';
import { plainText } from '../../../../shared/text.ts';
import type { DashboardConfig } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

/** Эти вопросы на дашборд не попадают никогда: в них могут быть персональные данные */
const PRIVATE = new Set(['text', 'phone', 'file', 'hidden', 'consent', 'info', 'date']);

export function DashboardCard({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const d = info.dashboard;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const link = d ? `${window.location.origin}/d/${d.token}` : '';
  const save = async (next: Omit<DashboardConfig, 'token'> | null, message?: string) => {
    setBusy(true);
    try {
      await api('PUT', `/api/admin/projects/${info.id}`, { dashboard: next });
      await reload();
      if (message) toast(message);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const patch = (p: Partial<DashboardConfig>) => d && save({ ...d, ...p });
  const questions = allQuestions(info.published ?? info.draft).filter((q) => !PRIVATE.has(q.type));
  const hidden = new Set(d?.hideQuestions ?? []);

  return (
    <div className="card stack dash-card">
      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="grow" style={{ margin: 0 }}>Живой дашборд для заказчика</h2>
        {!readOnly && (
          <label className="switch">
            <input type="checkbox" checked={!!d?.enabled} disabled={busy}
              onChange={(e) => save(d ? { ...d, enabled: e.target.checked } : { enabled: true }, e.target.checked ? 'Дашборд включён' : 'Дашборд выключен – ссылка больше не открывается')} />
            <span>{d?.enabled ? 'Включён' : 'Выключен'}</span>
          </label>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Страница по секретной ссылке, без входа: ход сбора, квоты и результаты по завершённым анкетам. Обновляется сама раз в минуту.
        Открытые ответы, «Другое», телефоны, даты, файлы и скрытые переменные на неё не попадают.
      </p>
      {d?.enabled && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono grow" readOnly value={link} aria-label="Ссылка на дашборд" onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => copyText(link, 'Ссылка на дашборд скопирована')}>Копировать</button>
            <button className="btn btn-secondary btn-sm" onClick={() => window.open(link, '_blank')}>Открыть</button>
          </div>
          {!readOnly && (
            <details className="js-details" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
              <summary>Что показывать{hidden.size ? ` · скрыто вопросов: ${hidden.size}` : ''}</summary>
              <fieldset className="plain stack" disabled={busy} style={{ marginTop: 8, gap: 8 }}>
                <label className="field"><span>Заголовок страницы</span>
                  <input className="input" defaultValue={d.title ?? ''} placeholder={info.title}
                    onBlur={(e) => { if ((e.target.value.trim() || undefined) !== d.title) patch({ title: e.target.value.trim() || undefined }); }} />
                </label>
                <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
                  {([['hideDaily', 'По дням'], ['hideQuotas', 'Квоты'], ['hideSources', 'Источники (панели)'], ['hideReport', 'Результаты по вопросам']] as const).map(([k, label]) => (
                    <label key={k} className="check">
                      <input type="checkbox" checked={!d[k]} onChange={(e) => patch({ [k]: e.target.checked ? undefined : true })} />{label}
                    </label>
                  ))}
                </div>
                {!d.hideReport && questions.length > 0 && (
                  <div className="dash-questions">
                    <div className="small muted">Вопросы в результатах (снимите галочку, чтобы скрыть):</div>
                    {questions.map((q) => (
                      <label key={q.id} className="check small">
                        <input type="checkbox" checked={!hidden.has(q.id)}
                          onChange={(e) => {
                            const next = new Set(hidden);
                            if (e.target.checked) next.delete(q.id); else next.add(q.id);
                            patch({ hideQuestions: next.size ? [...next] : undefined });
                          }} />
                        <span className="mono">{q.id}</span> {plainText(q.text).slice(0, 80)}
                      </label>
                    ))}
                  </div>
                )}
                <div>
                  <button type="button" className="btn-link" style={{ padding: 0 }} onClick={async () => {
                    if (!window.confirm('Сделать новую ссылку? Старая перестанет открываться у всех, кому её отправили.')) return;
                    try {
                      await api('POST', `/api/admin/projects/${info.id}/dashboard/token`);
                      await reload();
                      toast('Новая ссылка готова');
                    } catch (e) { toast((e as Error).message); }
                  }}>Сменить ссылку</button>
                </div>
              </fieldset>
            </details>
          )}
        </>
      )}
    </div>
  );
}
