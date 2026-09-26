import { useRef, type KeyboardEvent } from 'react';
import { Menu } from './common.tsx';
import { plain } from '../runner/rich.tsx';
import type { Survey } from '../../../shared/types.ts';

/** Вопросы, ответ на которые можно подставить в текст: до вопроса before (или все) */
export function pipeTargets(def: Survey, before?: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const q of def.blocks.flatMap((b) => b.questions)) {
    if (q.id === before) break;
    if (q.type !== 'info') out.push({ id: q.id, text: plain(q.text) });
  }
  return out;
}

const Icon = {
  bold: <b style={{ fontSize: 14 }}>B</b>,
  italic: <i style={{ fontSize: 14, fontFamily: 'Georgia, serif' }}>I</i>,
  link: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  ),
  image: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
    </svg>
  ),
};

/**
 * Поле с разметкой текста анкеты: панель «жирный / курсив / ссылка / картинка / подставить ответ»
 * вместо подсказки о синтаксисе. Ctrl+B и Ctrl+I — как в текстовых редакторах.
 */
export function RichText({ value, onChange, multiline = true, rows = 2, placeholder, autoFocus, pipes, invalid }: {
  value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number; placeholder?: string; autoFocus?: boolean;
  /** Что можно подставить: ответы на вопросы; пусто — кнопки подстановки нет */
  pipes?: { id: string; text: string }[];
  invalid?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  /** Заменить выделение на before + (выделенный текст или заготовка) + after и выделить нужную часть */
  const wrap = (before: string, after: string, stub: string, selectStub?: 'inner' | 'after') => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    const picked = value.slice(s, e) || stub;
    onChange(value.slice(0, s) + before + picked + after + value.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      if (selectStub === 'after') {
        // Для ссылки выделяем адрес: [текст](https://…)
        const at = s + before.length + picked.length + 2;
        el.setSelectionRange(at, at + after.length - 3);
      } else el.setSelectionRange(s + before.length, s + before.length + picked.length);
    });
  };
  const insert = (text: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    onChange(value.slice(0, s) + text + value.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + text.length, s + text.length); });
  };

  const bold = () => wrap('**', '**', 'жирный текст');
  const italic = () => wrap('*', '*', 'курсив');
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'и') { e.preventDefault(); bold(); }
    if (k === 'i' || k === 'ш') { e.preventDefault(); italic(); }
  };

  const common = {
    ref, value, placeholder, autoFocus, onKeyDown,
    className: `rich-field${invalid ? ' invalid' : ''}`,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className={`rich-edit${multiline ? '' : ' single'}`}>
      <div className="rich-toolbar" role="toolbar" aria-label="Форматирование" onMouseDown={(e) => e.preventDefault()}>
        <button type="button" title="Жирный (Ctrl+B)" aria-label="Жирный" onClick={bold}>{Icon.bold}</button>
        <button type="button" title="Курсив (Ctrl+I)" aria-label="Курсив" onClick={italic}>{Icon.italic}</button>
        <button type="button" title="Ссылка" aria-label="Ссылка" onClick={() => wrap('[', '](https://)', 'текст ссылки', 'after')}>{Icon.link}</button>
        <button type="button" title="Картинка по адресу" aria-label="Картинка" onClick={() => wrap('![](', ')', 'https://')}>{Icon.image}</button>
        {pipes && pipes.length > 0 && (
          <Menu className="rich-pipe" label={<span className="mono">{'{{…}}'}</span>} title="Подставить ответ на вопрос" align="left"
            items={[
              { label: 'Подставить ответ', onClick: () => {}, group: true },
              ...pipes.map((p) => ({ label: `${p.id}${p.text ? ` — ${p.text.length > 50 ? `${p.text.slice(0, 50)}…` : p.text}` : ''}`, onClick: () => insert(`{{${p.id}}}`) })),
            ]} />
        )}
      </div>
      {multiline
        ? <textarea {...common} rows={Math.min(8, Math.max(rows, value.split('\n').length))} />
        : <input {...common} />}
    </div>
  );
}
