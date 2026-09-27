import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public data: any) {
    super(data?.error ?? `Ошибка ${status}`);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/**
 * Данные с сервера для компонента: загружаются при изменении url (null — не загружать) и refresh — других значений,
 * после которых данные надо перечитать (например, счётчиков проекта).
 * Ответ на устаревший запрос отбрасывается — быстрое переключение фильтров не покажет старые данные.
 */
export function useApi<T>(url: string | null, refresh: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const reload = useCallback(async (): Promise<T | null> => {
    if (url === null) return null;
    const n = ++seq.current;
    try {
      const d = await api<T>('GET', url);
      if (n === seq.current) { setData(d); setError(''); }
      return d;
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...refresh]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload, setData };
}
