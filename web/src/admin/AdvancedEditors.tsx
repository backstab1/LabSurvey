// Настройки новых типов вопросов в конструкторе: слайдер, загрузка файла, клик по картинке, MaxDiff, конджойнт
import { useRef, useState } from 'react';
import { NumField, Segmented, compact } from './common.tsx';
import { conjointShape, maxdiffShape } from '../../../shared/choiceDesign.ts';
import type { ConjointAttribute, ConjointQuestion, FileQuestion, HotspotQuestion, MaxDiffQuestion, Option, SliderQuestion } from '../../../shared/types.ts';

type Patch = Record<string, unknown>;

export function SliderBody({ q, set }: { q: SliderQuestion; set: (p: Patch) => void }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <NumField label="От" width={100} value={q.min} onChange={(v) => set({ min: v ?? 0 })} />
        <NumField label="До" width={100} value={q.max} onChange={(v) => set({ max: v ?? 100 })} />
        <NumField label="Шаг" width={90} placeholder="1" value={q.step} onChange={(v) => set({ step: v })} />
        <NumField label="Ползунок сначала" width={150} placeholder="посередине" value={q.start} onChange={(v) => set({ start: v })} />
        <label className="field"><span>Единица</span>
          <input className="input" style={{ width: 90 }} placeholder="%, ₽, лет" value={q.unit ?? ''} onChange={(e) => set({ unit: e.target.value || undefined })} />
        </label>
      </div>
      <div className="grid3">
        <label className="field"><span>Подпись слева</span><input className="input" placeholder={String(q.min)} value={q.minLabel ?? ''} onChange={(e) => set({ minLabel: e.target.value || undefined })} /></label>
        <label className="field"><span>В середине</span><input className="input" value={q.midLabel ?? ''} onChange={(e) => set({ midLabel: e.target.value || undefined })} /></label>
        <label className="field"><span>Подпись справа</span><input className="input" placeholder={String(q.max)} value={q.maxLabel ?? ''} onChange={(e) => set({ maxLabel: e.target.value || undefined })} /></label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Ответ засчитывается, только когда респондент сдвинул ползунок или нажал на него.</p>
    </div>
  );
}

export function FileBody({ q, set }: { q: FileQuestion; set: (p: Patch) => void }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <Segmented value={q.accept ?? 'image'} onChange={(v) => set({ accept: v === 'image' ? undefined : v })}
        options={[{ value: 'image', label: 'Только фото и картинки' }, { value: 'any', label: 'Фото, PDF, Word, Excel, PowerPoint' }]} />
      <div className="row" style={{ alignItems: 'end' }}>
        <NumField label="Сколько файлов" width={140} placeholder="1" value={q.maxFiles} onChange={(v) => set({ maxFiles: v ? Math.min(10, Math.max(1, v)) : undefined })} />
        <NumField label="Размер файла, МБ" width={140} placeholder="10" value={q.maxSizeMb} onChange={(v) => set({ maxSizeMb: v ? Math.min(20, v) : undefined })} />
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        На телефоне кнопка предлагает сфотографировать или выбрать из галереи. Тип файла проверяется по содержимому. Файлы видны
        в «Данных» (в ответе и в отчёте), в выгрузке — переменные {q.id}_n и {q.id}_files.
      </p>
    </div>
  );
}

// ---------- Клик по картинке: области рисуются мышью на картинке ----------

const round1 = (x: number) => Math.round(x * 10) / 10;

