// Простая статистика для отчётов и таблиц

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Медиана; для чётного числа значений — среднее двух средних */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Выборочное стандартное отклонение */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
