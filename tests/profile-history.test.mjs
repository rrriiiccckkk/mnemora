import assert from "node:assert/strict";
import { DatabaseSync } from "@photostructure/sqlite";
import { join } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import test from "node:test";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

test("profile history records material projections once and produces a bounded evidence-backed diff", async () => {
  let now = 10_000;
  let extraction = {
    entities: [
      { name: "Alice", type: "person", confidence: .9, evidence_span: "Alice works at Acme." },
      { name: "Acme", type: "company", confidence: .9, evidence_span: "Alice works at Acme." }
    ],
    relations: [{ source: "Alice", target: "Acme", type: "works_at", confidence: .9, evidence_span: "Alice works at Acme." }]
  };
  const graph = new Mnemora({ config: { dbPath: ":memory:" }, extractor: { extract: async () => extraction }, now: () => now });
  try {
    await graph.kg_ingest("Alice works at Acme.", "profile-secret-source");
    const first = graph.kg_profile("Alice");
    assert.equal(first.status, "ok");
    now++;
    graph.kg_profile("Alice");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_profile_projection_snapshots").get().n, 1);

    extraction = {
      entities: [{ name: "Beta", type: "company", confidence: .8, evidence_span: "Alice also works at Beta." }],
      relations: [{ source: "Alice", target: "Beta", type: "works_at", confidence: .8, evidence_span: "Alice also works at Beta." }]
    };
    await graph.kg_ingest("Alice also works at Beta.", "profile-secret-source");
    now++;
    graph.kg_profile("Alice");

    const history = graph.kg_profile_history({ operation: "list", subject: "Alice" });
    assert.equal(history.status, "ok");
    assert.equal(history.items.length, 2);
    assert.equal(history.items.every(item => /^profile-snapshot:[a-f0-9]{40}$/.test(item.id)), true);
    assert.doesNotMatch(JSON.stringify(history), /profile-secret-source|evidence_span|quote/i);

    const diff = graph.kg_profile_history({ operation: "diff", subject: "Alice" });
    assert.equal(diff.status, "ok");
    assert.equal(diff.changes.some(change => change.field === "works_at" && change.kind === "values_changed"), true);
    assert.equal(JSON.stringify(diff).includes("Alice also works at Beta."), false);
  } finally { graph.close(); }
});

test("schema v25 adds profile snapshots additively to a v24 database", () => {
  mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
  const file = join(mkdtempSync(join(process.cwd(), ".tmp", "profile-history-v25-")), "legacy.db");
  const initial = new GraphologyStore(file);
  initial.close();
  const legacy = new DatabaseSync(file);
  try { legacy.exec("DROP TABLE kg_profile_projection_snapshots; PRAGMA user_version=24"); }
  finally { legacy.close(); }
  const migrated = new GraphologyStore(file);
  try {
    assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
    assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='kg_profile_projection_snapshots'").get().n, 1);
  } finally { migrated.close(); }
});
