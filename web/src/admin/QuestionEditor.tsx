import { useState } from 'react';
import { ConditionEditor } from './ConditionEditor.tsx';
import { ScriptsEditor } from './ScriptsEditor.tsx';
import { NumField, compact } from './common.tsx';
import { newQuestion } from './Builder.tsx';
import { QUESTION_TYPE_LABELS, type Option, type OptionsFrom, type Question, type QuestionType, type Survey } from '../../../shared/types.ts';

type Props = {
  q: Question; def: Survey;
  onChange: (q: Question) => void; onDelete: () => void; onDuplicate: () => void; onMove: (dir: -1 | 1) => void;
};

/** Смена типа с сохранением всего, что можно перенести */
function convert(q: Question, type: QuestionType): Question {
  const fresh = newQuestion(type, q.id) as any;
  const old = q as any;
  const keep = { id: q.id, text: q.text, hint: q.hint, required: q.required, showIf: q.showIf, scripts: q.scripts };
  const opts: Option[] | undefined = old.options ?? old.rows;
  if (['single', 'multi', 'dropdown'].includes(type) && opts) {
    return compact({ ...fresh, ...keep, options: opts.map((o) => compact({ ...o, exclusive: type === 'multi' ? o.exclusive : undefined })), optionsFrom: old.optionsFrom ?? old.rowsFrom }) as Question;
  }
  if (type === 'matrix' && opts) return compact({ ...fresh, ...keep, rows: opts.map((o) => compact({ ...o, exclusive: undefined })) }) as Question;
  return compact({ ...fresh, ...keep }) as Question;
}

