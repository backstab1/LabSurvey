// Квоты проекта: дерево условий и лимитов.
// Вложенная квота действует внутри родителя: Москва → Женщины → 18–24 значит S1 = 1 and S2 = 2 and возраст 18–24.
import { useState, type CSSProperties } from 'react';
import { useProjectDraft } from './useProjectDraft.ts';
import { ConditionField } from '../survey/ConditionEditor.tsx';
import { Menu, Modal, SearchSelect, compact, toast } from '../common.tsx';
import { nextId } from '../../../../shared/refactor.ts';
import { allOptions, allQuestions, hasOptions, isChoice } from '../../../../shared/logic.ts';
import { childrenSum, flatQuotas } from '../../../../shared/quotas.ts';
import { loopChain } from '../../../../shared/loops.ts';
import { plainText } from '../../../../shared/text.ts';
import type { Condition, Quota, Survey } from '../../../../shared/types.ts';
import type { ProjectInfo } from '../../../../shared/api.ts';

type Path = number[];
type Progress = ProjectInfo['quotas'][number];

// ---------- Операции с деревом ----------

const withChildren = (q: Quota, children: Quota[]): Quota => compact({ ...q, children: children.length ? children : undefined });

/** Применить fn к списку соседей узла по пути (fn получает соседей и индекс узла) */
function siblingsOp(list: Quota[], path: Path, fn: (sibs: Quota[], i: number) => Quota[]): Quota[] {
  const [i, ...rest] = path;
  if (!rest.length) return fn(list, i);
  return list.map((q, k) => (k === i ? withChildren(q, siblingsOp(q.children ?? [], rest, fn)) : q));
}
const updateAt = (list: Quota[], path: Path, fn: (q: Quota) => Quota) =>
  siblingsOp(list, path, (s, i) => s.map((q, k) => (k === i ? fn(q) : q)));

const countNodes = (q: Quota): number => 1 + (q.children ?? []).reduce((s, c) => s + countNodes(c), 0);

/**
 * Родитель, у которого лимит был равен сумме вложенных, остаётся равным ей и после правки вложенных.
 * Родитель с лимитом, заданным вручную, не трогаем.
 */
function resync(old: Quota[], next: Quota[]): Quota[] {
  const before = new Map<string, Quota>();
  const index = (l: Quota[]) => l.forEach((q) => { before.set(q.id, q); index(q.children ?? []); });
  index(old);
  const fix = (l: Quota[]): Quota[] => l.map((q) => {
    if (!q.children?.length) return q;
    const node = { ...q, children: fix(q.children) };
    const b = before.get(q.id);
    const synced = b?.children?.length && b.limit === childrenSum(b) && q.limit === b.limit;
    return synced ? { ...node, limit: childrenSum(node) } : node;
  });
  return fix(next);
}

/** Разделить total на n частей: 100 на 3 → 34, 33, 33 */
const evenly = (total: number, n: number) => Array.from({ length: n }, (_, k) => Math.floor(total / n) + (k < total % n ? 1 : 0));

/** Копия квоты с новыми ID (вложенные получают ID от нового родителя) */
function reid(q: Quota, id: string, taken: string[]): Quota {
  taken.push(id);
  const children = (q.children ?? []).map((c) => reid(c, nextId(taken, `${id}_`), taken));
  return withChildren({ ...q, id }, children);
}

/** Все узлы на заданной глубине — пути к ним */
function pathsAtDepth(list: Quota[], depth: number, base: Path = []): Path[] {
  return list.flatMap((q, i) => (depth === 0 ? [[...base, i]] : pathsAtDepth(q.children ?? [], depth - 1, [...base, i])));
}

// ---------- Вкладка ----------

