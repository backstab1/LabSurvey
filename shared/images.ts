// Картинки анкеты: библиотека (survey.images) и где каждая картинка используется
import type { Option, Question, Survey, SurveyImage } from './types.ts';

export interface ImageUse { url: string; where: string[] }

const MD_IMAGE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** Все картинки, которые использует анкета: варианты, строки и столбцы, уровни конджойнта, клик по картинке, логотип, тексты */
export function usedImages(def: Survey): ImageUse[] {
  const map = new Map<string, Set<string>>();
  const note = (url: string | undefined, where: string) => {
    if (!url) return;
    if (!map.has(url)) map.set(url, new Set());
    map.get(url)!.add(where);
  };
  const texts = (text: string | undefined, where: string) => {
    for (const m of (text ?? '').matchAll(MD_IMAGE)) note(m[1], where);
  };
  const opts = (list: Option[] | undefined, where: string) => list?.forEach((o) => { note(o.image, where); texts(o.text, where); });
  note(def.settings?.logoUrl, 'логотип');
  texts(def.settings?.footerText, 'подвал');
  for (const b of def.blocks) {
    for (const q of b.questions as Question[]) {
      texts(q.text, q.id);
      texts(q.hint, q.id);
      const a = q as unknown as Record<string, unknown>;
      opts(a.options as Option[] | undefined, q.id);
      opts(a.rows as Option[] | undefined, q.id);
      opts(a.columns as Option[] | undefined, q.id);
      opts(a.extraOptions as Option[] | undefined, q.id);
      if (q.type === 'hotspot') note(q.image, q.id);
      if (q.type === 'conjoint') q.attributes.forEach((at) => opts(at.levels, q.id));
    }
  }
  return [...map.entries()].map(([url, where]) => ({ url, where: [...where] }));
}

export interface LibraryImage extends SurveyImage {
  /** Есть в библиотеке анкеты (а не только используется) */
  saved: boolean;
  where: string[];
}

/** Библиотека для выбора: сохранённые картинки и все используемые в анкете */
export function imageLibrary(def: Survey): LibraryImage[] {
  const used = new Map(usedImages(def).map((u) => [u.url, u.where]));
  const saved = (def.images ?? []).map((im) => ({ ...im, saved: true, where: used.get(im.url) ?? [] }));
  const known = new Set(saved.map((im) => im.url));
  const extra = [...used.entries()].filter(([url]) => !known.has(url))
    .map(([url, where]) => ({ url, name: '', saved: false, where }));
  return [...saved, ...extra];
}
