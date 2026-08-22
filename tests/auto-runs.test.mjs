import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";

function createStores() {
  const tmpRoot = join(process.cwd(), ".tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "auto-runs-test-"));
  const dbPath = join(dir, "kg.db");
  return [new GraphologyStore(dbPath), new GraphologyStore(dbPath)];
}

const entities = [
  { name: "Murata", type: "company", confidence: 0.95, evidence_span: "Murata supplies MLCC" },
  { name: "MLCC", type: "product", confidence: 0.95, evidence_span: "Murata supplies MLCC" }
];

const relations = [
  { source: "Murata", target: "MLCC", type: "supplies_product", confidence: 0.9, evidence_span: "Murata supplies MLCC" }
];

test("automatic run claims are atomic across stores and expose terminal success", () => {
  const [a, b] = createStores();
  try {
    assert.deepEqual(a.claimAutoRun("extract:s1:r1", 1000, 60000), { status: "claimed", attempt: 1 });
    assert.deepEqual(b.claimAutoRun("extract:s1:r1", 1001, 60000), { status: "busy" });
    assert.equal(a.finishAutoRun("extract:s1:r1", 1, "succeeded", 1100), true);
    assert.deepEqual(b.claimAutoRun("extract:s1:r1", 1200, 60000), { status: "succeeded" });
  } finally {
    a.close();
    b.close();
  }
});

test("a stale automatic run can be reclaimed by another store", () => {
  const [a, b] = createStores();
  try {
    assert.deepEqual(a.claimAutoRun("extract:s1:r2", 1000, 10), { status: "claimed", attempt: 1 });
    assert.deepEqual(b.claimAutoRun("extract:s1:r2", 1011, 10), { status: "claimed", attempt: 2 });
  } finally {
    a.close();
    b.close();
  }
});

test("stale claimants cannot finish over a newer running attempt", () => {
  const [a, b] = createStores();
  try {
    const first = a.claimAutoRun("extract:s1:r3", 1000, 10);
    const second = b.claimAutoRun("extract:s1:r3", 1011, 10);
    assert.deepEqual(first, { status: "claimed", attempt: 1 });
    assert.deepEqual(second, { status: "claimed", attempt: 2 });

    assert.equal(a.finishAutoRun("extract:s1:r3", first.attempt, "failed", 1012, "late"), false);
    assert.deepEqual(a.claimAutoRun("extract:s1:r3", 1013, 10), { status: "busy" });
    assert.equal(b.finishAutoRun("extract:s1:r3", second.attempt, "succeeded", 1014), true);
  } finally {
    a.close();
    b.close();
  }
});

test("stale claimants cannot overwrite a newer successful attempt", () => {
  const [a, b] = createStores();
  try {
    const first = a.claimAutoRun("extract:s1:r4", 1000, 10);
    const second = b.claimAutoRun("extract:s1:r4", 1011, 10);
    assert.equal(b.finishAutoRun("extract:s1:r4", second.attempt, "succeeded", 1012), true);
    assert.equal(a.finishAutoRun("extract:s1:r4", first.attempt, "failed", 1013, "late"), false);
    assert.deepEqual(a.claimAutoRun("extract:s1:r4", 1014, 10), { status: "succeeded" });
  } finally {
    a.close();
    b.close();
  }
});

test("terminal automatic-run receipts expire while active crash recovery state is retained", () => {
  const [store, other] = createStores();
  try {
    assert.deepEqual(store.claimAutoRun("extract:s1:old", 1, 10), { status: "claimed", attempt: 1 });
    assert.equal(store.finishAutoRun("extract:s1:old", 1, "succeeded", 2), true);
    assert.deepEqual(store.claimAutoRun("extract:s1:running", 1, 10), { status: "claimed", attempt: 1 });
    const now = 31 * 86_400_000;
    assert.equal(other.pruneAutoRuns(now), 1);
    assert.equal(other.db.prepare("SELECT COUNT(*) AS n FROM kg_auto_runs WHERE turn_key='extract:s1:old'").get().n, 0);
    assert.equal(other.db.prepare("SELECT status FROM kg_auto_runs WHERE turn_key='extract:s1:running'").get().status, "running");
  } finally {
    store.close();
    other.close();
  }
});

test("ingestOnce skips an already observed source without adding observations", () => {
  const [store, other] = createStores();
  try {
    const first = store.ingestOnce(entities, relations, "session:s1:turn:r1");
    const count = store.stats().observations.total;
    const second = other.ingestOnce(entities, relations, "session:s1:turn:r1");

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.deepEqual(second, { entities: [], relations: [], observations: [], skipped_relations: [], skipped: true });
    assert.equal(other.stats().observations.total, count);
  } finally {
    store.close();
    other.close();
  }
});
