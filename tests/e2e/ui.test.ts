// Сквозные тесты интерфейса в настоящем браузере (установленный Edge или Chrome через playwright-core).
// Запуск: npm run test:e2e (сначала собирается фронтенд). Если браузера нет — тесты пропускаются.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { FastifyInstance } from 'fastify';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-e2e-'));
process.env.ADMIN_PASSWORD = 'e2e-secret';
process.env.BACKUP_HOURS = '0';
const { buildApp } = await import('../../server/app.ts');
const { TEMPLATES } = await import('../../web/src/admin/templates.ts');

let app: FastifyInstance;
let base = '';
let browser: Browser | null = null;

before(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  for (const channel of ['msedge', 'chrome'] as const) {
    try { browser = await chromium.launch({ channel, headless: true }); break; } catch { /* следующий браузер */ }
  }
});
after(async () => { await browser?.close(); await app.close(); });

/** Браузер запускается в before — поэтому проверяем его внутри теста */
function needBrowser(t: { skip: (msg: string) => void }): boolean {
  if (browser) return true;
  t.skip('Нет Edge или Chrome — пропускаем тесты интерфейса');
  return false;
}

async function adminContext(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(`${base}/admin`);
  await page.getByLabel('Логин').fill('admin');
  await page.getByLabel('Пароль').fill('e2e-secret');
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByRole('heading', { name: 'Анкеты' }).waitFor();
  return { ctx, page };
}

const phone = () => browser!.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'ru-RU' });

/** Создать и опубликовать анкету через API от имени вошедшего админа */
async function publishVia(ctx: BrowserContext, definition: unknown): Promise<string> {
  const created = await (await ctx.request.post(`${base}/api/admin/surveys`, { data: { definition } })).json();
  await ctx.request.post(`${base}/api/admin/surveys/${created.id}/publish`);
  return created.id;
}

test('admin creates a survey from a template, respondent completes it on a phone, results show up', async (t) => {
  if (!needBrowser(t)) return;
  const { ctx, page } = await adminContext();
  await page.getByRole('button', { name: '+ Новая анкета' }).click();
  await page.locator('.template-card').filter({ has: page.locator('strong', { hasText: /^NPS$/ }) }).click();
  await page.waitForURL(/\/admin\/s\/\w+/);
  const id = page.url().match(/\/admin\/s\/(\w+)/)![1];
  await page.getByRole('button', { name: 'Опубликовать' }).click();
  await page.locator('.toast', { hasText: 'Опубликовано' }).waitFor();

  const mobile = await phone();
  const r = await mobile.newPage();
  await r.goto(`${base}/s/${id}`);
  await r.getByText('Насколько вероятно, что вы порекомендуете нас').waitFor();
  await r.locator('.scale-point', { hasText: /^9$/ }).click();
  // Автопереход → сторонник видит свой вопрос
  await r.getByText('Что вам нравится больше всего?').waitFor();
  await r.locator('textarea').fill('Быстро и вкусно');
  await r.getByRole('button', { name: 'Отправить' }).click();
  await r.getByText('Спасибо! Ваши ответы сохранены.').waitFor();
  await mobile.close();

  await page.getByRole('button', { name: 'Данные' }).click();
  await page.locator('.stats .card', { hasText: 'Завершили' }).locator('.stat', { hasText: '1' }).waitFor();
  await page.getByRole('button', { name: 'Отчёт' }).click();
  await page.getByText('NPS +100').waitFor();
  await ctx.close();
});

