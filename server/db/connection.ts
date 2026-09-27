// Подключение к базе и помощники для репозиториев: диалекты SQL, ID, частичные обновления.
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { openSql, sqliteHandle, type Param } from '../sql.ts';
import { initSchema } from '../schema.ts';

export const sql = await openSql({ url: config.databaseUrl, sqliteFile: config.dbFile });
const pg = sql.kind === 'postgres';

await initSchema(sql);

/** SQLite: согласованная копия базы в файл (работает, пока сервис принимает ответы) */
export function backupTo(file: string): void {
  const db = sqliteHandle(sql);
  if (!db) throw new Error('Копия файлом — только для SQLite');
  db.prepare('VACUUM INTO ?').run(file);
}

// ---------- Диалект ----------

/** Значение из JSON-столбца по ключу: `${jsonGet('params')}` с параметром jsonKey('panel') */
export const jsonGet = (col: string) => (pg ? `(${col}::jsonb ->> ?)` : `json_extract(${col}, ?)`);
export const jsonKey = (key: string) => (pg ? key : `$."${key.replace(/"/g, '')}"`);
/** Сравнение, где NULL = NULL */
export const isSame = pg ? 'IS NOT DISTINCT FROM ?' : 'IS ?';
/** Поиск без учёта регистра */
export const LIKE = pg ? 'ILIKE' : 'LIKE';
/** Логины — без учёта регистра */
export const ci = (col: string) => `lower(${col}) = lower(?)`;
/** Условие → 0/1 (в PostgreSQL сравнения дают boolean) */
export const flag = (cond: string) => `CASE WHEN ${cond} THEN 1 ELSE 0 END`;

/** Список порциями — для IN (…) и многострочных INSERT */
export function chunks<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

// ---------- Значения ----------

export function newId(len = 10): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

export const now = () => new Date().toISOString();

export function median(list: number[]): number | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** JSON-столбец: разобрать или вернуть запасное значение (NULL в базе) */
export function parseJson<T>(v: unknown, fallback: T): T {
  return v ? (JSON.parse(v as string) as T) : fallback;
}

/** Кодировщики значений для частичного обновления */
export const enc = {
  json: (v: unknown): Param => JSON.stringify(v),
  /** null — NULL */
  nullableJson: (v: unknown): Param => (v ? JSON.stringify(v) : null),
  /** Пустой список или объект, null — NULL */
  jsonOrNull: (v: unknown): Param => (v === null || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v as object).length) ? null : JSON.stringify(v)),
  bool: (v: unknown): Param => (v ? 1 : 0),
};

type Column = string | readonly [column: string, encode: (v: unknown) => Param];

/**
 * UPDATE только заданных полей: patch — поля объекта, columns — их столбцы и кодировщики.
 * Поля со значением undefined пропускаются; `extra` — присваивания в начале (например, updated_at).
 */
export async function updateRow<P extends object>(
  table: string, where: string, key: Param, patch: P, columns: { [K in keyof P]-?: Column }, extra: [string, Param][] = [],
): Promise<void> {
  const sets = extra.map(([col]) => `${col} = ?`);
  const vals: Param[] = extra.map(([, v]) => v);
  for (const [field, col] of Object.entries(columns) as [keyof P, Column][]) {
    const v = patch[field];
    if (v === undefined) continue;
    const [name, encode] = typeof col === 'string' ? [col, (x: unknown) => x as Param] : col;
    sets.push(`${name} = ?`);
    vals.push(encode(v));
  }
  if (!sets.length) return;
  await sql.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, [...vals, key]);
}
