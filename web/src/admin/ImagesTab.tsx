import { useRef, useState } from 'react';
import { toast } from './common.tsx';
import { uploadImage } from './ImageField.tsx';
import { imageLibrary } from '../../../shared/images.ts';
import type { Survey, SurveyImage } from '../../../shared/types.ts';

const baseName = (name: string) => name.replace(/\.[^.]+$/, '').slice(0, 80);

/** Вкладка «Изображения»: загрузить картинки в анкету один раз и дальше выбирать их в вопросах */
export function ImagesTab({ def, onChange, readOnly }: { def: Survey; onChange: (d: Survey) => void; readOnly: boolean }) {
  const [busy, setBusy] = useState(0);
  const [drag, setDrag] = useState(false);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const lib = imageLibrary(def);
  const shown = lib.filter((im) => !q.trim() || `${im.name} ${im.where.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()));

  const setImages = (images: SurveyImage[]) => onChange({ ...def, images: images.length ? images : undefined });
  const upload = async (files: File[]) => {
    const list = files.filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setBusy(list.length);
    const added: SurveyImage[] = [];
    for (const f of list) {
      try { added.push({ url: await uploadImage(f), name: baseName(f.name) || 'картинка' }); } catch (e) { toast(`${f.name}: ${(e as Error).message}`); }
      setBusy((n) => n - 1);
    }
    if (added.length) {
      setImages([...(def.images ?? []), ...added]);
      toast(`Загружено: ${added.length}`);
    }
    if (input.current) input.current.value = '';
  };
  const rename = (url: string, name: string) => {
    const saved = def.images ?? [];
    setImages(saved.some((im) => im.url === url) ? saved.map((im) => (im.url === url ? { ...im, name } : im)) : [...saved, { url, name }]);
  };

  return (
    <div className="stack images-tab" onPaste={(e) => {
      if (readOnly) return;
      const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
      if (files.length) { e.preventDefault(); upload(files); }
    }}>
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Изображения анкеты</h2>
          {lib.length > 6 && <input className="input" type="search" style={{ width: 220 }} placeholder="Поиск по названию или вопросу" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Загрузите картинки один раз — логотипы, фото товаров, упаковки — и выбирайте их в вопросах кнопкой «Выбрать» в поле картинки
          (варианты ответов, уровни конджойнта, клик по картинке, логотип опроса). Картинки, уже использованные в анкете, появляются здесь сами.
        </p>
        {!readOnly && (
          <label className={`image-drop${drag ? ' over' : ''}${busy ? ' busy' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); upload([...e.dataTransfer.files]); }}>
            <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => upload([...(e.target.files ?? [])])} />
            {busy ? `Загрузка… осталось ${busy}` : <>Перетащите картинки сюда, <u>выберите файлы</u> или вставьте из буфера (Ctrl+V)<br /><span className="muted small">JPG, PNG, WEBP, GIF · до 5 МБ каждая · можно сразу несколько</span></>}
          </label>
        )}
      </div>
      {lib.length === 0 ? <div className="card muted">Картинок пока нет.</div> : (
        <div className="image-grid">
          {shown.map((im) => (
            <div key={im.url} className="image-card">
              <a href={im.url} target="_blank" rel="noreferrer"><img src={im.url} alt={im.name} loading="lazy" /></a>
              <input className="input" value={im.name} placeholder={im.saved ? 'Название' : 'не в библиотеке — дайте название'} readOnly={readOnly}
                onChange={(e) => rename(im.url, e.target.value)} />
              <div className="muted small image-where" title={im.where.join(', ')}>
                {im.where.length ? `используется: ${im.where.join(', ')}` : 'пока не используется'}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn-link small" onClick={() => { navigator.clipboard.writeText(im.url); toast('Адрес скопирован'); }}>адрес</button>
                {!readOnly && im.saved && (
                  <button className="btn-link small" style={{ color: 'var(--danger)' }} onClick={() => {
                    if (im.where.length && !window.confirm(`Картинка используется (${im.where.join(', ')}). Убрать её из библиотеки? В вопросах она останется.`)) return;
                    setImages((def.images ?? []).filter((x) => x.url !== im.url));
                  }}>убрать из библиотеки</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
