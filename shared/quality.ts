// Качество ответов: пометки (флаги), их вес и итоговый балл риска 0–100.
// Сильные сигналы (ловушка для ботов, автоматизированный браузер, контрольный вопрос) сами делают анкету подозрительной,
// слабые (вставка текста, похожий на ИИ текст, спидер) — только вместе с другими.

/** С этого балла анкета считается подозрительной */
export const SUSPECT_SCORE = 50;

/** Вес пометки по её виду (часть до двоеточия: paste:Q5 → paste) */
export const FLAG_WEIGHTS: Record<string, number> = {
  bot: 100,
  automation: 100,
  attention: 60,
  straightline: 50,
  device: 50,
  duptext: 50,
  notyping: 40,
  speeder: 40,
  paste: 30,
  aitext: 30,
};

export const flagKind = (flag: string) => flag.split(':')[0];
export const flagWeight = (flag: string) => FLAG_WEIGHTS[flagKind(flag)] ?? SUSPECT_SCORE;

/** Балл риска: сумма весов пометок, не больше 100 */
export function qualityScore(flags: string[] | undefined): number {
  return Math.min(100, (flags ?? []).reduce((a, f) => a + flagWeight(f), 0));
}

/** Пометка качества — по-человечески */
export function flagLabel(flag: string): string {
  const [kind, id] = flag.split(':');
  switch (kind) {
    case 'bot': return 'бот (заполнено скрытое поле)';
    case 'automation': return 'автоматизированный браузер';
    case 'attention': return `ошибка в контрольном вопросе ${id}`;
    case 'straightline': return `одинаковые ответы в матрице ${id}`;
    case 'device': return 'с этого устройства опрос уже проходили';
    case 'duptext': return `открытый ответ ${id} совпадает с ответом другого респондента`;
    case 'notyping': return `ответ ${id} появился без набора текста`;
    case 'speeder': return 'слишком быстро';
    case 'paste': return `ответ ${id} вставлен из буфера обмена`;
    case 'aitext': return `ответ ${id} похож на текст от ИИ`;
    default: return flag;
  }
}

/** Как респондент вводил открытый ответ: k — событий ввода с клавиатуры, p — символов вставлено */
export interface TypingStat { k: number; p: number }

/** Фразы, типичные для ответов языковых моделей (в нижнем регистре) */
const AI_PHRASES = [
  'как языковая модель', 'как ии', 'как искусственный интеллект', 'я не могу иметь', 'у меня нет личного',
  'важно отметить', 'стоит отметить', 'следует отметить', 'в заключение', 'таким образом,', 'в целом,', 'подводя итог',
  'играет важную роль', 'играет ключевую роль', 'является ключевым', 'с одной стороны', 'с другой стороны', 'безусловно,',
  'as an ai', 'as a language model', 'it is important to note', 'overall,', 'in conclusion', 'delve',
];
const SELF_REF = ['как языковая модель', 'как ии', 'как искусственный интеллект', 'as an ai', 'as a language model'];

/** Признаки текста от ИИ; флаг ставится при двух и больше признаках или явном «я — ИИ» */
export function aiTextSignals(text: string): string[] {
  const t = text.trim();
  const low = t.toLowerCase();
  const out: string[] = [];
  if (SELF_REF.some((p) => low.includes(p))) out.push('self');
  const phrases = AI_PHRASES.filter((p) => low.includes(p)).length;
  if (phrases) out.push('phrases');
  if (phrases >= 2) out.push('phrases2');
  // Длинное тире, «ёлочки» и маркированные списки люди с телефона почти не набирают
  if (/—/.test(t)) out.push('emdash');
  if (/(^|\n)\s*([-•*]|\d+[.)])\s+\S/.test(t) && t.split('\n').length >= 3) out.push('list');
  if (/\*\*[^*]+\*\*/.test(t)) out.push('markdown');
  // Длинный, аккуратно оформленный текст: несколько предложений, каждое с заглавной буквы и с точкой
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (t.length >= 200 && sentences.length >= 3 && sentences.every((s) => /^[A-ZА-ЯЁ«"]/.test(s) && /[.!?»"]$/.test(s))) out.push('polished');
  return out;
}

export const looksLikeAi = (text: string) => {
  const s = aiTextSignals(text);
  return s.includes('self') || s.length >= 2;
};

/** Минимальная длина открытого ответа, с которой проверяются вставка, набор, совпадения и признаки ИИ */
export const TEXT_CHECK_MIN = 20;

/** Пометки открытого ответа по тексту и тому, как его вводили (без проверки совпадений — она на сервере) */
export function textFlags(qid: string, text: string, stat: TypingStat | undefined): string[] {
  const t = text.trim();
  if (t.length < TEXT_CHECK_MIN) return [];
  const out: string[] = [];
  if (stat) {
    if (stat.p >= TEXT_CHECK_MIN) out.push(`paste:${qid}`);
    // Длинный текст пришёл одним-двумя событиями ввода без вставки — его подставил скрипт
    else if (t.length >= 40 && stat.k <= 2) out.push(`notyping:${qid}`);
  }
  if (looksLikeAi(t)) out.push(`aitext:${qid}`);
  return out;
}
