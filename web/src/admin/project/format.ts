// Форматирование чисел и дат на страницах проекта
import type { ResponseStatus } from '../../../../shared/variables.ts';

/** Дата и время коротко; пусто — empty */
export const fmtDate = (iso?: string | null, empty = '') => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : empty);

/** Статусы анкет в порядке фильтров выгрузки */
export const EXPORT_STATUSES: ResponseStatus[] = ['completed', 'screened_out', 'overquota', 'terminated', 'in_progress'];

/** Процент a от b: «42%» или «—» */
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
export const fmtDuration = (sec: number | null) => (sec === null ? '–' : sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин${sec % 60 ? ` ${sec % 60} с` : ''}`);
