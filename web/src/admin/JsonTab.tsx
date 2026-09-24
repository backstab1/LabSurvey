import { useEffect, useRef, useState } from 'react';
import { toast } from './common.tsx';
import formatDoc from '../../../docs/survey-format.md?raw';
import type { Survey } from '../../../shared/types.ts';

/**
 * JSON-представление анкеты. Двусторонняя связь с конструктором:
 * любое корректное изменение JSON сразу применяется, и наоборот.
 */
export function JsonTab({ def, onChange }: { def: Survey; onChange: (d: Survey) => void }) {
  const pretty = JSON.stringify(def, null, 2);
  const [text, setText] = useState(pretty);
  const [error, setError] = useState('');
  const lastApplied = useRef(pretty);

  // Изменения из конструктора (или после сохранения) — обновить текст, если пользователь его не правит
  useEffect(() => {
    if (pretty !== lastApplied.current) {
      setText(pretty);
      lastApplied.current = pretty;
      setError('');
    }
  }, [pretty]);

  const apply = (value: string) => {
    setText(value);
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pages)) {
        setError('Нужен объект с массивом pages');
        return;
      }
      setError('');
      lastApplied.current = JSON.stringify(parsed, null, 2);
      onChange(parsed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const aiPrompt = `${formatDoc}\n\n---\nЗадача: преобразуй анкету ниже в JSON строго по этому формату. Верни только JSON без пояснений.\n\nАнкета:\n`;

  return (
    <div className="stack">
      <div className="row">
        <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          Загрузить файл
          <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f && window.confirm('Заменить текущую анкету содержимым файла?')) apply(await f.text());
            e.target.value = '';
          }} />
        </label>
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const blob = new Blob([pretty], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${def.title || 'survey'}.json`;
          a.click();
        }}>Скачать JSON</button>
        <button className="btn btn-secondary btn-sm" title="Документация формата + задание — вставьте в любой ИИ вместе с текстом анкеты"
          onClick={() => { navigator.clipboard.writeText(aiPrompt); toast('Инструкция для ИИ скопирована'); }}>
          Скопировать инструкцию для ИИ
        </button>
        <span className="grow" />
        {error ? <span style={{ color: 'var(--danger)', fontSize: 14 }}>Не применено: {error}</span>
          : <span className="muted" style={{ fontSize: 14 }}>Изменения применяются сразу</span>}
      </div>
      <textarea className="json-editor" spellCheck={false} value={text} onChange={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: s, selectionEnd: en } = el;
            const v = text.slice(0, s) + '  ' + text.slice(en);
            apply(v);
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
          }
        }} />
    </div>
  );
}