export function HotspotBody({ q, set }: { q: HotspotQuestion; set: (p: Patch) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const pt = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)) };
  };
  const setOptions = (options: Option[]) => set({ options });
  const update = (code: number, patch: Partial<Option>) => setOptions(q.options.map((o) => (o.code === code ? compact({ ...o, ...patch }) : o)));
  const rect = drag && {
    x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0),
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <label className="field"><span>Картинка (адрес https://…)</span>
        <input className="input" placeholder="https://…/pack.png" value={q.image} onChange={(e) => set({ image: e.target.value.trim() })} />
      </label>
      {q.image ? (
        <>
          <p className="muted small" style={{ margin: 0 }}>Обведите мышью область на картинке — появится вариант ответа. Области невидимы для респондента, если не включить «Показывать границы».</p>
          <div ref={box} className="hotspot-editor" onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.area) return;
            const p = pt(e);
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }} onPointerMove={(e) => { if (drag) { const p = pt(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } }}
          onPointerUp={() => {
            if (rect && rect.w > 1.5 && rect.h > 1.5) {
              const code = Math.max(0, ...q.options.map((o) => o.code)) + 1;
              setOptions([...q.options, { code, text: `Область ${code}`, area: { x: round1(rect.x), y: round1(rect.y), w: round1(rect.w), h: round1(rect.h) } }]);
              setActive(code);
            }
            setDrag(null);
          }}>
            <img src={q.image} alt="" draggable={false} />
            {q.options.filter((o) => o.area).map((o) => (
              <div key={o.code} data-area="1" className={`hotspot-edit-area${active === o.code ? ' active' : ''}`} onClick={() => setActive(o.code)}
                style={{ left: `${o.area!.x}%`, top: `${o.area!.y}%`, width: `${o.area!.w}%`, height: `${o.area!.h}%` }}>
                <span data-area="1">{o.code}</span>
              </div>
            ))}
            {rect && <div className="hotspot-edit-area drawing" style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` }} />}
          </div>
        </>
      ) : <p className="muted small" style={{ margin: 0 }}>Укажите адрес картинки — затем на ней можно будет отметить области.</p>}
      {q.options.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {q.options.map((o) => (
            <div key={o.code} className={`row hotspot-row${active === o.code ? ' active' : ''}`} style={{ gap: 6 }} onFocus={() => setActive(o.code)}>
              <span className="mono small muted" style={{ width: 22 }}>{o.code}</span>
              <input className="input grow" value={o.text} placeholder="Название области" onChange={(e) => update(o.code, { text: e.target.value })} />
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <input key={k} className="input mini" type="number" min={0} max={100} step={0.5} title={{ x: 'Слева, %', y: 'Сверху, %', w: 'Ширина, %', h: 'Высота, %' }[k]}
                  value={o.area?.[k] ?? ''} onChange={(e) => update(o.code, { area: { ...(o.area ?? { x: 0, y: 0, w: 10, h: 10 }), [k]: Number(e.target.value) } })} />
              ))}
              <button className="icon-btn" title="Удалить область" onClick={() => setOptions(q.options.filter((x) => x.code !== o.code))}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <NumField label="Отметить не меньше" width={150} value={q.minSelected} onChange={(v) => set({ minSelected: v })} />
        <NumField label="Не больше" width={120} value={q.maxSelected} onChange={(v) => set({ maxSelected: v })} />
        <label className="check"><input type="checkbox" checked={!!q.showAreas} onChange={(e) => set({ showAreas: e.target.checked || undefined })} />Показывать границы областей</label>
      </div>
    </div>
  );
}

export function MaxDiffBody({ q, set, listButton }: { q: MaxDiffQuestion; set: (p: Patch) => void; listButton: React.ReactNode }) {
  const { items, perSet, sets } = maxdiffShape(q);
  const per = items.length ? Math.round((sets * perSet) / items.length * 10) / 10 : 0;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {listButton}
      <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <NumField label="Вариантов в наборе" width={150} placeholder="4" value={q.perSet} onChange={(v) => set({ perSet: v })} />
        <NumField label="Наборов" width={120} placeholder={String(sets)} value={q.sets} onChange={(v) => set({ sets: v })} />
      </div>
      <div className="grid2">
        <label className="field"><span>Подпись «лучший»</span><input className="input" placeholder="Наиболее важно" value={q.bestLabel ?? ''} onChange={(e) => set({ bestLabel: e.target.value || undefined })} /></label>
        <label className="field"><span>Подпись «худший»</span><input className="input" placeholder="Наименее важно" value={q.worstLabel ?? ''} onChange={(e) => set({ worstLabel: e.target.value || undefined })} /></label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {items.length >= 3 ? <>Респондент увидит {sets} наборов по {perSet}; каждый вариант — примерно {per} раза. </> : null}
        Дизайн свой у каждого респондента и сбалансирован: варианты показываются поровну, пары и позиции в наборе не повторяются без нужды,
        один вариант не идёт в двух наборах подряд. После начала сбора не меняйте список — дизайн строится по нему.
        Выгрузка: выборы по наборам ({q.id}_s1_best…) и файл дизайна (Данные → «Дизайн MaxDiff / конджойнта»).
      </p>
    </div>
  );
}

export function ConjointBody({ q, set }: { q: ConjointQuestion; set: (p: Patch) => void }) {
  const { attrs, tasks, alternatives } = conjointShape(q);
  const setAttrs = (attributes: ConjointAttribute[]) => set({ attributes });
  const updateAttr = (i: number, patch: Partial<ConjointAttribute>) => setAttrs(q.attributes.map((a, k) => (k === i ? { ...a, ...patch } : a)));
  const levelsText = (a: ConjointAttribute) => a.levels.map((l) => l.text).join('\n');
  const parseLevels = (a: ConjointAttribute, text: string): Option[] => text.split('\n').map((t, i) => ({
    // Код уровня — по месту в списке: правка текста не меняет коды
    ...(a.levels[i] ?? {}), code: a.levels[i]?.code ?? Math.max(0, ...a.levels.map((l) => l.code)) + 1 + (i - a.levels.length), text: t,
  })).filter((l, i, arr) => l.text.trim() || i < arr.length - 1);
  const minShows = attrs.length ? Math.min(...attrs.map((a) => Math.floor((tasks * alternatives) / a.levels.length))) : 0;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="stack" style={{ gap: 8 }}>
        {q.attributes.map((a, i) => (
          <div key={i} className="conjoint-attr">
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" style={{ width: 90 }} title="ID атрибута — в выгрузке дизайна" value={a.id}
                onChange={(e) => updateAttr(i, { id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
              <input className="input grow" placeholder="Атрибут, например «Цена»" value={a.text} onChange={(e) => updateAttr(i, { text: e.target.value })} />
              <button className="icon-btn" title="Удалить атрибут" onClick={() => setAttrs(q.attributes.filter((_, k) => k !== i))}>✕</button>
            </div>
            <textarea className="input" rows={Math.max(2, a.levels.length)} placeholder={'Уровни — по одному в строке:\n199 ₽\n249 ₽'}
              value={levelsText(a)} onChange={(e) => updateAttr(i, { levels: parseLevels(a, e.target.value) })} />
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => {
          const used = new Set(q.attributes.map((a) => a.id));
          let n = q.attributes.length + 1;
          while (used.has(`A${n}`)) n++;
          setAttrs([...q.attributes, { id: `A${n}`, text: '', levels: [{ code: 1, text: '' }, { code: 2, text: '' }] }]);
        }}>+ Атрибут</button>
      </div>
      <div className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <NumField label="Заданий" width={110} placeholder="8" value={q.tasks} onChange={(v) => set({ tasks: v })} />
        <NumField label="Карточек в задании" width={160} placeholder="3" value={q.alternatives} onChange={(v) => set({ alternatives: v })} />
        <label className="field grow"><span>Вариант «ничего не выберу»</span>
          <input className="input" placeholder="нет — не показывать" value={q.none ?? ''} onChange={(e) => set({ none: e.target.value || undefined })} />
        </label>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Дизайн свой у каждого респондента и сбалансирован: уровни каждого атрибута показываются поровну (сейчас — от {minShows} раз),
        в одном задании уровни атрибута не повторяются, пока их хватает на все карточки, сочетания уровней разных атрибутов
        распределяются равномерно, одинаковых карточек нет. После начала сбора не меняйте атрибуты и уровни.
        Выгрузка: выбранная карточка по заданиям ({q.id}_t1…) и файл дизайна — по строке на карточку.
      </p>
    </div>
  );
}