export function QuestionEditor({ q, def, onChange, onDelete, onDuplicate, onMove }: Props) {
  const set = (patch: Record<string, unknown>) => onChange(compact({ ...q, ...patch } as Question));
  const anyQ = q as any;
  const choiceSources = def.pages.flatMap((p) => p.questions)
    .filter((x) => x.id !== q.id && ['single', 'multi', 'dropdown', 'matrix'].includes(x.type));

  return (
    <div className="stack">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>{q.id} <span className="muted" style={{ fontWeight: 400 }}>· {QUESTION_TYPE_LABELS[q.type]}</span></h2>
        <button className="icon-btn" title="Выше" onClick={() => onMove(-1)}>↑</button>
        <button className="icon-btn" title="Ниже" onClick={() => onMove(1)}>↓</button>
        <button className="btn btn-secondary btn-sm" onClick={onDuplicate}>Копия</button>
        <button className="btn btn-danger btn-sm" onClick={onDelete}>Удалить</button>
      </div>

      <div className="grid3">
        <label className="field"><span>ID (имя переменной)</span>
          <input className="input" value={q.id} onChange={(e) => set({ id: e.target.value.trim() })} />
        </label>
        <label className="field"><span>Тип</span>
          <select className="input" value={q.type} onChange={(e) => onChange(convert(q, e.target.value as QuestionType))}>
            {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((t) => <option key={t} value={t}>{QUESTION_TYPE_LABELS[t]}</option>)}
          </select>
        </label>
        {q.type !== 'info' && q.type !== 'hidden' && (
          <label className="check" style={{ alignSelf: 'end', minHeight: 38 }}>
            <input type="checkbox" checked={q.required !== false} onChange={(e) => set({ required: e.target.checked ? undefined : false })} />
            Обязательный
          </label>
        )}
      </div>

      <label className="field"><span>{q.type === 'hidden' ? 'Подпись переменной (для выгрузки)' : 'Текст вопроса'} — подстановка ответа: {'{{Q1}}'}, параметра ссылки: {'{{param.src}}'}</span>
        <textarea className="input" rows={2} value={q.text} onChange={(e) => set({ text: e.target.value })} />
      </label>
      {q.type !== 'info' && q.type !== 'hidden' && (
        <label className="field"><span>Подсказка (необязательно)</span>
          <input className="input" value={q.hint ?? ''} onChange={(e) => set({ hint: e.target.value || undefined })} />
        </label>
      )}

      {/* ---------- Параметры по типу ---------- */}
      {(q.type === 'single' || q.type === 'multi' || q.type === 'dropdown') && (
        <>
          <div className="section-title">Варианты ответа</div>
          <OptionsEditor options={q.options} onChange={(options) => set({ options })} allowOther allowExclusive={q.type === 'multi'} />
          <div className="row">
            <label className="check"><input type="checkbox" checked={!!q.randomize} onChange={(e) => set({ randomize: e.target.checked || undefined })} />Перемешивать варианты</label>
            {q.type === 'multi' && (
              <>
                <div style={{ width: 120 }}><NumField label="Мин. выбрать" value={q.minSelected} onChange={(v) => set({ minSelected: v })} /></div>
                <div style={{ width: 120 }}><NumField label="Макс. выбрать" value={q.maxSelected} onChange={(v) => set({ maxSelected: v })} /></div>
              </>
            )}
          </div>
          <CarryForward label="Перенести варианты из вопроса" value={q.optionsFrom} sources={choiceSources} onChange={(v) => set({ optionsFrom: v })} />
        </>
      )}

      {q.type === 'matrix' && (
        <>
          <div className="grid3">
            <label className="field"><span>Ответов в строке</span>
              <select className="input" value={q.mode} onChange={(e) => set({ mode: e.target.value })}>
                <option value="single">Один</option>
                <option value="multi">Несколько</option>
              </select>
            </label>
            <label className="field"><span>Обязательность строк</span>
              <select className="input" value={typeof q.requiredRows === 'number' ? 'n' : q.requiredRows ?? 'all'}
                onChange={(e) => set({ requiredRows: e.target.value === 'all' ? undefined : e.target.value === 'n' ? 1 : e.target.value })}>
                <option value="all">Все строки</option>
                <option value="none">Необязательно</option>
                <option value="n">Минимум N строк</option>
              </select>
            </label>
            {typeof q.requiredRows === 'number' && <NumField label="N" value={q.requiredRows} onChange={(v) => set({ requiredRows: v ?? 1 })} />}
          </div>
          <div className="section-title">Строки (утверждения)</div>
          <OptionsEditor options={q.rows} onChange={(rows) => set({ rows })} allowOther otherHint="строка «Другое» — респондент вписывает свой вариант" />
          <label className="check"><input type="checkbox" checked={!!q.randomizeRows} onChange={(e) => set({ randomizeRows: e.target.checked || undefined })} />Перемешивать строки</label>
          <CarryForward label="Перенести строки из вопроса" value={q.rowsFrom} sources={choiceSources} onChange={(v) => set({ rowsFrom: v })} />
          <div className="section-title">Столбцы (шкала)</div>
          <OptionsEditor options={q.columns} onChange={(columns) => set({ columns })} />
        </>
      )}

      {q.type === 'scale' && (
        <>
          <div className="grid3">
            <NumField label="От" value={q.from} onChange={(v) => set({ from: v ?? 0 })} />
            <NumField label="До" value={q.to} onChange={(v) => set({ to: v ?? 5 })} />
            <div style={{ alignSelf: 'end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => set({ from: 0, to: 10, labels: { '0': 'Точно не порекомендую', '10': 'Точно порекомендую' } })}>Сделать NPS 0–10</button>
            </div>
          </div>
          <div className="grid2">
            <label className="field"><span>Подпись слева ({q.from})</span>
              <input className="input" value={q.labels?.[String(q.from)] ?? ''} onChange={(e) => set({ labels: compact({ ...q.labels, [String(q.from)]: e.target.value || undefined }) })} />
            </label>
            <label className="field"><span>Подпись справа ({q.to})</span>
              <input className="input" value={q.labels?.[String(q.to)] ?? ''} onChange={(e) => set({ labels: compact({ ...q.labels, [String(q.to)]: e.target.value || undefined }) })} />
            </label>
          </div>
          <div className="section-title">Варианты вне шкалы</div>
          <OptionsEditor options={q.extraOptions ?? []} onChange={(extraOptions) => set({ extraOptions: extraOptions.length ? extraOptions : undefined })}
            emptyHint="Например, 99 — «Затрудняюсь ответить»" defaultCode={99} />
        </>
      )}

      {q.type === 'number' && (
        <div className="grid3">
          <NumField label="Минимум" value={q.min} onChange={(v) => set({ min: v })} />
          <NumField label="Максимум" value={q.max} onChange={(v) => set({ max: v })} />
          <NumField label="Знаков после запятой" value={q.decimals} placeholder="0" onChange={(v) => set({ decimals: v || undefined })} />
        </div>
      )}
      {q.type === 'text' && (
        <div className="row">
          <label className="check"><input type="checkbox" checked={!!q.multiline} onChange={(e) => set({ multiline: e.target.checked || undefined })} />Многострочное поле</label>
          <div style={{ width: 180 }}><NumField label="Макс. символов" value={q.maxLength} onChange={(v) => set({ maxLength: v })} /></div>
        </div>
      )}
      {q.type === 'date' && (
        <div className="grid2">
          <label className="field"><span>Не раньше</span><input className="input" type="date" value={q.min ?? ''} onChange={(e) => set({ min: e.target.value || undefined })} /></label>
          <label className="field"><span>Не позже</span><input className="input" type="date" value={q.max ?? ''} onChange={(e) => set({ max: e.target.value || undefined })} /></label>
        </div>
      )}
      {q.type === 'phone' && (
        <label className="field" style={{ maxWidth: 320 }}><span>Формат</span>
          <select className="input" value={q.format ?? 'ru'} onChange={(e) => set({ format: e.target.value === 'ru' ? undefined : e.target.value })}>
            <option value="ru">Россия: +7 и 10 цифр</option>
            <option value="international">Международный: + и 8–15 цифр</option>
          </select>
        </label>
      )}
      {q.type === 'hidden' && (
        <div className="grid2">
          <label className="field"><span>Тип значения</span>
            <select className="input" value={q.valueType ?? 'string'} onChange={(e) => set({ valueType: e.target.value })}>
              <option value="string">Строка</option>
              <option value="number">Число</option>
            </select>
          </label>
          <label className="field"><span>Взять из параметра ссылки (необязательно)</span>
            <input className="input" placeholder="panel_id" value={q.fromParam ?? ''} onChange={(e) => set({ fromParam: e.target.value.trim() || undefined })} />
          </label>
          <p className="muted" style={{ gridColumn: '1 / -1', margin: 0, fontSize: 14 }}>
            Значение также можно задать скриптом: <code>sl.set("{q.id}", ...)</code>. Скрытая переменная попадает в выгрузку и доступна в условиях.
          </p>
        </div>
      )}

      {q.type !== 'hidden' && (
        <>
          <div className="section-title">Показывать вопрос, если</div>
          <ConditionEditor def={def} value={q.showIf} onChange={(c) => set({ showIf: c })} />
        </>
      )}

      <details open={!!(anyQ.scripts && Object.values(anyQ.scripts).some(Boolean))}>
        <summary className="section-title" style={{ cursor: 'pointer' }}>Скрипты вопроса</summary>
        <ScriptsEditor level="question" value={q.scripts} onChange={(s) => set({ scripts: s })} />
      </details>
    </div>
  );
}

function CarryForward({ label, value, sources, onChange }: {
  label: string; value: OptionsFrom | undefined; sources: Question[]; onChange: (v: OptionsFrom | undefined) => void;
}) {
  return (
    <div className="grid2">
      <label className="field"><span>{label}</span>
        <select className="input" value={value?.question ?? ''} onChange={(e) => onChange(e.target.value ? { question: e.target.value, filter: value?.filter ?? 'selected' } : undefined)}>
          <option value="">— не переносить —</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.id}{s.text ? ` · ${s.text.slice(0, 50)}` : ''}</option>)}
        </select>
      </label>
      {value && (
        <label className="field"><span>Какие варианты</span>
          <select className="input" value={value.filter} onChange={(e) => onChange({ ...value, filter: e.target.value as OptionsFrom['filter'] })}>
            <option value="selected">Выбранные</option>
            <option value="notSelected">Невыбранные</option>
            <option value="all">Все</option>
          </select>
        </label>
      )}
    </div>
  );
}