test('builder: add a question, type options with the keyboard, see it in JSON, undo', async (t) => {
  if (!needBrowser(t)) return;
  const { ctx, page } = await adminContext();
  await page.getByRole('button', { name: '+ Новая анкета' }).click();
  await page.locator('.template-card', { hasText: 'Пустая анкета' }).click();
  await page.waitForURL(/\/admin\/s\/\w+/);

  await page.getByRole('button', { name: '+ Добавить вопрос' }).click();
  await page.locator('.type-picker button', { hasText: 'Несколько ответов' }).click();
  const dialog = page.locator('.qdialog');
  await dialog.getByPlaceholder(/Введите вопрос/).fill('Какие соцсети вы используете?');
  const first = dialog.locator('.opt-text').first();
  await first.fill('Телеграм');
  await first.press('Enter');
  await page.keyboard.type('ВКонтакте');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Одноклассники');
  await page.getByRole('button', { name: 'Готово' }).click();
  await page.locator('.save-state', { hasText: 'Черновик сохранён' }).waitFor();

  await page.getByRole('button', { name: 'JSON' }).click();
  const json = JSON.parse(await page.locator('.json-editor').inputValue());
  const q = json.blocks[0].questions.at(-1);
  assert.equal(q.type, 'multi');
  assert.deepEqual(q.options.map((o: { text: string }) => o.text), ['Телеграм', 'ВКонтакте', 'Одноклассники']);
  assert.deepEqual(q.options.map((o: { code: number }) => o.code), [1, 2, 3]);

  // Отмена возвращает анкету к состоянию до правок (кнопка ↶)
  await page.getByRole('button', { name: 'Конструктор' }).click();
  const undo = page.getByTitle('Отменить (Ctrl+Z)');
  while (await undo.isEnabled()) await undo.click();
  await page.getByRole('button', { name: 'JSON' }).click();
  const back = JSON.parse(await page.locator('.json-editor').inputValue());
  assert.equal(back.blocks[0].questions.length, 1);
  await ctx.close();
});

test('respondent walks a nested loop on a phone without horizontal scrolling', async (t) => {
  if (!needBrowser(t)) return;
  const { ctx } = await adminContext();
  const id = await publishVia(ctx, TEMPLATES.find((t) => t.id === 'loops')!.survey);
  const mobile = await phone();
  const r = await mobile.newPage();
  await r.goto(`${base}/s/${id}`);
  const noHorizontalScroll = async () => {
    const [sw, cw] = await r.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw + 1, `горизонтальная прокрутка: ${sw} > ${cw}`);
  };

  await r.locator('.option', { hasText: 'Чай' }).click();
  await r.locator('.option', { hasText: 'Вода' }).click();
  await noHorizontalScroll();
  await r.getByRole('button', { name: 'Далее' }).click();

  for (const cat of ['Чай', 'Вода']) {
    await r.getByText(`Как часто вы покупаете ${cat}?`).waitFor();
    await r.locator('.page-title', { hasText: `Категория: ${cat}` }).waitFor();
    await r.locator('.option', { hasText: /^\s*Раз в неделю\s*$/ }).click(); // автопереход
    await r.getByText(`Какие марки (${cat}) вы покупали?`).waitFor();
    await r.locator('.option', { hasText: 'Марка Б' }).click();
    await noHorizontalScroll();
    await r.getByRole('button', { name: 'Далее' }).click();
    await r.getByText(`Насколько вы довольны маркой «Марка Б» (${cat})?`).waitFor();
    await r.locator('.scale-point').nth(4).click(); // звёзды, автопереход
  }
  await r.getByText('Что ещё хотите добавить?').waitFor();
  await r.getByRole('button', { name: 'Отправить' }).click();
  await r.getByText('Спасибо! Ваши ответы сохранены.').waitFor();
  await mobile.close();

  // Ответы повторов лежат под ID копий
  const list = await (await ctx.request.get(`${base}/api/admin/surveys/${id}/responses`)).json();
  const one = await (await ctx.request.get(`${base}/api/admin/surveys/${id}/responses/${list[0].id}`)).json();
  assert.equal(one.response.answers.SAT_2_2.v, 5);
  assert.equal(one.response.answers.SAT_4_2.v, 5);
  assert.equal(one.response.answers.FREQ_4.v, 2);
  await ctx.close();
});

test('password-protected survey', async (t) => {
  if (!needBrowser(t)) return;
  const { ctx } = await adminContext();
  const id = await publishVia(ctx, {
    formatVersion: 2, title: 'Закрытый опрос', settings: { password: 'kod123' },
    blocks: [{ id: 'B1', questions: [{ id: 'Q1', type: 'text', text: 'Как дела?' }] }],
  });
  const r = await (await phone()).newPage();
  await r.goto(`${base}/s/${id}`);
  await r.getByText('Опрос защищён паролем').waitFor();
  await r.getByLabel('Пароль').fill('nope');
  await r.getByRole('button', { name: 'Начать' }).click();
  await r.getByText('Неверный пароль').waitFor();
  await r.getByLabel('Пароль').fill('kod123');
  await r.getByRole('button', { name: 'Начать' }).click();
  await r.getByText('Как дела?').waitFor();
  await ctx.close();
});
