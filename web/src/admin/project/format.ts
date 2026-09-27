// Форматирование чисел и дат на страницах проекта

export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Процент a от b: «42%» или «—» */
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
export const fmtDuration = (sec: number | null) => (sec === null ? '—' : sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин${sec % 60 ? ` ${sec % 60} с` : ''}`);
