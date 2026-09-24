import { ScriptsEditor } from './ScriptsEditor.tsx';
import { compact } from './common.tsx';
import { DEFAULT_SETTINGS, type Survey, type SurveySettings } from '../../../shared/types.ts';

export function SettingsTab({ def, onChange }: { def: Survey; onChange: (d: Survey) => void }) {
  const st = { ...DEFAULT_SETTINGS, ...def.settings };
  const setSettings = (patch: Partial<SurveySettings>) => onChange({ ...def, settings: compact({ ...def.settings, ...patch }) });
  const set = (patch: Partial<Survey>) => onChange(compact({ ...def, ...patch }));

  const message = (key: 'completeMessage' | 'screenoutMessage' | 'earlyFinishMessage' | 'closedMessage', label: string) => (
    <label className="field"><span>{label}</span>
      <textarea className="input" rows={2} placeholder={DEFAULT_SETTINGS[key]} value={def.settings?.[key] ?? ''}
        onChange={(e) => setSettings({ [key]: e.target.value || undefined })} />
    </label>
  );

  return (
    <div className="stack">
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
        <h2>Интерфейс респондента</h2>
        <label className="check"><input type="checkbox" checked={st.showProgress} onChange={(e) => setSettings({ showProgress: e.target.checked })} />Полоса прогресса</label>
        <label className="check"><input type="checkbox" checked={st.allowBack} onChange={(e) => setSettings({ allowBack: e.target.checked })} />Кнопка «Назад»</label>
        <label className="check"><input type="checkbox" checked={st.allowEarlyFinish} onChange={(e) => setSettings({ allowEarlyFinish: e.target.checked })} />Кнопка «Завершить опрос досрочно»</label>
      </div>

      <div className="card stack">
        <h2>Сообщения</h2>
        {message('completeMessage', 'После завершения')}
        {message('screenoutMessage', 'При отсеве (SCREENOUT)')}
        {message('earlyFinishMessage', 'При досрочном завершении')}
        {message('closedMessage', 'Когда опрос закрыт')}
      </div>

      <div className="card stack">
        <h2>CSS</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Стили страницы опроса. Классы: <code>.runner</code>, <code>.runner-card</code>, <code>.page-P1</code>, <code>.question</code>,
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
