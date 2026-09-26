import type { ReactNode } from 'react';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { compact } from './common.tsx';
import { RichText, pipeTargets } from './RichText.tsx';
import { DEFAULT_SETTINGS, settingsOf, type Survey, type SurveySettings } from '../../../shared/types.ts';

type Key = keyof SurveySettings;

const SECTIONS: [string, string][] = [
  ['set-main', 'Основное'], ['set-ui', 'Интерфейс'], ['set-design', 'Оформление'], ['set-finish', 'Завершение'], ['set-dev', 'CSS и скрипт'],
];


/** Настройки анкеты: как она выглядит и ведёт себя. Сроки, лимиты, доступ и квоты — в проекте */
export function SettingsTab({ def, onChange }: { def: Survey; onChange: (d: Survey) => void }) {
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
  const pipes = pipeTargets(def);
  const text = (key: Key, label: string, opts: { placeholder?: string; area?: boolean; rich?: boolean; mono?: boolean; help?: ReactNode; type?: string } = {}) => {
    const value = (def.settings?.[key] as string | undefined) ?? '';
    const placeholder = opts.placeholder ?? (DEFAULT_SETTINGS[key] as string | undefined);
    const onValue = (v: string) => setSettings({ [key]: v.trim() ? v : undefined });
    if (opts.area || opts.rich) {
      // Тексты для респондента — с панелью форматирования
      return (
        <div className="field"><span>{label}</span>
          <RichText multiline={!!opts.area} placeholder={placeholder} value={value} onChange={onValue} pipes={opts.area ? pipes : undefined} />
          {opts.help && <span className="field-help">{opts.help}</span>}
        </div>
      );
    }
    return (
      <label className="field"><span>{label}</span>
        <input className={`input${opts.mono ? ' mono' : ''}`} type={opts.type ?? 'text'} placeholder={placeholder} value={value}
          onChange={(e) => onValue(e.target.value)} />
        {opts.help && <span className="field-help">{opts.help}</span>}
      </label>
    );
  };


  return (
    <div className="stack settings-tab">
      <nav className="settings-nav" aria-label="Разделы настроек">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}</a>
        ))}
      </nav>
      <div className="card stack" id="set-main">
        <h2>Основное</h2>
        <label className="field"><span>Название анкеты (видит респондент)</span>
          <input className="input" value={def.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="field"><span>Описание (для команды)</span>
          <input className="input" value={def.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />
        </label>
        <p className="muted small" style={{ margin: 0 }}>Сроки сбора, лимит анкет, пароль, защита от дублей и квоты задаются в проекте, который запускает анкету.</p>
      </div>

      <div className="card stack" id="set-ui">
        <h2>Интерфейс респондента</h2>
        {check('showProgress', 'Полоса прогресса')}
        {check('allowBack', 'Кнопка «Назад»')}
        {check('allowEarlyFinish', 'Кнопка «Завершить опрос досрочно»')}
        {check('showQuestionNumbers', 'Показывать номер вопроса', '«Вопрос 3» по порядку показа')}
        {check('enterSubmits', 'Enter в поле ввода — «Далее»')}
        <label className="field" style={{ maxWidth: 360 }}><span>Ограничение времени на прохождение, минут</span>
          <input className="input" type="number" min={1} placeholder="без ограничения" value={st.timeLimitMin ?? ''}
            onChange={(e) => setSettings({ timeLimitMin: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined })} />
          <span className="field-help">Респондент видит таймер; по истечении анкета завершается досрочно с сохранёнными ответами</span>
        </label>
        <div className="flag-group">По умолчанию для вопросов (можно изменить в самом вопросе)</div>
        {check('autoNext', 'Автопереход после выбора ответа', 'один ответ, список, шкала')}
        {check('noPaste', 'Запретить вставку из буфера в открытые ответы')}
      </div>

      <div className="card stack" id="set-design">
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
        {text('footerText', 'Текст внизу страницы', { placeholder: 'Например: © Компания · Политика конфиденциальности', rich: true })}
        <div className="sub-title">Надписи на кнопках</div>
        <div className="grid2">
          {text('nextLabel', '«Далее»')}
          {text('submitLabel', 'На последнем вопросе')}
          {text('backLabel', '«Назад»')}
          {text('earlyFinishLabel', 'Досрочное завершение')}
        </div>
      </div>

      <div className="card stack" id="set-finish">
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
        {text('closedMessage', 'Когда сбор закрыт, срок вышел или набран лимит (в проекте)', { area: true })}
        {st.timeLimitMin ? text('timeoutMessage', 'Когда время на прохождение истекло', { area: true }) : null}
      </div>

      <details className="card stack dev-section" id="set-dev" open={!!(def.css || def.scripts?.init) || undefined}>
        <summary><h2>Для разработчиков: CSS и глобальный скрипт</h2></summary>
        <div className="sub-title">CSS</div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Стили страницы опроса. Классы: <code>.runner</code>, <code>.runner-card</code>, <code>.page-Q1</code>, <code>.question</code>,
          <code> #q-Q1</code>, <code>.option</code>, <code>.matrix</code>, <code>.btn-primary</code>. Цвета: переменные <code>--accent</code>, <code>--bg</code>.
        </p>
        <textarea className="input" rows={8} spellCheck={false} style={{ fontFamily: 'var(--mono)', fontSize: 13 }}
          placeholder={':root { --accent: #e4002b; }\n#q-Q5 .option { font-size: 18px; }'}
          value={def.css ?? ''} onChange={(e) => set({ css: e.target.value || undefined })} />
        <div className="sub-title">Глобальный скрипт</div>
        <ScriptsEditor level="survey" value={def.scripts} onChange={(s) => set({ scripts: s })} />
      </details>
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
