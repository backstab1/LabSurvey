// Настройки сбора проекта: сроки, лимит, доступ и защита, ссылки и код для сайта
import { useProjectDraft } from './useProjectDraft.ts';
import { compact, copyText } from '../common.tsx';
import type { ProjectSettings } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

/** ISO-время ⇄ значение поля datetime-local (в часовом поясе браузера) */
const toLocal = (iso?: string) => {
  if (!iso || isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);
const posInt = (v: string) => (v ? Math.max(1, Math.round(Number(v))) : undefined);

export function CollectionSettings({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const { value: st, setValue: setSt, dirty, busy, save } = useProjectDraft<ProjectSettings>(info.id, 'settings', info.settings, reload, {
    message: 'Настройки сбора сохранены', same: (a, b) => JSON.stringify(compact(a)) === JSON.stringify(compact(b)),
  });
  const set = (patch: Partial<ProjectSettings>) => setSt(compact({ ...st, ...patch }));
  const done = info.counts.real.completed ?? 0;
  const testLink = `${window.location.origin}/s/${info.id}?test=${info.testToken}`;

  return (
    <div className="stack settings-tab">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Сроки и лимит</h2>
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Действуют, пока проект в статусе «Сбор данных». До начала и после окончания респонденты видят сообщение «Когда опрос закрыт» из анкеты.</p>
        <fieldset className="plain" disabled={readOnly}>
          <div className="grid2">
            <label className="field"><span>Начало сбора</span>
              <input className="input" type="datetime-local" value={toLocal(st.openFrom)} onChange={(e) => set({ openFrom: fromLocal(e.target.value) })} />
            </label>
            <label className="field"><span>Окончание сбора</span>
              <input className="input" type="datetime-local" value={toLocal(st.closeAt)} onChange={(e) => set({ closeAt: fromLocal(e.target.value) })} />
            </label>
            <label className="field"><span>Лимит завершённых анкет</span>
              <input className="input" type="number" min={1} placeholder="без лимита" value={st.maxResponses ?? ''} onChange={(e) => set({ maxResponses: posInt(e.target.value) })} />
              {st.maxResponses ? <span className="field-help">Сейчас завершено: {done} из {st.maxResponses}</span> : null}
            </label>
          </div>
        </fieldset>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Доступ и защита</h2>
        <fieldset className="plain stack" disabled={readOnly}>
          <div className="grid2">
            <label className="field"><span>Пароль на опрос</span>
              <input className="input" placeholder="без пароля" value={st.password ?? ''} onChange={(e) => set({ password: e.target.value || undefined })} />
              <span className="field-help">Респондент вводит его перед началом</span>
            </label>
            <label className="field"><span>Один ответ на параметр ссылки</span>
              <input className="input mono" placeholder="например, pid" value={st.uniqueParam ?? ''} onChange={(e) => set({ uniqueParam: e.target.value.trim() || undefined })} />
              <span className="field-help">Для панелей: ?pid=… Повторно по тому же pid не пустит, начатую анкету продолжит; без параметра опрос не откроется</span>
            </label>
            <label className="field"><span>Новых анкет с одного IP за час</span>
              <input className="input" type="number" min={1} placeholder="без ограничения" value={st.maxStartsPerIpHour ?? ''} onChange={(e) => set({ maxStartsPerIpHour: posInt(e.target.value) })} />
              <span className="field-help">Осторожно с опросами сотрудников: из одного офиса часто один IP</span>
            </label>
            <label className="field"><span>«Спидеры»: быстрее, чем за N секунд</span>
              <input className="input" type="number" min={1} placeholder="не отмечать" value={st.minDurationSec ?? ''} onChange={(e) => set({ minDurationSec: posInt(e.target.value) })} />
              <span className="field-help">Такие анкеты помечаются в «Данных» и переменной speeder в выгрузке</span>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!st.allowRetake} onChange={(e) => set({ allowRetake: e.target.checked || undefined })} />
            <span>Разрешить пройти опрос повторно<small className="muted"> – на финальном экране появится кнопка «Пройти ещё раз»</small></span>
          </label>
        </fieldset>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Ссылки</h2>
        <div className="field">
          <span>Ссылка для респондентов</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={`${window.location.origin}/s/${info.id}`} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => copyText(`${window.location.origin}/s/${info.id}`)}>Копировать</button>
          </div>
        </div>
        <div className="field">
          <span>Тестовая ссылка – черновик анкеты без входа в админку, ответы помечаются как тестовые</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={testLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => copyText(testLink, 'Тестовая ссылка скопирована')}>Копировать</button>
          </div>
        </div>
        <EmbedCode id={info.id} />
      </div>
    </div>
  );
}

/** Код для вставки опроса на сайт: iframe подстраивает высоту под содержимое */
function EmbedCode({ id }: { id: string }) {
  const url = `${window.location.origin}/s/${id}`;
  const code = `<iframe id="surveylab-${id}" src="${url}" style="width:100%;border:0;min-height:480px" title="Опрос"></iframe>
<script>addEventListener('message',function(e){if(e.data&&e.data.type==='surveylab:height'){var f=document.getElementById('surveylab-${id}');if(f&&e.source===f.contentWindow)f.style.height=e.data.height+'px';}});</script>`;
  return (
    <details className="field embed-code">
      <summary>Код для вставки на сайт</summary>
      <textarea className="input mono" rows={4} readOnly value={code} onFocus={(e) => e.target.select()} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => copyText(code, 'Код скопирован')}>Копировать код</button>
        <span className="muted small">Параметры ссылки (?pid=…, utm) можно добавить к адресу в src.</span>
      </div>
    </details>
  );
}
