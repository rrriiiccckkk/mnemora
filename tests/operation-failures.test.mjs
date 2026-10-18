import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTempDir } from "./helpers/temp.mjs";
import { MnemoraContextEngine } from "../dist/context-engine/engine.js";
import { normalizeConfig } from "../dist/config.js";
import { Mnemora } from "../dist/tools.js";
import { OperationFailureReporter, failureCategory, operationFailureSummary, recordOperationFailure } from "../dist/operations/failure-ledger.js";

const SECRET = "user-secret-7f3a do not persist";
function setup({ lifecycle = {}, graphOverride } = {}) {
  const dbPath = join(createTempDir("operation-failures-"), "m.db");
  const config = normalizeConfig({ dbPath, mode: "standalone", conversationJournal: { enabled: true }, contextEngine: { enabled: true }, unifiedRetrieval: { enabled: true, shadowMode: false } });
  const logs = [];
  const failures = new OperationFailureReporter({ warn: (message, fields) => logs.push({ message, fields }) });
  const graph = new Mnemora({ config, failures });
  const shared = new Proxy(graph, { get: (target, property) => property === "close" ? () => undefined : graphOverride?.(property) ?? Reflect.get(target, property, target) });
  const engine = new MnemoraContextEngine(config, () => shared, undefined, { failures, ...lifecycle });
  return { dbPath, graph, engine, failures, logs, close: () => graph.close() };
}
const rows = db => db.prepare("SELECT operation, category, count FROM mnemora_operation_failures ORDER BY operation").all().map(row => ({ ...row }));

