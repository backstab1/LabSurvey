import { useState } from 'react';
import { api, ApiError } from '../../api.ts';
import { toast, useUnsaved } from '../common.tsx';

/**
 * Черновик одного поля проекта (панели, квоты, настройки сбора): правится локально, сохраняется PUT-запросом,
 * при несохранённых правках уход со страницы переспрашивается.
 * same — сравнение с сохранённым (по умолчанию — по JSON); errorBox — ошибку показать в форме, а не всплывашкой.
 */
export function useProjectDraft<T>(projectId: string, field: string, saved: T, reload: () => Promise<unknown>, opts: {
  message: string; same?: (a: T, b: T) => boolean; errorBox?: boolean;
}) {
  const [value, setValue] = useState<T>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = !(opts.same ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b)))(value, saved);
  useUnsaved(dirty);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api('PUT', `/api/admin/projects/${projectId}`, { [field]: value });
      await reload();
      toast(opts.message);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Не удалось сохранить';
      if (opts.errorBox) setError(msg);
      else toast(msg);
    } finally { setBusy(false); }
  };
  return { value, setValue, dirty, busy, error, save };
}
