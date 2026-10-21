import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { DatabaseSyncOptions } from "@photostructure/sqlite";

/**
 * Mnemora deliberately supports one local SQLite writer. The timeout is
 * fixed and bounded: it gives a short-lived local operation a chance to
 * finish, but it is not a multi-writer coordination mechanism.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export const SQLITE_WAL_UNAVAILABLE = "sqlite_wal_unavailable" as const;

/** A safe, stable error for an unsupported or unavailable WAL environment. */
export class SqliteOperatingBoundaryError extends Error {
  readonly code = SQLITE_WAL_UNAVAILABLE;
  readonly journalMode: string;

  constructor(journalMode = "unknown") {
    const normalized = normalizeJournalMode(journalMode);
    super(`${SQLITE_WAL_UNAVAILABLE}:${normalized}`);
    this.name = "SqliteOperatingBoundaryError";
    this.journalMode = normalized;
  }
}

/**
 * Open a Mnemora SQLite connection with the fixed local operating policy.
 * Writable file databases must be WAL-backed; in-memory databases retain
 * SQLite's memory journal. Read-only inspection connections do not attempt to
 * change journal mode, but still receive the bounded busy timeout.
 */
export function openMnemoraDatabase(location: string, options: DatabaseSyncOptions = {}): DatabaseSyncInstance {
  const database = new DatabaseSync(location, { ...options, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    ensureWritableWal(database, location, options.readOnly === true);
    cacheStatements(database);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* best effort; never mask the boundary error */ }
    if (error instanceof SqliteOperatingBoundaryError) throw error;
    throw new SqliteOperatingBoundaryError();
  }
}

/** Statements kept per connection. Hot paths use a few hundred SQL strings. */
export const STATEMENT_CACHE_LIMIT = 512;

/**
 * Reuse prepared statements per connection, keyed by SQL text. The native
 * driver keeps several kilobytes per prepared statement until the process
 * exits, and Mnemora prepares on every call (about 14 statements per ingested
 * turn), so resident memory grew without bound: 6.8 GB after 100k turns for
 * a 271 MB database. Statements carry no per-call state here (no iterate(),
 * no per-statement option setters), so sharing them is safe. Least recently
 * used entries are evicted past the limit and disposed when the driver
 * supports it.
 */
function cacheStatements(database: DatabaseSyncInstance): void {
  const prepare = database.prepare.bind(database);
  const cache = new Map<string, ReturnType<DatabaseSyncInstance["prepare"]>>();
  Object.defineProperty(database, "prepare", {
    configurable: true,
    value: (sql: string) => {
      const cached = cache.get(sql);
      if (cached) { cache.delete(sql); cache.set(sql, cached); return cached; }
      const statement = prepare(sql);
      cache.set(sql, statement);
      if (cache.size > STATEMENT_CACHE_LIMIT) {
        const [oldest, evicted] = cache.entries().next().value!;
        cache.delete(oldest);
        (evicted as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
      }
      return statement;
    },
  });
}

/** Apply the writable file policy to an already-open connection. */
export function ensureWritableWal(database: DatabaseSyncInstance, location: string, readOnly = false): void {
  if (readOnly || isMemoryLocation(location)) return;
  try {
    const row = database.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: unknown } | undefined;
    const mode = normalizeJournalMode(row?.journal_mode);
    if (mode !== "wal") throw new SqliteOperatingBoundaryError(mode);
  } catch (error) {
    if (error instanceof SqliteOperatingBoundaryError) throw error;
    throw new SqliteOperatingBoundaryError();
  }
}

function isMemoryLocation(location: string): boolean {
  const value = location.trim().toLowerCase();
  return value === ":memory:" || value.startsWith("file::memory:");
}

function normalizeJournalMode(value: unknown): string {
  return typeof value === "string" && /^[a-z]+$/u.test(value.trim().toLowerCase())
    ? value.trim().toLowerCase()
    : "unknown";
}
