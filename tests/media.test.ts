import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { imageLibrary } from '../shared/images.ts';
import { validateSurvey } from '../shared/validate.ts';
import type { Survey } from '../shared/types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'surveylab-media-'));
process.env.ADMIN_PASSWORD = 'secret';
const { buildApp } = await import('../server/app.ts');
let app: FastifyInstance;
before(async () => { app = await buildApp(); });
after(() => app.close());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test('survey images: upload, public serving, roles', async () => {
  const login = async (l: string, p: string) => String((await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: l, password: p } })).headers['set-cookie']).split(';')[0];
  const cookie = await login('admin', 'secret');
  const up = (buf: Buffer, c = cookie) => app.inject({ method: 'POST', url: '/api/admin/media', payload: buf, headers: { cookie: c, 'content-type': 'application/octet-stream' } });

  const ok = await up(PNG);
  assert.equal(ok.statusCode, 200, ok.body);
  const { url } = ok.json() as { url: string };
  assert.match(url, /^\/media\/[a-z0-9]{16}\.png$/);
  assert.equal((await up(SVG)).statusCode, 415);
  assert.equal((await up(Buffer.from('not an image, just text here'))).statusCode, 415);

  // Картинку видят респонденты — без входа
  const img = await app.inject({ method: 'GET', url });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  // Выход из папки невозможен: адрес нормализуется, база не отдаётся
  const esc = await app.inject({ method: 'GET', url: '/media/../../surveylab.db' });
  assert.ok(!esc.body.startsWith('SQLite'));
  assert.equal((await app.inject({ method: 'GET', url: '/media/..%2F..%2Fsurveylab.db' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/media/aaaaaaaaaaaaaaaa.png' })).statusCode, 404);

  // Без входа и наблюдателю загружать нельзя
  assert.equal((await up(PNG, '')).statusCode, 401);
  await app.inject({ method: 'POST', url: '/api/admin/users', payload: { login: 'viewer1', password: 'password1', role: 'viewer' }, headers: { cookie } });
  assert.equal((await up(PNG, await login('viewer1', 'password1'))).statusCode, 403);
});

test('image library: saved images plus everything used in the survey', () => {
  const def: Survey = {
    formatVersion: 2, title: 't',
    settings: { logoUrl: '/media/logo000000000000.png' },
    images: [{ url: '/media/aaaaaaaaaaaaaaaa.png', name: 'Яндекс' }, { url: '/media/bbbbbbbbbbbbbbbb.png', name: 'Самокат' }],
    blocks: [{ id: 'B1', questions: [
      { id: 'Q1', type: 'single', text: 'Что это? ![](/media/cccccccccccccccc.png)', options: [{ code: 1, text: 'Я', image: '/media/aaaaaaaaaaaaaaaa.png' }] },
      { id: 'CJ', type: 'conjoint', text: 'c', attributes: [
        { id: 'S', text: 'Сервис', levels: [{ code: 1, text: 'Я', image: '/media/aaaaaaaaaaaaaaaa.png' }, { code: 2, text: 'С', image: '/media/bbbbbbbbbbbbbbbb.png' }] },
        { id: 'P', text: 'Цена', levels: [{ code: 1, text: '1' }, { code: 2, text: '2' }] },
      ] },
    ] }],
  };
  assert.ok(validateSurvey(def).ok, JSON.stringify(validateSurvey(def).errors));
  const lib = imageLibrary(def);
  assert.deepEqual(lib.map((i) => [i.name, i.saved, i.where.join(',')]), [
    ['Яндекс', true, 'Q1,CJ'], ['Самокат', true, 'CJ'], ['', false, 'логотип'], ['', false, 'Q1'],
  ]);
  assert.match(validateSurvey({ ...def, images: [{ url: 'javascript:alert(1)', name: 'x' }] }).errors[0].message, /url/);
});
