// Редактор клиентских скриптов. Каждый хук — тело функции (sl) => { ... }
const HOOKS = {
  survey: [
    ['init', 'Глобальный скрипт', 'Выполняется на каждом экране перед остальными скриптами. Общие функции кладите в sl.shared.'],
  ],
  question: [
    ['beforeShow', 'Перед показом', 'До отрисовки вопроса, DOM ещё нет. Подготовьте значения: sl.set("H1", …).'],
    ['onShow', 'При показе вопроса', 'sl.el — DOM-элемент вопроса.'],
    ['onChange', 'При изменении ответа', 'sl.value — новое значение. Можно sl.set("H1", ...).'],
    ['validate', 'Доп. проверка', 'Вернуть строку — это текст ошибки. Пример: if (sl.value > sl.get("S1")) return "Больше возраста";'],
  ],
} as const;

type Level = keyof typeof HOOKS;

export function ScriptsEditor({ level, value, onChange, only }: {
  level: Level;
  /** Показать только эти хуки */
  only?: string[];
  value: { [K in string]?: string } | object | undefined;
  onChange: (v: any) => void;
}) {
  const set = (key: string, code: string) => {
    const next: Record<string, string | undefined> = { ...(value ?? {}), [key]: code || undefined };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="stack">
      {HOOKS[level].filter(([key]) => !only || only.includes(key)).map(([key, label, help]) => {
        let syntaxError = '';
        const code = (value as Record<string, string | undefined> | undefined)?.[key] ?? '';
        if (code) {
          try { new Function('sl', code); } catch (e) { syntaxError = (e as Error).message; }
        }
        return (
          <label key={key} className="field">
            <span>{label} <code>{key}</code> — {help}</span>
            <textarea className="input" spellCheck={false} rows={code ? Math.min(12, code.split('\n').length + 1) : 2}
              style={{ fontFamily: 'var(--mono)', fontSize: 13 }} value={code} placeholder="// JavaScript, объект sl"
              onChange={(e) => set(key, e.target.value)} />
            {syntaxError && <span style={{ color: 'var(--danger)' }}>Синтаксическая ошибка: {syntaxError}</span>}
          </label>
        );
      })}
    </div>
  );
}