test("failure categories come from error name and code, never the message", () => {
  assert.equal(failureCategory(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(failureCategory(Object.assign(new Error("x"), { name: "AbortError" })), "aborted");
  assert.equal(failureCategory(Object.assign(new Error("x"), { code: "SQLITE_BUSY" })), "busy");
  assert.equal(failureCategory(Object.assign(new Error("x"), { code: "SQLITE_CORRUPT" })), "corrupt");
  assert.equal(failureCategory(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "network");
  assert.equal(failureCategory(new SyntaxError("x")), "invalid_response");
  assert.equal(failureCategory(new Error("timeout while busy: SQLITE_CORRUPT")), "error");
  assert.equal(failureCategory(new Error("wrapped", { cause: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) })), "timeout");
  assert.equal(failureCategory(undefined), "error");
});

test("the reporter rate-limits log lines, counts every failure and persists without message text", () => {
  const { graph, close } = setup();
  try {
    let now = 1_000_000;
    const logs = [];
    const reporter = new OperationFailureReporter({ warn: (message, fields) => logs.push(fields), now: () => now, logIntervalMs: 60_000 });
    for (let index = 0; index < 5; index++) reporter.report("journal_embed", Object.assign(new Error(SECRET), { name: "TimeoutError" }), graph.store.db);
    assert.deepEqual(logs, [{ operation: "journal_embed", category: "timeout" }]);
    now += 61_000;
    reporter.report("journal_embed", Object.assign(new Error(SECRET), { name: "TimeoutError" }), graph.store.db);
    assert.deepEqual(logs[1], { operation: "journal_embed", category: "timeout", suppressed: 4 });
    assert.deepEqual(reporter.snapshot(), [{ operation: "journal_embed", category: "timeout", count: 6 }]);
    assert.deepEqual(rows(graph.store.db), [{ operation: "journal_embed", category: "timeout", count: 6 }]);
    const dump = JSON.stringify(graph.store.db.prepare("SELECT * FROM mnemora_operation_failures").all());
    assert.doesNotMatch(dump, /secret/u);
  } finally { close(); }
});

test("recording never throws: closed database, unknown operation, invalid category", () => {
  const { graph } = setup();
  const db = graph.store.db;
  graph.close();
  assert.equal(recordOperationFailure(db, { operation: "capture", category: "error" }), false);
  assert.equal(recordOperationFailure(undefined, { operation: "capture", category: "error" }), false);
  const reporter = new OperationFailureReporter({ warn: () => { throw new Error("logger down"); } });
  assert.doesNotThrow(() => reporter.report("capture", new Error("x"), db));
  assert.deepEqual(reporter.snapshot(), [{ operation: "capture", category: "error", count: 1 }]);
  const { graph: other, close } = setup();
  try {
    assert.equal(recordOperationFailure(other.store.db, { operation: "not_an_operation", category: "error" }), false);
    assert.equal(recordOperationFailure(other.store.db, { operation: "capture", category: "bogus" }), false);
    assert.deepEqual(rows(other.store.db), []);
  } finally { close(); }
});

test("the ledger keeps 30 days and the summary covers the requested window", () => {
  const { graph, close } = setup();
  try {
    const day = 86_400_000, now = 400 * day;
    graph.store.db.prepare("INSERT INTO mnemora_operation_failures(day,operation,category,count,first_at,last_at) VALUES(?,?,?,?,?,?)").run(400 - 45, "capture", "error", 9, 0, 0);
    graph.store.db.prepare("INSERT INTO mnemora_operation_failures(day,operation,category,count,first_at,last_at) VALUES(?,?,?,?,?,?)").run(400 - 10, "compaction", "busy", 2, 0, 0);
    recordOperationFailure(graph.store.db, { operation: "recall_assemble", category: "error" }, now);
    assert.deepEqual(rows(graph.store.db).map(row => row.operation), ["compaction", "recall_assemble"]);
    assert.equal(operationFailureSummary(graph.store.db, 7, now).total, 1);
    assert.equal(operationFailureSummary(graph.store.db, 30, now).total, 3);
  } finally { close(); }
});

test("a failing completed-turn lifecycle is counted while the host turn still succeeds", async () => {
  const { graph, engine, logs, close } = setup({ lifecycle: { onCompletedTurn: () => { throw Object.assign(new Error(SECRET), { code: "SQLITE_BUSY" }); } } });
  try {
    for (let index = 0; index < 3; index++) await engine.afterTurn({ sessionId: "s", messages: [{ role: "user", content: `turn ${index}` }, { role: "assistant", content: "ok" }], prePromptMessageCount: 0 });
    assert.deepEqual(rows(graph.store.db), [{ operation: "turn_lifecycle", category: "busy", count: 3 }]);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /secret/u);
  } finally { close(); }
});

test("a recall failure keeps host messages and is counted as recall_assemble", async () => {
  const { graph, engine, close } = setup({ graphOverride: property => property === "memoryLifecycle" ? (() => { throw new Error(SECRET); })() : undefined });
  try {
    await engine.ingestBatch({ sessionId: "a", messages: [{ role: "user", content: "I keep my bike in the garage." }] });
    const messages = [{ role: "user", content: "Where is my bike?" }];
    const result = await engine.assemble({ sessionId: "b", prompt: "Where is my bike?", messages, tokenBudget: 4000 });
    assert.equal(result.messages.at(-1).content, "Where is my bike?");
    assert.equal(result.systemPromptAddition ?? "", "");
    assert.deepEqual(rows(graph.store.db), [{ operation: "recall_assemble", category: "error", count: 1 }]);
  } finally { close(); }
});

test("a broken journal index is counted as journal_search instead of silently returning nothing", async () => {
  const { graph, engine, close } = setup();
  try {
    await engine.ingestBatch({ sessionId: "a", messages: [{ role: "user", content: "I keep my bike in the garage." }] });
    graph.store.db.exec("DROP TABLE mnemora_conversation_event_chunks_fts");
    await engine.assemble({ sessionId: "b", prompt: "Where is my bike?", messages: [{ role: "user", content: "Where is my bike?" }], tokenBudget: 4000 });
    assert.ok(rows(graph.store.db).some(row => row.operation === "journal_search" && row.count >= 1));
  } finally { close(); }
});

test("health CLI reports failures read-only and validates its arguments", () => {
  const { dbPath, graph, close } = setup();
  recordOperationFailure(graph.store.db, { operation: "compaction", category: "busy" });
  close();
  const run = (...args) => spawnSync(process.execPath, ["dist/cli.js", "health", ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, MNEMORA_DB: dbPath } });
  const ok = JSON.parse(run().stdout);
  assert.equal(ok.result.status, "attention");
  assert.deepEqual(ok.result.operation_failures.operations.map(row => [row.operation, row.category, row.count]), [["compaction", "busy", 1]]);
  assert.deepEqual(ok.result.suggestions.at(-1), { code: "inspect_operation_failures", count: 1 });
  for (const args of [["--days", "0"], ["--days", "31"], ["--days", "x"], ["extra"], ["--scope", "a"]]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /invalid_arguments/u);
  }
});

// Ratchet: new fail-open code must report through the ledger or explain why
// silence is safe. Empty `catch {}` is allowed only after a ROLLBACK, and the
// number of commented silent catches may only go down.
const SILENT_CATCH_BUDGET = 104;
test("silent catches do not grow and every one documents why", () => {
  const files = [];
  const walk = directory => { for (const name of readdirSync(directory)) { const path = join(directory, name); if (statSync(path).isDirectory()) { if (name !== "client") walk(path); } else if (name.endsWith(".ts")) files.push(path); } };
  walk("src");
  let silent = 0;
  const undocumented = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/catch\s*(?:\([^)]*\))?\s*\{(\s*(?:\/\*[^*]*\*\/)?\s*)\}/gu)) {
        silent++;
        if (!match[1].includes("/*") && !/ROLLBACK"?\)?;?\s*\}?\s*catch\s*\{\s*\}$/u.test(line.slice(0, match.index + match[0].length).replace(/\s+$/u, ""))) undocumented.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(undocumented, []);
  assert.ok(silent <= SILENT_CATCH_BUDGET, `silent catches grew to ${silent}; report through the operation failure ledger instead`);
});