function OptionsEditor({ options, onChange, allowOther, allowExclusive, otherHint, emptyHint, defaultCode }: {
  options: Option[]; onChange: (o: Option[]) => void; allowOther?: boolean; allowExclusive?: boolean;
  otherHint?: string; emptyHint?: string; defaultCode?: number;
}) {
  const [bulk, setBulk] = useState<string | null>(null);
  const setAt = (i: number, patch: Partial<Option>) => onChange(options.map((o, k) => (k === i ? compact({ ...o, ...patch }) : o)));
  const move = (i: number, dir: -1 | 1) => {
    const next = options.slice();
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    onChange(next);
  };
  const nextCode = () => {
    const regular = options.filter((o) => o.code < 90).map((o) => o.code);
    return options.length === 0 && defaultCode ? defaultCode : regular.length ? Math.max(...regular) + 1 : 1;
  };

  if (bulk !== null) {
    return (
      <div className="stack">
        <textarea className="input" rows={8} autoFocus value={bulk} onChange={(e) => setBulk(e.target.value)}
          placeholder={'По одному варианту в строке.\nКод можно указать в начале: «97. Другое»'} />
        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={() => {
            const lines = bulk.split('\n').map((l) => l.trim()).filter(Boolean);
            const re = /^(\d+)[.)\t:-]\s*(.+)$/;
            const explicit = new Set(lines.map((l) => l.match(re)?.[1]).filter(Boolean).map(Number));
            let auto = 1;
            const parsed = lines.map((l) => {
              const m = l.match(re);
              if (m) return { code: Number(m[1]), text: m[2] };
              while (explicit.has(auto)) auto++;
              return { code: auto++, text: l };
            });
            onChange(parsed);
            setBulk(null);
          }}>Заменить варианты</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setBulk(null)}>Отмена</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {options.length === 0 && emptyHint && <p className="muted" style={{ fontSize: 14, margin: '0 0 6px' }}>{emptyHint}</p>}
      <table className="opt-table">
        <tbody>
          {options.map((o, i) => (
            <tr key={i}>
              <td className="code"><input className="input" type="number" title="Код" value={o.code} onChange={(e) => setAt(i, { code: Number(e.target.value) })} /></td>
              <td><input className="input" value={o.text} onChange={(e) => setAt(i, { text: e.target.value })} /></td>
              <td className="flags">
                {allowOther && <label title={otherHint ?? 'Поле «укажите»'}><input type="checkbox" checked={!!o.other} onChange={(e) => setAt(i, { other: e.target.checked || undefined })} />другое</label>}
                {allowExclusive && <label title="Снимает остальные варианты"><input type="checkbox" checked={!!o.exclusive} onChange={(e) => setAt(i, { exclusive: e.target.checked || undefined })} />эксклюзив</label>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="icon-btn" disabled={i === options.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="icon-btn" onClick={() => onChange(options.filter((_, k) => k !== i))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6, gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => onChange([...options, { code: nextCode(), text: '' }])}>+ вариант</button>
        <button className="btn-link" onClick={() => setBulk(options.map((o) => `${o.code}. ${o.text}`).join('\n'))}>Вставить списком</button>
      </div>
    </div>
  );
}
