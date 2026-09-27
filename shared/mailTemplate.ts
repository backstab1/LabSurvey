// Подстановки в письме-приглашении: {{link}} — персональная ссылка, {{param.name}} — столбец списка, {{inv_id}} — ID человека.
// Общая для сервера (отправка) и админки (предпросмотр).

export function fillMailTemplate(tpl: string, p: { fields: Record<string, string>; extId: string | null }, link: string): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, key: string) => {
    if (key === 'link') return link;
    if (key === 'inv_id') return p.extId ?? '';
    if (key.startsWith('param.')) return p.fields[key.slice(6)] ?? '';
    return all;
  });
}

export const hasLinkPlaceholder = (body: string) => /\{\{\s*link\s*\}\}/.test(body);

/** Похоже на адрес почты: что-то@домен.зона, без пробелов */
export const isEmail = (v: unknown): v is string => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
