// Анализ маршрутов анкеты: переходы между вопросами, достижимость, длина анкеты.
// Условия не вычисляются — считается, что каждое может сработать или нет.
import { allQuestions } from './logic.ts';
import { loopChain, possibleItems } from './loops.ts';
import { END, SCREENOUT, type Condition, type Question, type Survey } from './types.ts';

export type Outcome = 'goTo' | 'end' | 'screenout';

export interface FlowEdge {
  kind: Outcome;
  /** ID вопроса-цели (для goTo; переход к блоку уже развёрнут в его первый вопрос) */
  target?: string;
  /** Исходная цель — вопрос или блок, как записано в анкете */
  rawTarget?: string;
  if?: Condition;
  /** Переход назад — не учитывается в расчётах маршрута */
  backward?: boolean;
}

export interface FlowNode {
  id: string;
  index: number;
  q: Question;
  blockId: string;
  blockTitle?: string;
  /** Номер вопроса для людей (скрытые переменные не нумеруются) */
  number: number | null;
  /** Может быть пропущен: условие показа или действия «пропустить / отметить без показа» */
  conditional: boolean;
  out: FlowEdge[];
  in: { from: string; edge: FlowEdge }[];
  /** После правил есть переход к следующему вопросу (нет безусловного перехода/завершения) */
  fallsThrough: boolean;
  reachable: boolean;
  /** Вопрос внутри цикла: сколько раз может повториться (произведение по уровням) и глубина вложенности */
  repeats?: { max: number; depth: number };
  /** Вопрос — источник цикла для этих блоков */
  loopSource?: string[];
}

export interface FlowIssue {
  id?: string;
  level: 'error' | 'warning';
  message: string;
}

export interface FlowAnalysis {
  nodes: FlowNode[];
  issues: FlowIssue[];
  stats: {
    questions: number;
    conditional: number;
    jumps: number;
    screenouts: number;
    ends: number;
    /** Минимум и максимум вопросов (экранов) на пути до завершения; null — завершить нельзя */
    minPath: number | null;
    maxPath: number | null;
  };
}

const SKIP_ACTIONS = new Set(['skipIfFewer', 'answer']);

