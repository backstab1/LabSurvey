// Шаблоны для «+ Новая анкета»: готовые типовые опросы, которые остаётся подправить.
import demo from '../../../examples/demo.json';
import type { Survey } from '../../../shared/types.ts';

export interface Template {
  id: string;
  title: string;
  description: string;
  survey: Survey | null;
}

const agree = [
  { code: 1, text: 'Совсем не согласен' }, { code: 2, text: 'Скорее не согласен' }, { code: 3, text: 'Нейтрально' },
  { code: 4, text: 'Скорее согласен' }, { code: 5, text: 'Полностью согласен' },
];

export const TEMPLATES: Template[] = [
  { id: 'blank', title: 'Пустая анкета', description: 'Один вопрос для начала', survey: null },
  {
    id: 'nps', title: 'NPS', description: 'Индекс лояльности: оценка 0–10 и вопрос «почему» с разными формулировками',
    survey: {
      formatVersion: 2, title: 'Оценка готовности рекомендовать',
      blocks: [{ id: 'B1', questions: [
        { id: 'NPS', type: 'scale', text: 'Насколько вероятно, что вы порекомендуете нас друзьям или коллегам?', from: 0, to: 10,
          labels: { 0: 'Точно не порекомендую', 10: 'Точно порекомендую' }, autoNext: true },
        { id: 'H_seg', type: 'hidden', text: 'Сегмент NPS (1 — критик, 2 — нейтрал, 3 — сторонник)', calc: 'if(NPS >= 9, 3, if(NPS >= 7, 2, 1))' },
        { id: 'WHY_BAD', type: 'text', text: 'Что нам стоит улучшить в первую очередь?', multiline: true, required: false,
          showIf: { q: 'H_seg', op: 'eq', value: 1 } },
        { id: 'WHY_MID', type: 'text', text: 'Чего не хватило до высшей оценки?', multiline: true, required: false,
          showIf: { q: 'H_seg', op: 'eq', value: 2 } },
        { id: 'WHY_GOOD', type: 'text', text: 'Что вам нравится больше всего?', multiline: true, required: false,
          showIf: { q: 'H_seg', op: 'eq', value: 3 } },
      ] }],
    },
  },
  {
    id: 'csat', title: 'Удовлетворённость (CSAT)', description: 'Общая оценка, оценка по параметрам и открытый вопрос',
    survey: {
      formatVersion: 2, title: 'Оценка качества обслуживания',
      blocks: [{ id: 'B1', questions: [
        { id: 'CSAT', type: 'scale', text: 'Насколько вы довольны обслуживанием в целом?', from: 1, to: 5, display: 'stars', autoNext: true },
        { id: 'ATTR', type: 'matrix', mode: 'single', text: 'Оцените, пожалуйста, по параметрам', requiredRows: 'none',
          rows: [{ code: 1, text: 'Скорость' }, { code: 2, text: 'Вежливость' }, { code: 3, text: 'Компетентность' }, { code: 4, text: 'Удобство' }],
          columns: [{ code: 1, text: 'Плохо' }, { code: 2, text: 'Удовлетворительно' }, { code: 3, text: 'Хорошо' }, { code: 4, text: 'Отлично' }] },
        { id: 'COMMENT', type: 'text', text: 'Что можно сделать лучше?', multiline: true, required: false },
      ] }],
    },
  },
  {
    id: 'enps', title: 'Вовлечённость сотрудников', description: 'eNPS, шкала согласия с утверждениями и индекс вовлечённости',
    survey: {
      formatVersion: 2, title: 'Опрос вовлечённости сотрудников',
      settings: { allowBack: true, showProgress: true, completeMessage: 'Спасибо! Опрос анонимный — ответы видны только в сводном виде.' },
      blocks: [
        { id: 'B_main', title: 'Работа в компании', questions: [
          { id: 'ENPS', type: 'scale', text: 'Насколько вероятно, что вы порекомендуете компанию как место работы?', from: 0, to: 10,
            labels: { 0: 'Точно нет', 10: 'Точно да' } },
          { id: 'ENG', type: 'matrix', mode: 'single', text: 'Насколько вы согласны с утверждениями?', rowOrder: 'random',
            rows: [
              { code: 1, text: 'Я понимаю, чего от меня ждут на работе' }, { code: 2, text: 'У меня есть всё необходимое для работы' },
              { code: 3, text: 'Руководитель поддерживает моё развитие' }, { code: 4, text: 'Я горжусь тем, что работаю здесь' },
              { code: 5, text: 'Я вижу себя в компании через год' },
            ],
            columns: agree.map((c) => ({ ...c, score: c.code })) },
          { id: 'H_eng', type: 'hidden', text: 'Индекс вовлечённости (1–5)', calc: 'round(score(ENG) / count(ENG), 2)' },
          { id: 'IMPROVE', type: 'text', text: 'Что одно изменение сделало бы вашу работу лучше?', multiline: true, required: false },
        ] },
        { id: 'B_about', title: 'О вас', questions: [
          { id: 'TENURE', type: 'single', text: 'Сколько вы работаете в компании?', options: [
            { code: 1, text: 'Меньше года' }, { code: 2, text: '1–3 года' }, { code: 3, text: '3–5 лет' }, { code: 4, text: 'Больше 5 лет' },
            { code: 99, text: 'Не хочу отвечать' },
          ] },
        ] },
      ],
    },
  },
  {
    id: 'event', title: 'Оценка мероприятия', description: 'Оценка звёздами, что понравилось, придёт ли снова',
    survey: {
      formatVersion: 2, title: 'Как вам мероприятие?',
      blocks: [{ id: 'B1', questions: [
        { id: 'RATE', type: 'scale', text: 'Оцените мероприятие в целом', from: 1, to: 5, display: 'stars', autoNext: true },
        { id: 'LIKED', type: 'multi', text: 'Что понравилось?', order: 'random', options: [
          { code: 1, text: 'Спикеры' }, { code: 2, text: 'Темы' }, { code: 3, text: 'Организация' }, { code: 4, text: 'Нетворкинг' },
          { code: 5, text: 'Площадка' }, { code: 97, text: 'Другое', other: true }, { code: 99, text: 'Ничего', exclusive: true },
        ] },
        { id: 'AGAIN', type: 'single', text: 'Придёте ли вы в следующий раз?', autoNext: true, options: [
          { code: 1, text: 'Да' }, { code: 2, text: 'Возможно' }, { code: 3, text: 'Нет' },
        ] },
        { id: 'EMAIL', type: 'text', inputType: 'email', text: 'Оставьте e-mail, если хотите получить материалы', required: false },
      ] }],
    },
  },
  { id: 'demo', title: 'Демо: все возможности', description: 'Все типы вопросов, условия, действия, перенос и подстановки', survey: demo as Survey },
];
