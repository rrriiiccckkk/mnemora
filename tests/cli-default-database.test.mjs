import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const run = (directory, environment) => spawnSync(process.execPath, [resolve("dist", "cli.js"), "stats"], {
  cwd: directory, encoding: "utf8", env: environment
});

test("CLI defaults to the canonical database and identifies a newly created database", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-cli-default-"));
  try {
    const home = join(directory, "home"), working = join(directory, "working");
    mkdirSync(home); mkdirSync(working);
    const environment = { ...process.env, HOME: home, USERPROFILE: home };
    delete environment.MNEMORA_DB;
    const result = run(working, environment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, ".openclaw", "mnemora.db")), true);
    assert.equal(existsSync(join(working, "mnemora.db")), false);
    assert.match(result.stderr, /initialized a new database at .*\.openclaw[\\/]mnemora\.db/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("CLI identifies an explicitly selected newly created database", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-cli-explicit-"));
  try {
    const working = join(directory, "working"), database = join(directory, "selected", "memory.db");
    mkdirSync(working);
    const result = run(working, { ...process.env, MNEMORA_DB: database });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(database), true);
    assert.equal(existsSync(join(working, "mnemora.db")), false);
    assert.match(result.stderr, /initialized a new database at .*selected[\\/]memory\.db/i);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the build normalizes directly invoked CLI permissions", () => {
  const result = spawnSync(process.execPath, [resolve("scripts", "ensure-cli-executable.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (process.platform !== "win32") assert.equal(statSync(resolve("dist", "cli.js")).mode & 0o111, 0o111);
});
