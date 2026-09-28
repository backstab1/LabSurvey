// Значки видов вопросов: линейные SVG в одном стиле (24×24, обводка currentColor)
import type { ReactNode } from 'react';
import type { QuestionKind } from '../../../../shared/types.ts';

const dot = (cx: number, cy: number, r = 1.6) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const PATHS: Record<QuestionKind | 'paste', ReactNode> = {
  single: <><circle cx="12" cy="12" r="8" />{dot(12, 12, 3.5)}</>,
  multi: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></>,
  dropdown: <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M7 12h5M15 11l1.5 1.5L18 11" /></>,
  ranking: <><path d="M4 8l3-3 3 3M7 5v14M4 16l3 3 3-3" /><path d="M14 7h6M14 12h4.5M14 17h3" /></>,
  text: <path d="M4 6.5h16M4 11.5h16M4 16.5h10" />,
  number: <path d="M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16" />,
  scale: <><path d="M5 19v-3M10 19v-6M15 19v-9M20 19V6" /></>,
  slider: <><path d="M3 12h7M18 12h3" /><circle cx="14" cy="12" r="3.5" /></>,
  matrix: <><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17M3.5 14.8h17M9.5 4v16" /></>,
  differential: <><path d="M6 8l-3 4 3 4M18 8l3 4-3 4M7 12h10" />{dot(12, 12, 2.2)}</>,
  date: <><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />{dot(9, 14.5, 1.1)}{dot(12, 14.5, 1.1)}{dot(15, 14.5, 1.1)}</>,
  phone: <><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M11 17.5h2" /></>,
  file: <path d="M12 15.5V5M8 9l4-4 4 4M5 14.5v3a2.5 2.5 0 0 0 2.5 2.5h9a2.5 2.5 0 0 0 2.5-2.5v-3" />,
  cardsort: <><rect x="3" y="8" width="11" height="12" rx="2" /><path d="M7.5 8V6a2 2 0 0 1 2-2H19a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-5" /></>,
  sum: <><circle cx="12" cy="12" r="8" /><path d="M12 4v8l6 5" /></>,
  hotspot: <><circle cx="12" cy="12" r="6.5" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />{dot(12, 12, 1.8)}</>,
  maxdiff: <path d="M8 19V5M4.5 8.5L8 5l3.5 3.5M16 5v14M12.5 15.5L16 19l3.5-3.5" />,
  conjoint: <><rect x="3" y="5" width="8" height="14" rx="2" /><rect x="13" y="5" width="8" height="14" rx="2" /><path d="M5.5 9.5h3M15.5 9.5h3M5.5 13h3M15.5 13h3" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" />{dot(12, 7.8, 1.2)}</>,
  consent: <><path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6l7-3z" /><path d="M9 12l2.2 2.2L15.5 10" /></>,
  hidden: <path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 8.5 4 9.5 6-.5 1-1.3 2.1-2.3 3.1M6.6 6.6C4.6 7.9 3.2 10 2.5 12c1 2 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  paste: <><rect x="5" y="4.5" width="14" height="16" rx="2.5" /><path d="M9 4.5V3.8A1.3 1.3 0 0 1 10.3 2.5h3.4A1.3 1.3 0 0 1 15 3.8v.7M9 11h6M9 15h4" /></>,
};

export function TypeIcon({ kind, size = 18 }: { kind: QuestionKind | 'paste'; size?: number }) {
  return (
    <svg className="type-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}
