// Перенос данных между базами SurveyLAB:
//   npm run db:copy -- --from data/surveylab.db --to postgres://user:pass@localhost:5432/surveylab   (переезд на PostgreSQL)
//   npm run db:copy -- --from data/backups/surveylab-2026-10-01_03-00.json.gz --to postgres://…     (восстановление копии)
//   npm run db:copy -- --from postgres://… --to data/export.json.gz                               (выгрузка в файл)
// Источник: файл SQLite (.db), выгрузка (.json.gz) или postgres://…; приёмник: postgres://…, новый файл .db или .json.gz.
// Приёмник должен быть пустым. Сервис на время переноса лучше остановить, чтобы не потерять новые ответы.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSql, type Sql } from '../sql.ts';
import { initSchema, TABLES } from '../schema.ts';
import { dumpAll, loadAll, readDumpFile, writeDumpFile, type Dump } from '../dump.ts';

const isPg = (s: string) => /^(postgres(ql)?:\/\/|pglite:)/i.test(s);
const isDumpFile = (s: string) => /\.json(\.gz)?$/i.test(s);
const hide = (s: string) => s.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');

async function open(target: string, mustExist: boolean): Promise<Sql> {
  if (isPg(target)) return openSql({ url: target, sqliteFile: '' });
  const file = resolve(target);
  if (mustExist && !existsSync(file)) throw new Error(`Нет файла ${file}`);
  if (!mustExist && existsSync(file)) throw new Error(`Файл ${file} уже есть — укажите новый`);
  return openSql({ sqliteFile: file });
}

export async function copyDatabase(from: string, to: string, log: (s: string) => void = console.log): Promise<Record<string, number>> {
  let dump: Dump;
  if (isDumpFile(from)) {
    log(`Чтение выгрузки ${from}…`);
    dump = readDumpFile(resolve(from));
  } else {
    const src = await open(from, true);
    // Старая база SQLite доводится до текущей схемы, как при запуске сервиса
    await initSchema(src);
    log(`Чтение ${hide(from)}…`);
    dump = await dumpAll(src);
    await src.close();
  }
  const total = Object.values(dump.tables).reduce((n, rows) => n + rows.length, 0);
  log(`Строк: ${total} (${TABLES.map((t) => `${t} ${dump.tables[t]?.length ?? 0}`).join(', ')})`);

  if (isDumpFile(to)) {
    if (existsSync(resolve(to))) throw new Error(`Файл ${to} уже есть — укажите новый`);
    await writeDumpFile(dump, resolve(to));
    log(`Записано в ${to}`);
    return Object.fromEntries(TABLES.map((t) => [t, dump.tables[t]?.length ?? 0]));
  }
  const dst = await open(to, false);
  try {
    await initSchema(dst);
    log(`Запись в ${hide(to)}…`);
    const counts = await loadAll(dst, dump);
    // Проверка: в приёмнике столько же строк, сколько в источнике
    const diff = TABLES.filter((t) => counts[t] !== (dump.tables[t]?.length ?? 0));
    if (diff.length) throw new Error(`Не совпало число строк: ${diff.join(', ')}`);
    log('Готово, число строк совпадает во всех таблицах.');
    return counts;
  } finally {
    await dst.close();
  }
}

// Запуск из командной строки
if (process.argv[1] && /db-copy\.ts$/.test(process.argv[1])) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) {
    console.error('Использование: npm run db:copy -- --from <источник> --to <приёмник>\n'
      + '  источник: data/surveylab.db | копия.json.gz | postgres://…\n  приёмник: postgres://… | новый.db | новый.json.gz');
    process.exit(2);
  }
  try {
    await copyDatabase(from, to);
  } catch (e) {
    console.error(`Ошибка: ${(e as Error).message}`);
    process.exit(1);
  }
}

