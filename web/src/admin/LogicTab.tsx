import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Segmented } from './common.tsx';
import { plain } from '../runner/rich.tsx';
import { describeCondition } from './ConditionEditor.tsx';
import { TYPE_ICONS } from './Builder.tsx';
import { analyzeFlow, type FlowEdge, type FlowNode } from '../../../shared/flow.ts';
import { describeLoop, shownTitle } from './LoopEditor.tsx';
import { loopDepth } from '../../../shared/loops.ts';
import type { Survey } from '../../../shared/types.ts';

const LANE = 14;
const MAX_LANES = 10;

interface Arc { from: string; to: string; lane: number; y1: number; y2: number; conditional: boolean }

/** Примерное время: ~12 секунд на вопрос */
const minutes = (n: number) => Math.max(1, Math.round((n * 12) / 60));

export function LogicTab({ def, onOpen }: { def: Survey; onOpen: (id: string) => void }) {
  const flow = useMemo(() => analyzeFlow(def), [def]);
  const [filter, setFilter] = useState<'all' | 'logic'>('all');
  const [hover, setHover] = useState<string | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [height, setHeight] = useState(0);

  const { stats, issues } = flow;
  const hasLogic = (n: FlowNode) => n.conditional || n.out.length > 0 || n.in.length > 0 || !n.reachable;
  const shown = flow.nodes.filter((n) => filter === 'all' || hasLogic(n));
  const shownIds = new Set(shown.map((n) => n.id));

  // Дуги переходов: позиции строк измеряются после отрисовки
  useLayoutEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      const y = new Map<string, number>();
      el.querySelectorAll<HTMLElement>('[data-row]').forEach((row) => {
        const r = row.getBoundingClientRect();
        y.set(row.dataset.row!, r.top - top + Math.min(22, r.height / 2));
      });
      const edges = flow.nodes.flatMap((n) => n.out
        .filter((e) => e.kind === 'goTo' && e.target && !e.backward && y.has(n.id) && y.has(e.target))
        .map((e) => ({ from: n.id, to: e.target!, y1: y.get(n.id)!, y2: y.get(e.target!)!, conditional: !!e.if })));
      // Раскладка по дорожкам: короткие переходы ближе к вопросам, пересекающиеся — на разных дорожках
      edges.sort((a, b) => (a.y2 - a.y1) - (b.y2 - b.y1));
      const lanes: [number, number][][] = [];
      const placed: Arc[] = edges.map((e) => {
        let lane = 0;
        while (lane < MAX_LANES - 1 && lanes[lane]?.some(([s, t]) => !(e.y2 < s - 4 || e.y1 > t + 4))) lane++;
        (lanes[lane] ??= []).push([e.y1, e.y2]);
        return { ...e, lane };
      });
      setArcs(placed);
      setHeight(el.scrollHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [flow, filter]);

  const laneCount = Math.max(1, ...arcs.map((a) => a.lane + 1));
  const gutter = 18 + laneCount * LANE;

  const targetName = (id: string) => {
    const b = def.blocks.find((x) => x.id === id);
    return b ? `блок «${b.title || b.id}»` : id;
  };
  const edgeLabel = (e: FlowEdge) => (e.if ? ` если ${describeCondition(def, e.if)}` : '');
  let lastBlock = '';

  return (
    <div className="logic">
      <div className="logic-stats">
        <Stat value={stats.questions} label="вопросов" />
        <Stat
          value={stats.minPath === null ? '—' : stats.minPath === stats.maxPath ? `${stats.minPath}` : `${stats.minPath}–${stats.maxPath}`}
          label={stats.minPath === null ? 'завершить нельзя' : `вопросов на пути до конца · ≈ ${minutes(stats.minPath)}${stats.maxPath !== stats.minPath ? `–${minutes(stats.maxPath ?? 0)}` : ''} мин`} />
        <Stat value={stats.conditional} label="показываются по условию" />
        <Stat value={stats.jumps} label="переходов" />
        <Stat value={stats.screenouts} label="точек отсева" />
      </div>

      {issues.length > 0 ? (
        <div className="logic-issues">
          {issues.map((i, k) => (
            <button key={k} className={`logic-issue ${i.level}`} onClick={() => i.id && onOpen(i.id)} disabled={!i.id}>
              {i.id && <span className="mono">{i.id}</span>}{i.message}
            </button>
          ))}
        </div>
      ) : <div className="ok-box">Проблем в маршрутах не найдено: до каждого вопроса можно дойти, анкету можно завершить.</div>}

      <div className="row logic-toolbar">
        <Segmented value={filter} onChange={setFilter}
          options={[{ value: 'all', label: 'Все вопросы' }, { value: 'logic', label: 'Только с логикой' }]} />
        <span className="muted small">Линии слева — переходы. Наведите на вопрос, чтобы выделить его связи; клик открывает вопрос.</span>
      </div>

      <div className="logic-map" ref={mapRef} style={{ ['--gutter' as string]: `${gutter}px` }}>
        <svg className="logic-arcs" width={gutter} height={height} aria-hidden>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          {arcs.map((a, k) => {
            const x = gutter - 12 - a.lane * LANE;
            const r = Math.min(8, (a.y2 - a.y1) / 2);
            const d = `M ${gutter - 4} ${a.y1} H ${x + r} Q ${x} ${a.y1} ${x} ${a.y1 + r} V ${a.y2 - r} Q ${x} ${a.y2} ${x + r} ${a.y2} H ${gutter - 2}`;
            const active = hover === a.from || hover === a.to;
            return (
              <path key={k} d={d} className={`arc${a.conditional ? ' cond' : ''}${active ? ' active' : ''}${hover && !active ? ' dim' : ''}`}
                markerEnd="url(#arrow)" />
            );
          })}
        </svg>

        {shown.map((n) => {
          const header = n.blockId !== lastBlock;
          lastBlock = n.blockId;
          const block = def.blocks.find((b) => b.id === n.blockId);
          const indent = block ? loopDepth(def, block) * 22 + (block.loop || block.parent ? 10 : 0) : 0;
          const related = hover && (hover === n.id || n.in.some((x) => x.from === hover) || flow.nodes.find((x) => x.id === hover)?.out.some((e) => e.target === n.id));
          return (
            <Fragment key={n.id}>
              {header && (
                <div className={`lblock${block?.loop ? ' loop' : ''}`} style={indent ? { marginLeft: indent } : undefined}>
                  {shownTitle(n.blockTitle) || `Блок ${def.blocks.indexOf(block!) + 1}`}
                  {block?.loop && <span className="lloop">{describeLoop(def, block)}</span>}
                  {block?.parent && !block.loop && <span className="lloop">повторяется внутри цикла «{block.parent}»</span>}
                </div>
              )}
              <div data-row={n.id} style={indent ? { marginLeft: indent } : undefined}
                className={`lrow${n.reachable ? '' : ' unreachable'}${n.q.type === 'hidden' ? ' hidden-q' : ''}${related ? ' related' : ''}${n.repeats ? ' in-loop' : ''}`}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => onOpen(n.id)}>
                <div className="lhead">
                  <span className="lnum">{n.number ?? '·'}</span>
                  <span className="qid">{n.id}</span>
                  <span className="ltype" title={n.q.type}>{TYPE_ICONS[n.q.type]}</span>
                  <span className="ltext">{plain(n.q.text) || <em className="muted">без текста</em>}</span>
                </div>
                <div className="lmeta">
                  {!n.reachable && n.q.type !== 'hidden' && <span className="lchip bad">недостижим</span>}
                  {n.q.showIf && <span className="lchip cond">показ: если {describeCondition(def, n.q.showIf)}</span>}
                  {!n.q.showIf && n.conditional && !n.repeats && <span className="lchip cond">может быть пропущен</span>}
                  {n.repeats && <span className="lchip loop" title="Сколько раз вопрос может повториться у одного респондента">↻ до {n.repeats.max} повтор{n.repeats.max % 10 === 1 && n.repeats.max % 100 !== 11 ? 'а' : 'ов'}</span>}
                  {n.loopSource?.map((b) => <span key={b} className="lchip loop">источник цикла «{shownTitle(def.blocks.find((x) => x.id === b)?.title) || b}»</span>)}
                  {n.in.filter((x) => shownIds.has(x.from)).map((x, k) => (
                    <span key={`in${k}`} className="lchip in">← из {x.from}{edgeLabel(x.edge)}</span>
                  ))}
                  {n.out.map((e, k) => (
                    <span key={`out${k}`} className={`lchip ${e.kind}`}>
                      {e.kind === 'goTo' ? `→ ${targetName(e.rawTarget!)}` : e.kind === 'end' ? '■ завершить' : '✕ отсев'}{edgeLabel(e)}
                    </span>
                  ))}
                </div>
              </div>
            </Fragment>
          );
        })}
        <div className="lend">Конец анкеты</div>
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="lstat">
      <div className="stat">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