export function QuotasTab({ info, readOnly, reload }: { info: ProjectInfo; readOnly: boolean; reload: () => Promise<unknown> }) {
  const { value: quotas, setValue, dirty, busy, save } = useProjectDraft<Quota[]>(info.id, 'quotas', info.quotaDefs, reload, { message: 'Квоты сохранены' });
  const def = info.published ?? info.draft;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Куда добавить разбивку: путь квоты-родителя, [] — квоты верхнего уровня
  const [splitAt, setSplitAt] = useState<Path | null>(null);
  const progress = new Map(info.quotas.map((p) => [p.id, p]));
  const flat = flatQuotas(quotas);
  const ids = () => flat.map((q) => q.id);
  const set = (next: Quota[]) => setValue(resync(quotas, next));

  const firstCondition = (): Condition | null => {
    const first = allQuestions(def).find((q) => q.type !== 'info');
    if (!first) { toast('В анкете пока нет вопросов'); return null; }
    return { q: first.id, op: 'answered' };
  };
  const addRoot = () => {
    const c = firstCondition();
    if (c) set([...quotas, { id: nextId(ids(), 'QT'), if: c, limit: 100 }]);
  };
  const addChild = (path: Path) => {
    const c = firstCondition();
    if (!c) return;
    const parent = nodeAt(quotas, path);
    setCollapsed((s) => { const n = new Set(s); n.delete(parent.id); return n; });
    set(updateAt(quotas, path, (q) => withChildren(q, [...(q.children ?? []), { id: nextId(ids(), `${q.id}_`), if: c, limit: 0 }])));
  };
  const remove = (path: Path) => {
    const q = nodeAt(quotas, path);
    const n = countNodes(q) - 1;
    if (n && !confirm(`Удалить квоту «${q.title || q.id}» вместе с вложенными (${n})?`)) return;
    set(siblingsOp(quotas, path, (s, i) => s.filter((_, k) => k !== i)));
  };
  const duplicate = (path: Path) => {
    const taken = ids();
    const q = nodeAt(quotas, path);
    const parentId = path.length > 1 ? nodeAt(quotas, path.slice(0, -1)).id : null;
    const copy = reid(q, nextId(taken, parentId ? `${parentId}_` : 'QT'), taken);
    set(siblingsOp(quotas, path, (s, i) => [...s.slice(0, i + 1), { ...copy, title: q.title ? `${q.title} (копия)` : undefined }, ...s.slice(i + 1)].map((x) => compact(x))));
  };
  const move = (path: Path, d: -1 | 1) => set(siblingsOp(quotas, path, (s, i) => {
    const j = i + d;
    if (j < 0 || j >= s.length) return s;
    const out = [...s];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  }));
  const distribute = (path: Path) => set(updateAt(quotas, path, (q) => {
    const parts = evenly(q.limit, q.children?.length ?? 0);
    return withChildren(q, (q.children ?? []).map((c, k) => ({ ...c, limit: parts[k] })));
  }));
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** Добавить разбивку: к одной квоте, ко всем квотам того же уровня или к верхнему уровню */
  const applySplit = (parts: SplitPart[], allSame: boolean, total: number) => {
    if (!splitAt) return;
    const taken = ids();
    if (!splitAt.length) {
      const limits = evenly(total, parts.length);
      set([...quotas, ...parts.map((p, k) => { const id = nextId(taken, 'QT'); taken.push(id); return { id, title: p.title, if: p.if, limit: limits[k] }; })]);
    } else {
      const targets = allSame ? pathsAtDepth(quotas, splitAt.length - 1) : [splitAt];
      let next = quotas;
      for (const path of targets) {
        next = updateAt(next, path, (q) => {
          const limits = evenly(q.limit, parts.length);
          const kids = parts.map((p, k) => { const id = nextId(taken, `${q.id}_`); taken.push(id); return { id, title: p.title, if: p.if, limit: limits[k] }; });
          return withChildren(q, [...(q.children ?? []), ...kids]);
        });
      }
      setCollapsed(new Set());
      setValue(next);
    }
    setSplitAt(null);
  };

  const fullCount = flat.filter((q) => { const p = progress.get(q.id); return p && p.count >= q.limit; }).length;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>Квоты</h2>
          {flat.some((q) => q.depth > 0) && (
            <button className="btn-link small" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(flat.filter((q) => q.depth === 0).map((q) => q.id)))}>
              {collapsed.size ? 'Развернуть всё' : 'Свернуть всё'}
            </button>
          )}
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={() => setSplitAt([])} title="Сразу несколько квот – по вариантам вопроса">+ Квоты по вопросу</button>}
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={addRoot}>+ Квота</button>}
          {!readOnly && <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Счётчик считает завершённые анкеты, подходящие под условие. Вложенная квота действует внутри родительской: условие родителя
          писать не нужно (Москва → Женщины → 18–24). Когда лимит любой квоты набран, следующие подходящие респонденты заканчивают опрос
          со статусом «Сверх квоты» (сообщение и переход – в анкете → Настройки → Завершение). Проверка идёт после каждого ответа,
          поэтому квотные вопросы ставьте в начало анкеты. Условие может использовать и параметр ссылки: <code>param.src = "vk"</code>.
        </p>
        {quotas.length === 0 && <p className="muted" style={{ margin: 0 }}>Квот нет – принимаются все, кто прошёл анкету.</p>}
        {quotas.length > 0 && (
          <div className="qtree">
            <div className="qtree-head muted small">
              <span /><span /><span>ID</span><span>Название</span><span>Условие</span><span>Нужно</span><span>Набрано</span><span />
            </div>
            {quotas.map((q, i) => (
              <QuotaNode key={i} q={q} path={[i]} def={def} readOnly={readOnly} progress={progress} collapsed={collapsed}
                ops={{ set: (path, fn) => set(updateAt(quotas, path, fn)), addChild, remove, duplicate, move, distribute, toggle, split: setSplitAt }}
                siblings={quotas.length} />
            ))}
            {info.published && flat.length > 0 && (
              <div className="muted small qtree-foot">Набрано квот: {fullCount} из {flat.length} · счётчики – по опубликованной версии, после сохранения</div>
            )}
          </div>
        )}
      </div>
      {splitAt && (
        <SplitDialog def={def} info={info} parent={splitAt.length ? nodeAt(quotas, splitAt) : null}
          sameLevel={splitAt.length ? pathsAtDepth(quotas, splitAt.length - 1).length : 0}
          onClose={() => setSplitAt(null)} onApply={applySplit} />
      )}
    </div>
  );
}

