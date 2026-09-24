import type { ReactNode } from 'react';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { compact, toast } from './common.tsx';
import { ConditionEditor, defaultCondition } from './ConditionEditor.tsx';
import { nextId } from '../../../shared/refactor.ts';
import { DEFAULT_SETTINGS, settingsOf, type Quota, type Survey, type SurveySettings } from '../../../shared/types.ts';

export interface QuotaProgress { id: string; limit: number; count: number }

type Key = keyof SurveySettings;

/** ISO-время ⇄ значение поля datetime-local (в часовом поясе браузера) */
const toLocal = (iso?: string) => {
  if (!iso || isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);

export function SettingsTab({ def, onChange, surveyId, testToken, completed, quotaProgress }: {
  def: Survey; onChange: (d: Survey) => void; surveyId: string; testToken: string; completed: number; quotaProgress: QuotaProgress[];
}) {
  const st = settingsOf(def);
  const setSettings = (patch: Partial<SurveySettings>) => {
    const next = compact({ ...def.settings, ...patch });
    onChange(compact({ ...def, settings: Object.keys(next).length ? next : undefined }));
  };
  const set = (patch: Partial<Survey>) => onChange(compact({ ...def, ...patch }));

  const check = (key: Key, label: string, hint?: string) => (
    <label className="check">
      <input type="checkbox" checked={!!st[key]}
        // Значение, совпадающее с умолчанием, не пишем в JSON
        onChange={(e) => setSettings({ [key]: e.target.checked === !!DEFAULT_SETTINGS[key] ? undefined : e.target.checked })} />
      <span>{label}{hint && <small className="muted"> — {hint}</small>}</span>
    </label>
  );
  const text = (key: Key, label: string, opts: { placeholder?: string; area?: boolean; mono?: boolean; help?: ReactNode; type?: string } = {}) => {
    const value = (def.settings?.[key] as string | undefined) ?? '';
    const placeholder = opts.placeholder ?? (DEFAULT_SETTINGS[key] as string | undefined);
    const onValue = (v: string) => setSettings({ [key]: v.trim() ? v : undefined });
    return (
      <label className="field"><span>{label}</span>
        {opts.area
          ? <textarea className="input" rows={2} placeholder={placeholder} value={value} onChange={(e) => onValue(e.target.value)} />
          : <input className={`input${opts.mono ? ' mono' : ''}`} type={opts.type ?? 'text'} placeholder={placeholder} value={value}
              onChange={(e) => onValue(e.target.value)} />}
        {opts.help && <span className="field-help">{opts.help}</span>}
      </label>
    );
  };

  const testLink = `${window.location.origin}/s/${surveyId}?test=${testToken}`;
  const openState = st.openFrom && Date.now() < Date.parse(st.openFrom) ? 'ещё не начался'
    : st.closeAt && Date.now() >= Date.parse(st.closeAt) ? 'уже закончился'
      : st.maxResponses && completed >= st.maxResponses ? 'лимит ответов набран' : '';

  return (
    <div className="stack settings-tab">
      <div className="card stack">
        <h2>Основное</h2>
        <label className="field"><span>Название анкеты (видит респондент)</span>
          <input className="input" value={def.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field"><span>Описание (для команды)</span>
          <input className="input" value={def.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />
        </label>
      </div>

      <div className="card stack">
        <h2>Доступ и сбор ответов</h2>
        {openState && <div className="warn-box">Сейчас новые респонденты не смогут начать опрос: {openState}.</div>}
        <div className="grid2">
          <label className="field"><span>Начало сбора</span>
            <input className="input" type="datetime-local" value={toLocal(st.openFrom)} onChange={(e) => setSettings({ openFrom: fromLocal(e.target.value) })} />
          </label>
          <label className="field"><span>Окончание сбора</span>
            <input className="input" type="datetime-local" value={toLocal(st.closeAt)} onChange={(e) => setSettings({ closeAt: fromLocal(e.target.value) })} />
          </label>
        </div>
        <div className="grid2">
          <label className="field"><span>Лимит завершённых анкет</span>
            <input className="input" type="number" min={1} placeholder="без лимита" value={st.maxResponses ?? ''}
              onChange={(e) => setSettings({ maxResponses: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
            {st.maxResponses ? <span className="field-help">Сейчас завершено: {completed} из {st.maxResponses}</span> : null}
          </label>
          {text('password', 'Пароль на опрос', { placeholder: 'без пароля', help: 'Респондент вводит его перед началом' })}
        </div>
        {check('allowRetake', 'Разрешить пройти опрос повторно', 'на финальном экране появится кнопка «Пройти ещё раз»')}
        <div className="sub-title">Защита от дублей и накрутки</div>
        <div className="grid2">
          {text('uniqueParam', 'Один ответ на параметр ссылки', {
            placeholder: 'например, pid', mono: true,
            help: 'Для панелей: ?pid=… Повторно по тому же pid не пустит, начатую анкету продолжит; без параметра опрос не откроется',
          })}
          <label className="field"><span>Новых анкет с одного IP за час</span>
            <input className="input" type="number" min={1} placeholder="без ограничения" value={st.maxStartsPerIpHour ?? ''}
              onChange={(e) => setSettings({ maxStartsPerIpHour: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
            <span className="field-help">Осторожно с опросами сотрудников: из одного офиса часто один IP</span>
          </label>
          <label className="field"><span>«Спидеры»: быстрее, чем за N секунд</span>
            <input className="input" type="number" min={1} placeholder="не отмечать" value={st.minDurationSec ?? ''}
              onChange={(e) => setSettings({ minDurationSec: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
            <span className="field-help">Такие анкеты помечаются в «Данных» и переменной speeder в выгрузке</span>
          </label>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Незавершённые анкеты можно продолжить с того же устройства. После закрытия сбора, окончания срока или набора лимита новые
          респонденты видят сообщение «Когда опрос закрыт».
        </p>
        <div className="field">
          <span>Тестовая ссылка — черновик без входа в админку, ответы помечаются как тестовые</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input mono" readOnly value={testLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(testLink); toast('Тестовая ссылка скопирована'); }}>Копировать</button>
          </div>
        </div>
      </div>

      <QuotasCard def={def} progress={quotaProgress} onChange={(quotas) => onChange(compact({ ...def, quotas: quotas.length ? quotas : undefined }))} />

      <div className="card stack">
        <h2>Интерфейс респондента</h2>
        {check('showProgress', 'Полоса прогресса')}
        {check('allowBack', 'Кнопка «Назад»')}
        {check('allowEarlyFinish', 'Кнопка «Завершить опрос досрочно»')}
        {check('showQuestionNumbers', 'Показывать номер вопроса', '«Вопрос 3» по порядку показа')}
        {check('enterSubmits', 'Enter в поле ввода — «Далее»')}
        <div className="flag-group">По умолчанию для вопросов (можно изменить в самом вопросе)</div>
        {check('autoNext', 'Автопереход после выбора ответа', 'один ответ, список, шкала')}
        {check('noPaste', 'Запретить вставку из буфера в открытые ответы')}
      </div>

      <div className="card stack">
        <h2>Оформление</h2>
        <div className="grid2">
          {text('logoUrl', 'Логотип (адрес картинки)', { placeholder: 'https://…/logo.png', mono: true })}
          <label className="field"><span>Основной цвет</span>
            <div className="row" style={{ gap: 8 }}>
              <input type="color" className="color-input" value={st.accentColor ?? '#2f6fed'} onChange={(e) => setSettings({ accentColor: e.target.value })} />
              <input className="input mono" style={{ width: 120 }} placeholder="#2f6fed" value={st.accentColor ?? ''}
                onChange={(e) => setSettings({ accentColor: e.target.value.trim() || undefined })} />
              {st.accentColor && <button className="btn-link" onClick={() => setSettings({ accentColor: undefined })}>сбросить</button>}
            </div>
          </label>
        </div>
        {text('footerText', 'Текст внизу страницы', { placeholder: 'Например: © Компания · [Политика конфиденциальности](https://…)' })}
        <div className="sub-title">Надписи на кнопках</div>
        <div className="grid2">
          {text('nextLabel', '«Далее»')}
          {text('submitLabel', 'На последнем вопросе')}
          {text('backLabel', '«Назад»')}
          {text('earlyFinishLabel', 'Досрочное завершение')}
        </div>
      </div>

      <div className="card stack">
        <h2>Завершение</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Если указан адрес перехода, респондент сразу попадает туда (например, обратно в панель), и сообщение не показывается.
          В тексте и адресе работают подстановки: <code>{'{{param.pid}}'}</code> — параметр ссылки, <code>{'{{Q1}}'}</code> — ответ
          (в адресе — код), <code>{'{{resp_id}}'}</code> — ID анкеты.
        </p>
        <Finish title="Опрос пройден" message={text('completeMessage', 'Сообщение', { area: true })}
          redirect={text('redirectComplete', 'Перейти по адресу', { placeholder: 'https://panel.example/complete?pid={{param.pid}}', mono: true })} />
        <Finish title="Отсев (скринаут)" message={text('screenoutMessage', 'Сообщение', { area: true })}
          redirect={text('redirectScreenout', 'Перейти по адресу', { placeholder: 'https://panel.example/screenout?pid={{param.pid}}', mono: true })} />
        <Finish title="Сверх квоты" message={text('overquotaMessage', 'Сообщение', { area: true })}
          redirect={text('redirectOverquota', 'Перейти по адресу', { placeholder: 'https://panel.example/quotafull?pid={{param.pid}}', mono: true })} />
        <Finish title="Досрочное завершение" message={text('earlyFinishMessage', 'Сообщение', { area: true })}
          redirect={text('redirectEarlyFinish', 'Перейти по адресу', { placeholder: 'необязательно', mono: true })} />
        {text('closedMessage', 'Когда опрос закрыт, срок вышел или набран лимит', { area: true })}
      </div>

      <div className="card stack">
        <h2>CSS</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Стили страницы опроса. Классы: <code>.runner</code>, <code>.runner-card</code>, <code>.page-Q1</code>, <code>.question</code>,
          <code> #q-Q1</code>, <code>.option</code>, <code>.matrix</code>, <code>.btn-primary</code>. Цвета: переменные <code>--accent</code>, <code>--bg</code>.
        </p>
        <textarea className="input" rows={8} spellCheck={false} style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
          placeholder={':root { --accent: #e4002b; }\n#q-Q5 .option { font-size: 18px; }'}
          value={def.css ?? ''} onChange={(e) => set({ css: e.target.value || undefined })} />
      </div>

      <div className="card stack">
        <h2>Глобальный скрипт</h2>
        <ScriptsEditor level="survey" value={def.scripts} onChange={(s) => set({ scripts: s })} />
      </div>
    </div>
  );
}

function Finish({ title, message, redirect }: { title: string; message: ReactNode; redirect: ReactNode }) {
  return (
    <div className="finish-group">
      <div className="sub-title">{title}</div>
      <div className="grid2">{message}{redirect}</div>
    </div>
  );
}

/** Квоты: условие профиля + сколько завершённых анкет нужно */
function QuotasCard({ def, progress, onChange }: { def: Survey; progress: QuotaProgress[]; onChange: (q: Quota[]) => void }) {
  const quotas = def.quotas ?? [];
  const setAt = (i: number, patch: Partial<Quota>) => onChange(quotas.map((q, k) => (k === i ? compact({ ...q, ...patch }) : q)));
  const add = () => {
    const cond = defaultCondition(def);
    if (!cond) return toast('Сначала добавьте вопросы');
    onChange([...quotas, { id: nextId(quotas.map((q) => q.id), 'QT'), if: cond, limit: 100 }]);
  };
  return (
    <div className="card stack">
      <h2>Квоты</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Когда набрано нужное число завершённых анкет с профилем из условия, следующие подходящие респонденты заканчивают опрос
        со статусом «Сверх квоты» (сообщение и переход — в «Завершении»). Проверка — после каждого ответа, поэтому ставьте квотные
        вопросы в начало. Условие может использовать и параметр ссылки.
      </p>
      {quotas.map((q, i) => {
        const p = progress.find((x) => x.id === q.id);
        const pct = p && q.limit ? Math.min(100, Math.round((p.count / q.limit) * 100)) : 0;
        return (
          <div key={i} className="quota">
            <div className="row" style={{ gap: 8 }}>
              <input className="input mono" style={{ width: 90 }} value={q.id} title="ID квоты"
                onChange={(e) => setAt(i, { id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
              <input className="input grow" placeholder="Название, например «Мужчины 18–34»" value={q.title ?? ''}
                onChange={(e) => setAt(i, { title: e.target.value || undefined })} />
              <label className="row" style={{ gap: 6 }}><span className="muted small">нужно</span>
                <input className="input mini" type="number" min={0} value={q.limit} onChange={(e) => setAt(i, { limit: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <button className="icon-btn" title="Удалить квоту" onClick={() => onChange(quotas.filter((_, k) => k !== i))}>✕</button>
            </div>
            <ConditionEditor def={def} value={q.if} required onChange={(c) => c && setAt(i, { if: c })} />
            {p && (
              <div className="quota-progress" title="По опубликованной версии">
                <div className="quota-bar"><div style={{ width: `${pct}%` }} className={p.count >= q.limit ? 'full' : ''} /></div>
                <span className="small">{p.count} из {q.limit}{p.count >= q.limit ? ' — набрана' : ''}</span>
              </div>
            )}
          </div>
        );
      })}
      <button className="btn-link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={add}>+ Квота</button>
    </div>
  );
}
