// Разбор списка из Excel / CSV: вставка таблицы или файл; заголовки → имена параметров ссылки

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const RESERVED = new Set(['preview', 'new', 'rid', 'test', 'survey', 'start', 'inv', 'inv_id', 'panel']);

/** Заголовок столбца → имя параметра (латиница): «Отдел» → otdel, «E-mail» → e-mail */
export function paramName(header: string, used: Set<string>): string {
  let s = header.trim().toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '').slice(0, 40) || 'field';
  if (RESERVED.has(s)) s = `${s}_`;
  let name = s;
  for (let i = 2; used.has(name); i++) name = `${s}${i}`;
  used.add(name);
  return name;
}

/** CSV / вставка из Excel: разделитель — табуляция, «;» или «,»; кавычки поддерживаются */
export function parseTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();
  if (!clean) return [];
  const first = clean.split('\n')[0];
  const delim = first.includes('\t') ? '\t' : (first.split(';').length >= first.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}
