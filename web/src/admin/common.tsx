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

/** Выпадающий список с группами и поиском (как в Survey Studio) */
export function SearchSelect({ value, groups, onChange, className = '' }: {
  value: string;
  groups: { label: string; items: { value: string; label: string }[] }[];
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = groups.flatMap((g) => g.items).find((i) => i.value === value);
  const q = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !q || i.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length);
  const flat = shown.flatMap((g) => g.items);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (v: string) => { onChange(v); setOpen(false); setQuery(''); };
  return (
    <div className={`search-select ${className}`} ref={ref}>
      <button type="button" className="input search-select-btn" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setOpen(!open); setActive(Math.max(0, flat.findIndex((i) => i.value === value))); }}>
        <span>{current?.label ?? '— выберите —'}</span><span className="muted">▾</span>
      </button>
      {open && (
        <div className="search-select-list" role="listbox">
          <input className="input" autoFocus placeholder="Поиск" value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(flat.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) pick(flat[active].value); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
            }} />
          <div className="search-select-items">
            {shown.map((g) => (
              <div key={g.label}>
                <div className="menu-group">{g.label}</div>
                {g.items.map((i) => (
                  <button key={i.value} type="button" role="option" aria-selected={i.value === value}
                    className={`${flat[active]?.value === i.value ? 'active' : ''}${i.value === value ? ' current' : ''}`}
                    onMouseEnter={() => setActive(flat.indexOf(i))} onClick={() => pick(i.value)}>{i.label}</button>
                ))}
              </div>
            ))}
            {!flat.length && <div className="muted small" style={{ padding: '8px 10px' }}>Ничего не найдено</div>}
          </div>
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
export function Flag({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flag-row${disabled ? ' disabled' : ''}`} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
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