function nodeAt(list: Quota[], path: Path): Quota {
  return path.slice(1).reduce((n, i) => n.children![i], list[path[0]]);
}

interface Ops {
  set: (path: Path, fn: (q: Quota) => Quota) => void;
  addChild: (path: Path) => void;
  remove: (path: Path) => void;
  duplicate: (path: Path) => void;
  move: (path: Path, d: -1 | 1) => void;
  distribute: (path: Path) => void;
  toggle: (id: string) => void;
  split: (path: Path) => void;
}

function QuotaNode({ q, path, def, readOnly, progress, collapsed, ops, siblings }: {
  q: Quota; path: Path; def: Survey; readOnly: boolean; progress: Map<string, Progress>; collapsed: Set<string>; ops: Ops; siblings: number;
}) {
  const kids = q.children ?? [];
  const open = !collapsed.has(q.id);
  const sum = childrenSum(q);
  const p = progress.get(q.id);
  const pct = p && q.limit ? Math.min(100, Math.round((p.count / q.limit) * 100)) : p ? 100 : 0;
  const idx = path[path.length - 1];
  const patch = (x: Partial<Quota>) => ops.set(path, (n) => compact({ ...n, ...x }));

  return (
    <div className={`qnode${path.length > 1 ? ' nested' : ''}`}>
      <div className="qrow" style={{ '--d': path.length - 1 } as CSSProperties}>
        <span className="qindent" />
        {kids.length
          ? <button className="icon-btn qtoggle" title={open ? 'Свернуть' : `Развернуть (${kids.length})`} onClick={() => ops.toggle(q.id)}>{open ? '▾' : '▸'}</button>
          : <span className="qtog" />}
        <input className="input mono qid" value={q.id} title="ID квоты" readOnly={readOnly}
          onChange={(e) => patch({ id: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })} />
        <input className="input qtitle" placeholder={path.length > 1 ? 'например, «Женщины»' : 'например, «Москва»'} value={q.title ?? ''} readOnly={readOnly}
          onChange={(e) => patch({ title: e.target.value || undefined })} />
        <div className="qcond">
          <ConditionField def={def} value={q.if} placeholder={path.length > 1 ? 'только своё условие, например S2 = 2' : 'например, S1 = 1'}
            onChange={(c) => c && patch({ if: c })} />
        </div>
        <div className="qlimit">
          <input className="input mini" type="number" min={0} value={q.limit} readOnly={readOnly} aria-label="Нужно анкет"
            onChange={(e) => patch({ limit: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
          {kids.length > 0 && sum !== q.limit && (
            readOnly
              ? <span className="qsum warn" title="Сумма вложенных квот">Σ {sum}</span>
              : <Menu className="qsum warn" title="Не совпадает с суммой вложенных квот" label={<>Σ {sum}</>} items={[
                { label: `Поставить ${sum} – сумму вложенных`, onClick: () => patch({ limit: sum }) },
                { label: `Распределить ${q.limit} поровну вниз`, onClick: () => ops.distribute(path) },
              ]} />
          )}
          {kids.length > 0 && sum === q.limit && <span className="qsum" title="Равно сумме вложенных квот и пересчитывается вместе с ними">= Σ</span>}
        </div>
        <div className="qprog" title={p ? 'По опубликованной версии анкеты' : 'Счётчик появится после сохранения'}>
          {p && <>
            <div className="quota-bar"><div style={{ width: `${pct}%` }} className={p.count >= q.limit ? 'full' : ''} /></div>
            <span className={`small${p.count >= q.limit ? ' ok-text' : ''}`}>{p.count}/{q.limit}</span>
          </>}
        </div>
        <div className="qactions">
          {!readOnly && <>
            <button className="btn-link small" title="Добавить вложенные квоты по вариантам вопроса" onClick={() => ops.split(path)}>Разбить…</button>
            <Menu items={[
              { label: '+ Вложенная квота', onClick: () => ops.addChild(path) },
              { label: 'Разбить по вопросу…', onClick: () => ops.split(path) },
              kids.length > 0 && { label: `Распределить ${q.limit} поровну вниз`, onClick: () => ops.distribute(path) },
              { label: 'Дублировать', onClick: () => ops.duplicate(path) },
              { label: 'Выше', onClick: () => ops.move(path, -1), disabled: idx === 0 },
              { label: 'Ниже', onClick: () => ops.move(path, 1), disabled: idx === siblings - 1 },
              { label: kids.length ? 'Удалить с вложенными' : 'Удалить', onClick: () => ops.remove(path), danger: true },
            ]} />
          </>}
        </div>
      </div>
      {kids.length > 0 && open && (
        <div className="qchildren">
          {kids.map((c, k) => (
            <QuotaNode key={k} q={c} path={[...path, k]} def={def} readOnly={readOnly} progress={progress} collapsed={collapsed} ops={ops} siblings={kids.length} />
          ))}
        </div>
      )}
      {kids.length > 0 && !open && <div className="qchildren muted small qfolded" onClick={() => ops.toggle(q.id)}>вложенных: {kids.length} – развернуть</div>}
    </div>
  );
}

// ---------- Разбивка по вопросу ----------

interface SplitPart { title: string; if: Condition }

const RANGE_TYPES = new Set(['number', 'slider', 'hidden']);

/** «18-24, 25-34, 45+» → условия-интервалы */
function parseRanges(text: string, qid: string): SplitPart[] | string {
  const out: SplitPart[] = [];
  for (const raw of text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const s = raw.replace(/\s/g, '').replace(/[––]/g, '-');
    let m: RegExpMatchArray | null;
    const num = (x: string) => Number(x.replace(',', '.'));
    if ((m = s.match(/^(-?\d+(?:[.,]\d+)?)-(-?\d+(?:[.,]\d+)?)$/))) {
      const [a, b] = [num(m[1]), num(m[2])];
      if (a > b) return `«${raw}»: начало больше конца`;
      out.push({ title: `${a}–${b}`, if: { all: [{ q: qid, op: 'gte', value: a }, { q: qid, op: 'lte', value: b }] } });
    } else if ((m = s.match(/^(-?\d+(?:[.,]\d+)?)(\+|-)$/))) {
      out.push({ title: `${num(m[1])}+`, if: { q: qid, op: 'gte', value: num(m[1]) } });
    } else if ((m = s.match(/^(?:до|<=?|-)(-?\d+(?:[.,]\d+)?)$/))) {
      out.push({ title: `до ${num(m[1])}`, if: { q: qid, op: 'lte', value: num(m[1]) } });
    } else if ((m = s.match(/^-?\d+(?:[.,]\d+)?$/))) {
      out.push({ title: String(num(s)), if: { q: qid, op: 'eq', value: num(s) } });
    } else return `Не понял «${raw}» – пишите 18-24, 45+ или до 17`;
  }
  return out;
}

function SplitDialog({ def, info, parent, sameLevel, onClose, onApply }: {
  def: Survey; info: ProjectInfo; parent: Quota | null; sameLevel: number;
  onClose: () => void; onApply: (parts: SplitPart[], allSame: boolean, total: number) => void;
}) {
  // Вопросы внутри циклов не годятся: у них по ответу на каждый элемент цикла
  const inLoop = new Set(def.blocks.filter((b) => loopChain(def, b).length).flatMap((b) => b.questions.map((q) => q.id)));
  const questions = allQuestions(def).filter((q) => !inLoop.has(q.id) && (hasOptions(q) || q.type === 'scale' || RANGE_TYPES.has(q.type)));
  const [source, setSource] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ranges, setRanges] = useState('18-24, 25-34, 35-44, 45-54, 55+');
  const [allSame, setAllSame] = useState(false);
  const [total, setTotal] = useState(100);

  // Значения источника: варианты вопроса, точки шкалы или панели проекта
  const q = source.startsWith('q:') ? questions.find((x) => x.id === source.slice(2)) : undefined;
  let values: { key: string; label: string; if: Condition }[] | null = null;
  if (source === 'panel') {
    values = info.panels.map((p) => ({ key: p.id, label: p.title || p.id, if: { param: 'panel', op: 'eq', value: p.id } }));
  } else if (q && hasOptions(q)) {
    values = allOptions(def, q).filter(isChoice).map((o) => ({ key: String(o.code), label: plainText(o.text) || String(o.code), if: { q: q.id, op: 'eq', value: o.code } }));
  } else if (q?.type === 'scale') {
    values = [
      ...Array.from({ length: q.to - q.from + 1 }, (_, k) => q.from + k).map((v) => ({ key: String(v), label: q.labels?.[v] ? `${v} – ${plainText(q.labels[v])}` : String(v), if: { q: q.id, op: 'eq', value: v } as Condition })),
      ...(q.extraOptions ?? []).map((o) => ({ key: String(o.code), label: plainText(o.text), if: { q: q.id, op: 'eq', value: o.code } as Condition })),
    ];
  }
  const rangeParts = q && RANGE_TYPES.has(q.type) ? parseRanges(ranges, q.id) : null;
  const parts: SplitPart[] | string = values
    ? values.filter((v) => picked.has(v.key)).map((v) => ({ title: v.label, if: v.if }))
    : rangeParts ?? [];
  const ok = Array.isArray(parts) && parts.length > 0;
  const each = parent ? parent.limit : total;
  const preview = ok ? evenly(each, (parts as SplitPart[]).length) : [];

  const choose = (v: string) => {
    setSource(v);
    const nq = v.startsWith('q:') ? questions.find((x) => x.id === v.slice(2)) : undefined;
    const keys = v === 'panel' ? info.panels.map((p) => p.id)
      : nq && hasOptions(nq) ? allOptions(def, nq).filter(isChoice).map((o) => String(o.code))
        : nq?.type === 'scale' ? [...Array.from({ length: nq.to - nq.from + 1 }, (_, k) => String(nq.from + k)), ...(nq.extraOptions ?? []).map((o) => String(o.code))] : [];
    setPicked(new Set(keys));
  };
  const groups = [
    { label: 'Вопросы', items: questions.map((x) => ({ value: `q:${x.id}`, label: `${x.id}. ${plainText(x.text).slice(0, 70) || x.type}` })) },
    ...(info.panels.length ? [{ label: 'Параметры ссылки', items: [{ value: 'panel', label: 'panel – панель' }] }] : []),
  ];

  return (
    <Modal onClose={onClose} size="medium" title={parent ? `Разбить «${parent.title || parent.id}»` : 'Квоты по вопросу'} actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
      <button className="btn btn-primary" disabled={!ok} onClick={() => onApply(parts as SplitPart[], allSame, total)}>
        Добавить {ok ? (parts as SplitPart[]).length : ''}
      </button>
    </>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>
          {parent
            ? <>Для каждого выбранного значения появится вложенная квота с условием только на этот вопрос – условие «{parent.title || parent.id}» уже действует.</>
            : <>Для каждого выбранного значения появится отдельная квота. Потом любую из них можно разбить дальше.</>}
        </p>
        <label className="field"><span>Вопрос</span>
          <SearchSelect value={source} groups={groups} onChange={choose} placeholder="– выберите вопрос –" />
        </label>
        {values && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row small">
              <span className="grow muted">Значения ({picked.size} из {values.length})</span>
              <button className="btn-link small" onClick={() => setPicked(new Set(values!.map((v) => v.key)))}>все</button>
              <button className="btn-link small" onClick={() => setPicked(new Set())}>ни одного</button>
            </div>
            <div className="qsplit-values">
              {values.map((v) => (
                <label key={v.key} className="check">
                  <input type="checkbox" checked={picked.has(v.key)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(v.key)) n.delete(v.key); else n.add(v.key); return n; })} />
                  <span className="mono muted small">{v.key}</span> {v.label}
                </label>
              ))}
            </div>
          </div>
        )}
        {rangeParts && (
          <label className="field"><span>Интервалы (включительно), через запятую</span>
            <input className="input mono" value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="18-24, 25-34, 35+" />
            {typeof rangeParts === 'string' ? <span className="field-error">{rangeParts}</span> : <span className="field-help">«45+» – от 45 и больше, «до 17» – 17 и меньше</span>}
          </label>
        )}
        {!parent && (
          <label className="row" style={{ gap: 8 }}><span className="muted small">Всего нужно</span>
            <input className="input mini" type="number" min={0} value={total} onChange={(e) => setTotal(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
          </label>
        )}
        {ok && (
          <p className="small" style={{ margin: 0 }}>
            Лимиты: {(parts as SplitPart[]).map((pt, k) => `${pt.title} – ${preview[k]}`).join(', ')}
            <span className="muted"> (поровну из {each}{parent ? ' – лимита родителя' : ''}; поправите в таблице)</span>
          </p>
        )}
        {parent && sameLevel > 1 && (
          <label className="check">
            <input type="checkbox" checked={allSame} onChange={(e) => setAllSame(e.target.checked)} />
            Так же разбить все квоты этого уровня ({sameLevel}) – например, и мужчин, и женщин в каждом городе
          </label>
        )}
      </div>
    </Modal>
  );
}
