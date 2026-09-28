// Панели проекта: источники респондентов со своими ссылками, лимитами и редиректами
import { useProjectDraft } from './useProjectDraft.ts';
import { Segmented, compact, copyText } from '../common.tsx';
import { pct } from './format.ts';
import { PANEL_PARAM, type Panel } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

const PANEL_REDIRECTS: [keyof Panel, string, string][] = [
  ['redirectComplete', 'Завершил', 'complete'], ['redirectScreenout', 'Отсеян', 'screenout'],
  ['redirectOverquota', 'Сверх квоты', 'overquota'], ['redirectEarlyFinish', 'Вышел досрочно', 'terminate'],
  ['redirectQuality', 'Брак по качеству', 'quality'],
];

/** Ссылка для панели: код панели и ID респондента в виде макроса панели */
export function panelLink(projectId: string, p: Panel): string {
  let url = `${window.location.origin}/s/${projectId}?${PANEL_PARAM}=${encodeURIComponent(p.id)}`;
  if (p.idParam) url += `&${p.idParam}=${p.idMacro || '{ID}'}`;
  return url;
}

export function PanelsTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const { value: panels, setValue: setPanels, dirty, busy, error, save } = useProjectDraft(info.id, 'panels', info.panels, reload, { message: 'Панели сохранены', errorBox: true });
  const setAt = (i: number, patch: Partial<Panel>) => setPanels(panels.map((p, k) => (k === i ? compact({ ...p, ...patch }) : p)));
  const add = () => {
    const used = new Set(panels.map((p) => p.id));
    let n = panels.length + 1;
    while (used.has(`panel${n}`)) n++;
    setPanels([...panels, { id: `panel${n}`, idParam: 'uid' }]);
  };
  const counts = new Map(info.panelCounts.map((c) => [c.panel, c]));

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Панели</h2>
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={add}>+ Панель</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Панель – источник респондентов: панель-подрядчик, рассылка, соцсеть. У каждой своя ссылка (<code>?panel=код</code>), свой лимит
          и свои адреса возврата по статусам – они важнее редиректов из анкеты. Код панели попадает в данные как <code>url_panel</code>,
          в квотах его можно проверить условием <code>param.panel = "код"</code>.
        </p>
        {error && <div className="error-box">{error}</div>}
        {panels.length === 0 && <p className="muted" style={{ margin: 0 }}>Панелей нет – все приходят по общей ссылке проекта.</p>}
        {panels.map((p, i) => {
          const c = counts.get(p.id);
          const done = c?.statuses.completed ?? 0;
          const started = Object.values(c?.statuses ?? {}).reduce((a, b) => a + b, 0);
          const saved = info.panels.some((x) => x.id === p.id);
          const link = panelLink(info.id, p);
          const redirects = PANEL_REDIRECTS.filter(([k]) => p[k]).length;
          const idRef = `{{param.${p.idParam || 'uid'}}}`;
          return (
            <div key={i} className="quota panel">
              <fieldset className="plain stack" disabled={readOnly} style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input mono" style={{ width: 120 }} value={p.id} title="Код панели в ссылке" aria-label="Код панели"
                    onChange={(e) => setAt(i, { id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
                  <input className="input grow" placeholder="Название, например «Панель А» или «Рассылка по базе»" value={p.title ?? ''} aria-label="Название панели"
                    onChange={(e) => setAt(i, { title: e.target.value || undefined })} />
                  <label className="row" style={{ gap: 6 }} title="Лимит завершённых анкет с панели"><span className="muted small">лимит</span>
                    <input className="input mini" type="number" min={1} placeholder="–" value={p.limit ?? ''} aria-label="Лимит панели"
                      onChange={(e) => setAt(i, { limit: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
                  </label>
                  <label className="check" title="Приём остановлен: новые респонденты с этой панели видят «Опрос закрыт»">
                    <input type="checkbox" checked={!!p.closed} onChange={(e) => setAt(i, { closed: e.target.checked || undefined })} />
                    <span className="small">стоп</span>
                  </label>
                  {!readOnly && (
                    <button className="icon-btn" title="Удалить панель" onClick={() => {
                      if (started && !window.confirm(`С панели «${p.title || p.id}» уже есть анкеты (${started}). Удалить панель? Анкеты останутся в данных.`)) return;
                      setPanels(panels.filter((_, k) => k !== i));
                    }}>✕</button>
                  )}
                </div>
                <div className="grid2">
                  <label className="field"><span>Параметр с ID респондента</span>
                    <input className="input mono" placeholder="не передаётся" value={p.idParam ?? ''}
                      onChange={(e) => setAt(i, { idParam: e.target.value.trim() || undefined })} />
                    <span className="field-help">Один ответ на ID; без ID ссылка не откроется</span>
                  </label>
                  <label className="field"><span>Макрос панели для ID</span>
                    <input className="input mono" placeholder="{ID}" value={p.idMacro ?? ''} disabled={!p.idParam}
                      onChange={(e) => setAt(i, { idMacro: e.target.value.trim() || undefined })} />
                    <span className="field-help">Как панель подставляет ID: [%RID%], {'{uid}'}, ##ID## – попадёт в ссылку</span>
                  </label>
                </div>
              </fieldset>
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono grow" readOnly value={link} aria-label="Ссылка для панели" onFocus={(e) => e.target.select()} />
                <button className="btn btn-secondary btn-sm" disabled={!saved || dirty} title={!saved || dirty ? 'Сначала сохраните панели' : ''}
                  onClick={() => copyText(link, 'Ссылка для панели скопирована')}>Копировать</button>
              </div>
              <details className="js-details" open={!saved}>
                <summary>Редиректы по статусам{redirects ? ` (${redirects} из ${PANEL_REDIRECTS.length})` : ' – не заданы, действуют редиректы анкеты'}</summary>
                <fieldset className="plain grid2" disabled={readOnly} style={{ marginTop: 6 }}>
                  {PANEL_REDIRECTS.map(([k, label, slug]) => (
                    <label key={k} className="field"><span>{label}</span>
                      <input className="input mono" placeholder={`https://panel.example/${slug}?id=${idRef}`}
                        value={(p[k] as string) ?? ''} onChange={(e) => setAt(i, { [k]: e.target.value.trim() || undefined })} />
                    </label>
                  ))}
                  <span className="field-help" style={{ gridColumn: '1 / -1' }}>
                    Подстановки: <code>{idRef}</code> – ID респондента у панели, <code>{'{{resp_id}}'}</code> – ID анкеты, <code>{'{{Q1}}'}</code> – ответ на вопрос.
                    «Брак по качеству» – для анкет, забракованных автоматически по баллу риска (настраивается в «Настройках сбора»).
                  </span>
                </fieldset>
              </details>
              <details className="js-details">
                <summary>Подпись ссылок и постбэк{p.hashSecret ? ' – подпись включена' : ''}{p.postbackUrl ? ' · постбэк' : ''}</summary>
                <fieldset className="plain stack" disabled={readOnly} style={{ marginTop: 6, gap: 8 }}>
                  <p className="muted small" style={{ margin: 0 }}>
                    Подпись (HMAC) защищает от подделки ссылок: к каждому редиректу и постбэку добавляется параметр с подписью всего адреса,
                    а входящую ссылку можно проверять – без верной подписи опрос не откроется. Секрет, алгоритм и вид подписи возьмите у панели.
                  </p>
                  <div className="grid2">
                    <label className="field"><span>Секрет подписи</span>
                      <input className="input mono" type="password" autoComplete="off" placeholder="не подписывать" value={p.hashSecret ?? ''}
                        onChange={(e) => setAt(i, { hashSecret: e.target.value || undefined, ...(e.target.value ? {} : { verifyEntry: undefined }) })} />
                    </label>
                    <label className="field"><span>Параметр подписи</span>
                      <input className="input mono" placeholder="hash" value={p.hashParam ?? ''} disabled={!p.hashSecret}
                        onChange={(e) => setAt(i, { hashParam: e.target.value.trim() || undefined })} />
                    </label>
                  </div>
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                    <Segmented value={p.hashAlgo ?? 'sha256'} onChange={(v) => setAt(i, { hashAlgo: v === 'sha256' ? undefined : v })}
                      options={[{ value: 'sha256', label: 'HMAC-SHA256' }, { value: 'sha1', label: 'SHA1' }, { value: 'md5', label: 'MD5' }]} />
                    <Segmented value={p.hashFormat ?? 'hex'} onChange={(v) => setAt(i, { hashFormat: v === 'hex' ? undefined : v })}
                      options={[{ value: 'hex', label: 'hex' }, { value: 'base64', label: 'base64' }, { value: 'base64url', label: 'base64url' }]} />
                    <label className="check">
                      <input type="checkbox" checked={!!p.verifyEntry} disabled={!p.hashSecret} onChange={(e) => setAt(i, { verifyEntry: e.target.checked || undefined })} />
                      <span>Проверять подпись входящей ссылки</span>
                    </label>
                  </div>
                  <label className="field"><span>Постбэк (сервер – серверу)</span>
                    <input className="input mono" placeholder={`https://panel.example/postback?id=${idRef}&status={{status}}`} value={p.postbackUrl ?? ''}
                      onChange={(e) => setAt(i, { postbackUrl: e.target.value.trim() || undefined })} />
                    <span className="field-help">
                      GET-запрос с сервера SurveyLAB при каждом завершении анкеты. <code>{'{{status}}'}</code> – complete, screenout, overquota, terminate
                      или quality (брак). О браке, который команда поставила позже, панель узнает тем же запросом. До трёх попыток.
                    </span>
                  </label>
                </fieldset>
              </details>
              {saved && (
                <div className="muted small">
                  Начали {started} · завершили {done}{p.limit ? ` из ${p.limit}` : ''} · отсеяны {c?.statuses.screened_out ?? 0}
                  {' '}· сверх квоты {c?.statuses.overquota ?? 0} · конверсия {pct(done, started)}
                  {c?.postbackFailed ? <span className="field-error"> · постбэк не дошёл: {c.postbackFailed}</span> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
