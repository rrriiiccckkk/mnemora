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
    return database;
  } catch (error) {
    try { database.close(); } catch { /* best effort; never mask the boundary error */ }
    if (error instanceof SqliteOperatingBoundaryError) throw error;
    throw new SqliteOperatingBoundaryError();
  }
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
