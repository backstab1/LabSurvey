// Доступ к базе: один асинхронный интерфейс для SQLite (по умолчанию), PostgreSQL (DATABASE_URL=postgres://…)
// и PGlite (DATABASE_URL=pglite:… — PostgreSQL внутри процесса, для тестов). Запросы пишутся с плейсхолдерами `?`,
// для PostgreSQL они переводятся в $1, $2…; различия диалектов — в полях `dialect`.
import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;
export type Param = string | number | null;
export type Kind = 'sqlite' | 'postgres';

export interface Queryable {
  readonly kind: Kind;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  /** Изменения; changes — сколько строк затронуто */
  run(sql: string, params?: Param[]): Promise<{ changes: number }>;
}

export interface Sql extends Queryable {
  /** Несколько команд без параметров (схема) */
  exec(sql: string): Promise<void>;
  /** Транзакция: все запросы внутри — через q; ошибка откатывает всё */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` → `$1, $2…` (вне строк в кавычках) */
export function toPgPlaceholders(sql: string): string {
  let n = 0;
  let out = '';
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

// ---------- SQLite ----------

class SqliteSql implements Sql {
  readonly kind = 'sqlite' as const;
  private txActive = false;
  private txDone: Promise<void> = Promise.resolve();
  constructor(readonly db: DatabaseSync) {}

  /** Запросы вне транзакции ждут её конца: соединение одно, иначе они попали бы внутрь чужой транзакции */
  private async idle() { while (this.txActive) await this.txDone; }

  private direct(): Queryable {
    const db = this.db;
    return {
      kind: 'sqlite',
      all: async <T>(sql: string, p: Param[] = []) => db.prepare(sql).all(...p) as T[],
      get: async <T>(sql: string, p: Param[] = []) => db.prepare(sql).get(...p) as T | undefined,
      run: async (sql: string, p: Param[] = []) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
    };
  }

  async all<T = Row>(sql: string, p: Param[] = []) { await this.idle(); return this.db.prepare(sql).all(...p) as T[]; }
  async get<T = Row>(sql: string, p: Param[] = []) { await this.idle(); return this.db.prepare(sql).get(...p) as T | undefined; }
  async run(sql: string, p: Param[] = []) { await this.idle(); return { changes: Number(this.db.prepare(sql).run(...p).changes) }; }
  async exec(sql: string) { await this.idle(); this.db.exec(sql); }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    await this.idle();
    this.txActive = true;
    let release!: () => void;
    this.txDone = new Promise((r) => { release = r; });
    this.db.exec('BEGIN');
    try {
      const out = await fn(this.direct());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.txActive = false;
      release();
    }
  }

  async close() { this.db.close(); }
}

// ---------- PostgreSQL (pg) ----------

interface PgLike { query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }

function pgQueryable(c: PgLike): Queryable {
  return {
    kind: 'postgres',
    all: async <T>(sql: string, p: Param[] = []) => (await c.query(toPgPlaceholders(sql), p)).rows as T[],
    get: async <T>(sql: string, p: Param[] = []) => (await c.query(toPgPlaceholders(sql), p)).rows[0] as T | undefined,
    run: async (sql: string, p: Param[] = []) => ({ changes: (await c.query(toPgPlaceholders(sql), p)).rowCount ?? 0 }),
  };
}

async function openPg(url: string): Promise<Sql> {
  const pg = (await import('pg')).default;
  // COUNT(*) и BIGINT приходят строками — в числа (значения в SurveyLAB небольшие)
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL ?? 10) });
  await pool.query('SELECT 1');
  const q = pgQueryable(pool as unknown as PgLike);
  return {
    ...q,
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(pgQueryable(client as unknown as PgLike));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

// ---------- PGlite (PostgreSQL в процессе — тесты) ----------

async function openPglite(path: string): Promise<Sql> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(path || undefined);
  await db.waitReady;
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): Queryable => ({
    kind: 'postgres',
    all: async <T>(sql: string, p: Param[] = []) => (await c.query(toPgPlaceholders(sql), p)).rows as T[],
    get: async <T>(sql: string, p: Param[] = []) => (await c.query(toPgPlaceholders(sql), p)).rows[0] as T | undefined,
    run: async (sql: string, p: Param[] = []) => ({ changes: (await c.query(toPgPlaceholders(sql), p)).affectedRows ?? 0 }),
  });
  return {
    ...wrap(db),
    async exec(sql) { await db.exec(sql); },
    tx: (fn) => db.transaction((t) => fn(wrap(t))),
    async close() { await db.close(); },
  };
}

/** Какая база: DATABASE_URL (postgres://…, pglite:путь) или файл SQLite */
export async function openSql(opts: { url?: string; sqliteFile: string }): Promise<Sql> {
  const url = opts.url?.trim();
  if (url && /^postgres(ql)?:\/\//i.test(url)) return openPg(url);
  if (url && /^pglite:/i.test(url)) return openPglite(url.slice('pglite:'.length).replace(/^\/\//, ''));
  if (url) throw new Error(`DATABASE_URL: ожидается postgres://… (или пусто – SQLite), получено «${url.slice(0, 20)}…»`);
  return new SqliteSql(new DatabaseSync(opts.sqliteFile));
}

/** Файл SQLite напрямую (перенос данных, старые миграции) */
export function sqliteHandle(sql: Sql): DatabaseSync | null {
  return sql instanceof SqliteSql ? sql.db : null;
}
