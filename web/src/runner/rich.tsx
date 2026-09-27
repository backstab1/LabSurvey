import type { ReactNode } from 'react';

/**
 * Простое форматирование текста анкеты (без HTML — всё экранируется React):
 * **жирный**, *курсив*, [ссылка](https://…), ![картинка](https://…), переносы строк.
 */
const TOKEN = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)/g;

const safeUrl = (url: string) => (/^(https?:|mailto:|\/)/i.test(url) ? url : '#');

export function rich(text: string | undefined): ReactNode {
  if (!text) return text;
  if (!/[*[!]/.test(text)) return text;
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<img key={k++} className="rich-img" src={safeUrl(m[3])} alt={m[2]} loading="lazy" />);
    else if (m[4]) out.push(<a key={k++} href={safeUrl(m[6])} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
    else if (m[7]) out.push(<strong key={k++}>{m[8]}</strong>);
    else if (m[9]) out.push(<em key={k++}>{m[10]}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
