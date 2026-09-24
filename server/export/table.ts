import { buildVariables, labelled, type Cell, type ResponseRecord, type VarDef } from '../../shared/variables.ts';
import type { Survey } from '../../shared/types.ts';
import { config } from '../config.ts';

/**
 * Сдвигает момент времени так, чтобы его UTC-поля совпали с местным временем в часовом поясе.
 * Excel и SPSS не знают о часовых поясах — показываем «настенное» время.
 */
export function toWallClock(d: Date, timeZone = config.timezone): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

export interface Table {
  vars: VarDef[];
  rows: Cell[][];
}

export function buildTable(survey: Survey, responses: ResponseRecord[], opts: { timings?: boolean } = {}): Table {
  const vars = buildVariables(survey, responses, opts);
  const rows = responses.map((r) =>
    vars.map((v) => {
      const cell = v.get(r);
      return v.kind === 'datetime' && cell instanceof Date ? toWallClock(cell) : cell;
    }),
  );
  return { vars, rows };
}

export function withLabels(t: Table): Cell[][] {
  return t.rows.map((row) => row.map((cell, i) => labelled(t.vars[i], cell)));
}

/** Значение для текстовых форматов (Google Sheets) */
export function cellToText(v: VarDef, cell: Cell): string | number {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const iso = cell.toISOString();
    return v.kind === 'date' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  return cell;
}
