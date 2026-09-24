import { useEffect, useState } from 'react';
import type { Issue } from '../../../shared/validate.ts';

export function IssuesList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="issues" style={{ margin: 0, paddingLeft: 18 }}>
      {issues.map((i, k) => <li key={k}><span className="where">{i.where}</span>{i.message}</li>)}
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
export function NumField({ label, value, onChange, placeholder }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string;
}) {
  return (
    <label className="field"><span>{label}</span>
      <input className="input" type="number" value={value ?? ''} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    </label>
  );
}

/** Удаляет ключи со значением undefined — чтобы JSON оставался чистым */
export function compact<T extends object>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}
