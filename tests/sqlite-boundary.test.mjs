import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_WAL_UNAVAILABLE,
  SqliteOperatingBoundaryError,
  ensureWritableWal,
  openMnemoraDatabase
} from "../dist/sqlite.js";

test("writable file databases use WAL and the fixed bounded busy timeout", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-sqlite-boundary-"));
  const path = join(directory, "graph.sqlite");
  const database = openMnemoraDatabase(path, { timeout: 1 });
  try {
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(Number(database.prepare("PRAGMA busy_timeout").get().timeout), SQLITE_BUSY_TIMEOUT_MS);
  } finally {
    database.close();
    cleanup(directory);
  }
});

test("in-memory databases retain the bounded timeout without requiring WAL", () => {
  const database = openMnemoraDatabase(":memory:", { timeout: 1 });
  try {
    assert.notEqual(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(Number(database.prepare("PRAGMA busy_timeout").get().timeout), SQLITE_BUSY_TIMEOUT_MS);
  } finally {
    database.close();
  }
});

test("a second local writer times out without a partial commit and succeeds after the lease is released", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-sqlite-contention-"));
  const path = join(directory, "graph.sqlite");
  const first = openMnemoraDatabase(path), second = openMnemoraDatabase(path);
  try {
    first.exec("CREATE TABLE contention_probe(value TEXT NOT NULL); BEGIN IMMEDIATE; INSERT INTO contention_probe(value) VALUES('first')");
    const started = performance.now();
    assert.throws(() => second.prepare("INSERT INTO contention_probe(value) VALUES('second')").run(), /SQLITE_BUSY|database is locked/i);
    assert.equal(performance.now() - started < SQLITE_BUSY_TIMEOUT_MS + 2_000, true);
    assert.equal(first.prepare("SELECT COUNT(*) AS value FROM contention_probe").get().value, 1);
    first.exec("COMMIT");
    second.prepare("INSERT INTO contention_probe(value) VALUES('second')").run();
    assert.equal(second.prepare("SELECT COUNT(*) AS value FROM contention_probe").get().value, 2);
  } finally {
    try { first.exec("ROLLBACK"); } catch { /* already committed */ }
    second.close(); first.close(); cleanup(directory);
  }
});

test("WAL failure is fail-closed with a stable, non-sensitive diagnostic", () => {
  const configuredPath = "C:\\private\\mnemora\\graph.sqlite";
  const database = {
    prepare(sql) {
      assert.equal(sql, "PRAGMA journal_mode=WAL");
      return { get: () => ({ journal_mode: "delete" }) };
    }
  };
  assert.throws(
    () => ensureWritableWal(database, configuredPath),
    (error) => {
      assert.ok(error instanceof SqliteOperatingBoundaryError);
      assert.equal(error.code, SQLITE_WAL_UNAVAILABLE);
      assert.equal(error.journalMode, "delete");
      assert.doesNotMatch(error.message, /private|mnemora|graph\.sqlite/i);
      return true;
    }
  );
});

test("native WAL failures never expose provider or filesystem error details", () => {
  const configuredPath = "C:\\private\\mnemora\\graph.sqlite";
  const database = {
    prepare() {
      throw new Error(`SQLITE_BUSY: ${configuredPath}`);
    }
  };
  assert.throws(
    () => ensureWritableWal(database, configuredPath),
    (error) => {
      assert.equal(error.code, SQLITE_WAL_UNAVAILABLE);
      assert.equal(error.journalMode, "unknown");
      assert.equal(error.message, `${SQLITE_WAL_UNAVAILABLE}:unknown`);
      return true;
    }
  );
});

function cleanup(directory) {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }
  catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; }
}
