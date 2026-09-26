import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { LibraryImage } from '../../../shared/images.ts';

/** Библиотека изображений открытой анкеты — для кнопки «Выбрать» в полях картинок (вне редактора анкеты — пусто) */
export const ImageLibraryContext = createContext<LibraryImage[]>([]);

/** Загрузить картинку в SurveyLAB; возвращает адрес /media/… */
export async function uploadImage(file: File | Blob): Promise<string> {
  const res = await fetch('/api/admin/media', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить картинку');
  return data.url;
}

/**
 * Поле картинки: выбрать из изображений анкеты, загрузить с компьютера, вставить из буфера (Ctrl+V) или ссылку https://…
 * Используется везде, где у анкеты есть картинка: варианты, уровни конджойнта, клик по картинке, логотип.
 */
export function ImageField({ label = 'Картинка', value, onChange, disabled }: {
  label?: string; value: string | undefined; onChange: (url: string | undefined) => void; disabled?: boolean;
}) {
  const library = useContext(ImageLibraryContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setPicking(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [picking]);
  const put = async (file: File | Blob | null | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try { onChange(await uploadImage(file)); } catch (e) { setError((e as Error).message); } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="field image-field" ref={box}>
      <span>{label}</span>
      <div className="image-field-row">
        {value ? <img className="image-thumb" src={value} alt="" onError={() => setError('Картинка по этой ссылке не открывается')} /> : <div className="image-thumb empty" aria-hidden>🖼</div>}
        <div className="image-field-controls">
          <div className="row" style={{ gap: 6 }}>
            {library.length > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => setPicking(!picking)} aria-expanded={picking}>
                Выбрать ({library.length})
              </button>
            )}
            <label className={`btn btn-secondary btn-sm${busy || disabled ? ' disabled' : ''}`}>
              {busy ? 'Загрузка…' : 'Загрузить…'}
              <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || disabled}
                onChange={(e) => put(e.target.files?.[0])} />
            </label>
            {value && !disabled && <button type="button" className="btn-link small" onClick={() => onChange(undefined)}>убрать</button>}
          </div>
          <input className="input mono small" value={value ?? ''} disabled={disabled} placeholder="или ссылка https://…, или вставьте картинку (Ctrl+V)"
            onChange={(e) => { setError(''); onChange(e.target.value.trim() || undefined); }}
            onPaste={(e) => {
              const file = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile();
              if (file) { e.preventDefault(); put(file); }
            }} />
          {error && <span className="field-error">{error}</span>}
        </div>
      </div>
      {picking && (
        <div className="image-picker" role="listbox" aria-label="Изображения анкеты">
          {library.map((im) => (
            <button key={im.url} type="button" role="option" aria-selected={im.url === value} className={`image-pick${im.url === value ? ' current' : ''}`}
              title={im.name || im.where.join(', ')} onClick={() => { onChange(im.url); setError(''); setPicking(false); }}>
              <img src={im.url} alt="" loading="lazy" />
              <span>{im.name || im.where.join(', ') || 'без названия'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