export function analyzeFlow(survey: Survey): FlowAnalysis {
  const questions = allQuestions(survey);
  const indexOf = new Map(questions.map((q, i) => [q.id, i]));
  const blockStart = new Map(survey.blocks.filter((b) => b.questions.length).map((b) => [b.id, b.questions[0].id]));
  const blockOfQ = new Map<string, { id: string; title?: string }>();
  for (const b of survey.blocks) for (const q of b.questions) blockOfQ.set(q.id, { id: b.id, title: b.title });
  // Циклы: сколько повторов возможно на каждом уровне (с учётом max)
  const repeatsOf = new Map<string, { max: number; depth: number }>();
  const loopSources = new Map<string, string[]>();
  const loopIssues: FlowIssue[] = [];
  for (const b of survey.blocks) {
    const chain = loopChain(survey, b);
    if (b.loop) {
      const n = possibleItems(survey, b).length;
      if (!n) loopIssues.push({ id: b.questions[0]?.id, level: 'warning', message: `Цикл «${b.title || b.id}»: нет ни одного возможного элемента` });
      if (b.loop.question) loopSources.set(b.loop.question, [...(loopSources.get(b.loop.question) ?? []), b.id]);
    }
    if (!chain.length) continue;
    const max = chain.reduce((m, lb) => m * Math.max(0, Math.min(possibleItems(survey, lb).length, lb.loop?.max ?? Infinity)), 1);
    for (const q of b.questions) repeatsOf.set(q.id, { max, depth: chain.length });
  }

  let n = 0;
  const nodes: FlowNode[] = questions.map((q, index) => {
    const out: FlowEdge[] = [];
    let fallsThrough = true;
    for (const a of q.actions?.after ?? []) {
      if (a.do !== 'goTo' && a.do !== 'end' && a.do !== 'screenout') continue;
      const edge: FlowEdge = { kind: a.do, ...(a.if ? { if: a.if } : {}) };
      if (a.do === 'goTo' && a.target) {
        const target = blockStart.get(a.target) ?? a.target;
        edge.target = target;
        edge.rawTarget = a.target;
        const t = indexOf.get(target);
        if (t === undefined) continue;
        if (t <= index) edge.backward = true;
      }
      out.push(edge);
      // Первое безусловное правило — дальше правила не проверяются и к следующему вопросу не идём
      if (!a.if) { fallsThrough = false; break; }
    }
    // Пропускается, если есть условие показа, действие пропуска/автоответа или перенос вариантов (переносить может быть нечего)
    const conditional = !!q.showIf || !!(q as { optionsFrom?: unknown }).optionsFrom || !!(q as { rowsFrom?: unknown }).rowsFrom
      || (q.actions?.before ?? []).some((a) => SKIP_ACTIONS.has(a.do) || a.do === 'hideOptions' || a.do === 'showOnlyOptions' || a.do === 'hideOptionsFrom');
    const block = blockOfQ.get(q.id)!;
    const repeats = repeatsOf.get(q.id);
    return {
      id: q.id, index, q, blockId: block.id, blockTitle: block.title,
      number: q.type === 'hidden' ? null : ++n,
      // Вопрос цикла может не показаться ни разу — если не выбрано ни одного элемента
      conditional: conditional || !!repeats, out, in: [], fallsThrough, reachable: false,
      ...(repeats ? { repeats } : {}),
      ...(loopSources.has(q.id) ? { loopSource: loopSources.get(q.id) } : {}),
    };
  });

  for (const node of nodes) {
    for (const e of node.out) {
      if (e.kind === 'goTo' && e.target) nodes[indexOf.get(e.target)!]?.in.push({ from: node.id, edge: e });
    }
  }

  // Переходы из вопроса: правила + следующий вопрос; скрытый/пропускаемый вопрос тоже ведёт к следующему
  const nextOf = (i: number) => (i + 1 < nodes.length ? i + 1 : END);
  const successors = (node: FlowNode): (number | typeof END | typeof SCREENOUT)[] => {
    const res: (number | typeof END | typeof SCREENOUT)[] = [];
    for (const e of node.out) {
      if (e.backward) continue;
      if (e.kind === 'end') res.push(END);
      else if (e.kind === 'screenout') res.push(SCREENOUT);
      else if (e.target) res.push(indexOf.get(e.target)!);
    }
    if (node.fallsThrough || node.conditional || node.q.type === 'hidden') res.push(nextOf(node.index));
    return res;
  };

  // Достижимость от первого вопроса
  let endReachable = false;
  if (nodes.length) {
    const stack = [0];
    nodes[0].reachable = true;
    while (stack.length) {
      const i = stack.pop()!;
      for (const s of successors(nodes[i])) {
        if (s === END) { endReachable = true; continue; }
        if (s === SCREENOUT) continue;
        if (!nodes[s].reachable) { nodes[s].reachable = true; stack.push(s); }
      }
    }
  } else endReachable = true;

  // Длина маршрута до завершения (граф без переходов назад — ациклический): динамика с конца
  const INF = Number.POSITIVE_INFINITY;
  const minTo: number[] = new Array(nodes.length).fill(INF);
  const maxTo: number[] = new Array(nodes.length).fill(-INF);
  const value = (s: number | string, arr: number[], empty: number) => (s === END ? 0 : s === SCREENOUT ? empty : arr[s as number]);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    // В максимуме вопрос цикла считается столько раз, сколько может повториться
    const cost = node.q.type === 'hidden' ? 0 : 1;
    const maxCost = node.q.type === 'hidden' ? 0 : node.repeats?.max ?? 1;
    const shownSucc: (number | string)[] = [];
    for (const e of node.out) {
      if (e.backward) continue;
      shownSucc.push(e.kind === 'end' ? END : e.kind === 'screenout' ? SCREENOUT : indexOf.get(e.target!)!);
    }
    if (node.fallsThrough) shownSucc.push(nextOf(i));
    let mn = INF;
    let mx = -INF;
    for (const s of shownSucc) {
      mn = Math.min(mn, cost + value(s, minTo, INF));
      mx = Math.max(mx, maxCost + value(s, maxTo, -INF));
    }
    // Вопрос может быть не показан — тогда сразу к следующему
    if (node.conditional || node.q.type === 'hidden') {
      mn = Math.min(mn, value(nextOf(i), minTo, INF));
      mx = Math.max(mx, value(nextOf(i), maxTo, -INF));
    }
    minTo[i] = mn;
    maxTo[i] = mx;
  }

  const issues: FlowIssue[] = [...loopIssues];
  for (const node of nodes) {
    if (!node.reachable && node.q.type !== 'hidden') {
      issues.push({ id: node.id, level: 'warning', message: 'До вопроса нельзя дойти: все пути ведут мимо него' });
    }
    for (const e of node.out) {
      if (e.backward) issues.push({ id: node.id, level: 'warning', message: `Переход назад к ${e.rawTarget} — возможен бесконечный цикл` });
    }
  }
  if (nodes.length && !endReachable) {
    issues.unshift({ level: 'error', message: 'Анкету нельзя завершить: все пути заканчиваются отсевом' });
  }

  const allEdges = nodes.flatMap((x) => x.out);
  return {
    nodes,
    issues,
    stats: {
      questions: nodes.filter((x) => x.q.type !== 'hidden').length,
      conditional: nodes.filter((x) => x.conditional).length,
      jumps: allEdges.filter((e) => e.kind === 'goTo').length,
      screenouts: allEdges.filter((e) => e.kind === 'screenout').length,
      ends: allEdges.filter((e) => e.kind === 'end').length,
      minPath: nodes.length && isFinite(minTo[0]) ? minTo[0] : nodes.length ? null : 0,
      maxPath: nodes.length && isFinite(maxTo[0]) ? maxTo[0] : nodes.length ? null : 0,
    },
  };
}
