// Выгрузка всех таблиц в JSON и загрузка обратно — переносит данные между SQLite и PostgreSQL
// и служит резервной копией, когда база — PostgreSQL (файл .json.gz).
import { createWriteStream, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip, gunzipSync } from 'node:zlib';
import { IDENTITY_TABLES, TABLES } from './schema.ts';
import type { Param, Queryable, Row, Sql } from './sql.ts';

export interface Dump {
  format: 'surveylab-dump';
  version: 1;
  createdAt: string;
  tables: Record<string, Row[]>;
}

export async function dumpAll(q: Queryable): Promise<Dump> {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES) tables[t] = await q.all(`SELECT * FROM ${t}`);
  return { format: 'surveylab-dump', version: 1, createdAt: new Date().toISOString(), tables };
}

/** Сколько строк в каждой таблице */
export async function tableCounts(q: Queryable): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await q.get(`SELECT COUNT(*) AS n FROM ${t}`))!.n as number;
  return out;
}

/**
 * Загрузить выгрузку в пустую базу (схема уже создана) одной транзакцией.
 * Столбцы, которых нет в базе-приёмнике, пропускаются; счётчики id в PostgreSQL сдвигаются за последний id.
 */
export async function loadAll(sql: Sql, dump: Dump): Promise<Record<string, number>> {
  if (dump.format !== 'surveylab-dump') throw new Error('Это не выгрузка SurveyLAB');
  const counts = await tableCounts(sql);
  const busy = Object.entries(counts).filter(([, n]) => n > 0).map(([t]) => t);
  if (busy.length) throw new Error(`База-приёмник не пустая (${busy.join(', ')}). Загружать можно только в пустую базу.`);
  const targetCols: Record<string, Set<string>> = {};
  for (const t of TABLES) {
    const rows = sql.kind === 'postgres'
      ? await sql.all("SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()", [t])
      : await sql.all(`SELECT name FROM pragma_table_info('${t}')`);
    targetCols[t] = new Set(rows.map((r) => r.name as string));
  }
  await sql.tx(async (q) => {
    for (const t of TABLES) {
      const rows = dump.tables[t] ?? [];
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]).filter((c) => targetCols[t].has(c));
      // Порции по ~500 значений: у SQLite есть предел числа параметров в запросе
      const per = Math.max(1, Math.floor(500 / cols.length));
      for (let i = 0; i < rows.length; i += per) {
        const part = rows.slice(i, i + per);
        await q.run(
          `INSERT INTO ${t} (${cols.join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
          part.flatMap((r) => cols.map((c) => (r[c] ?? null) as Param)),
        );
      }
    }
    if (q.kind === 'postgres') {
      for (const t of IDENTITY_TABLES) {
        await q.get(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
      }
    }
  });
  return tableCounts(sql);
}

export async function writeDumpFile(dump: Dump, file: string): Promise<void> {
  // Построчно: большие базы не собираются в одну строку в памяти
  async function* chunks() {
    yield `{"format":"surveylab-dump","version":1,"createdAt":${JSON.stringify(dump.createdAt)},"tables":{`;
    let first = true;
    for (const [t, rows] of Object.entries(dump.tables)) {
      yield `${first ? '' : ','}${JSON.stringify(t)}:[`;
      first = false;
      for (let i = 0; i < rows.length; i++) yield (i ? ',' : '') + JSON.stringify(rows[i]);
      yield ']';
    }
    yield '}}';
  }
  await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(file));
}

export function readDumpFile(file: string): Dump {
  const raw = readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  return JSON.parse(text) as Dump;
}

