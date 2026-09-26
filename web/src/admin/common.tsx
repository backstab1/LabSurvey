import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Issue } from '../../../shared/validate.ts';

export function IssuesList({ issues, onPick }: { issues: Issue[]; onPick?: (where: string) => void }) {
  return (
    <ul className="issues">
      {issues.map((i, k) => (
        <li key={k} className={onPick ? 'clickable' : ''} onClick={() => onPick?.(i.where)}>
          <span className="where">{i.where}</span>{i.message}
        </li>
      ))}
    </ul>
  );
}

let toastSetter: ((s: string) => void) | null = null;
export function toast(msg: string) { toastSetter?.(msg); }

export function Toaster() {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    toastSetter = setMsg;
    return () => { toastSetter = null; };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), 2500);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? <div className="toast">{msg}</div> : null;
}

/** Поле ввода числа, допускающее пустое значение */
export function NumField({ label, value, onChange, placeholder, width }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string; width?: number;
}) {
  return (
    <label className="field" style={width ? { width } : undefined}><span>{label}</span>
      <input className="input" type="number" value={value ?? ''} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </label>
  );
}

/** Удаляет ключи со значением undefined/false — чтобы JSON оставался чистым */
export function compact<T extends object>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}

/** Выпадающее меню «⋯» */
export function Menu({ items, label = '⋯', title = 'Ещё', className = 'icon-btn menu-trigger', align = 'right' }: {
  items: ({ label: string; onClick: () => void; danger?: boolean; disabled?: boolean; group?: boolean } | null | false)[];
  label?: ReactNode; title?: string; className?: string; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={className} title={title} aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          // Если снизу мало места — открываем список вверх
          const r = e.currentTarget.getBoundingClientRect();
          setUp(window.innerHeight - r.bottom < 320 && r.top > window.innerHeight - r.bottom);
          setOpen(!open);
        }}>{label}</button>
      {open && (
        <div className={`menu-list${align === 'left' ? ' left' : ''}${up ? ' up' : ''}`} role="menu">
          {items.filter(Boolean).map((it, k) => {
            const item = it as { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; group?: boolean };
            if (item.group) return <div key={k} className="menu-group">{item.label}</div>;
            return (
              <button key={k} type="button" role="menuitem" disabled={item.disabled} className={item.danger ? 'danger' : ''}
                onClick={(e) => { e.stopPropagation(); setOpen(false); item.onClick(); }}>{item.label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Сворачиваемая строка настроек: заголовок + краткое описание текущего значения */
export function Section({ title, summary, active, children, defaultOpen }: {
  title: string; summary: ReactNode; active?: boolean; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={`section${open ? ' open' : ''}`}>
      <button type="button" className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="section-name">{title}</span>
        <span className={`section-summary${active ? ' active' : ''}`}>{summary}</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

/** Переключатель-флажок в стиле «галочка + подпись + пояснение» */
export function Flag({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flag-row" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

/** Сегментированный выбор из нескольких вариантов */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Открытые окна по порядку: Esc закрывает только верхнее */
const modalStack: symbol[] = [];

/** Модальное окно: Esc и клик по фону закрывают */
export function Modal({ onClose, children, wide, size, title, actions, className }: {
  onClose: () => void; children: ReactNode; wide?: boolean; size?: 'medium'; title?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const [key] = useState(() => Symbol('modal'));
  useEffect(() => {
    modalStack.push(key);
    return () => { modalStack.splice(modalStack.indexOf(key), 1); };
  }, [key]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      // Esc внутри открытого меню закрывает только меню; вложенное окно — только его
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.menu-list') || modalStack[modalStack.length - 1] !== key) return;
      // Помечаем нажатие обработанным: окно под этим в том же событии уже не закроется
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [onClose, key]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}${size ? ` modal-${size}` : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true">
        {(title || actions) && (
          <div className="modal-head">
            <div className="modal-title">{title}</div>
            <div className="row" style={{ gap: 6 }}>{actions}</div>
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
