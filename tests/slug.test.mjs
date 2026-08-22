import test from "node:test";
import assert from "node:assert/strict";
import { Mnemora, GraphologyStore } from "../dist/index.js";
import { legacyNormalizeSlug, normalizeSlug } from "../dist/slug.js";

test("mixed-script canonical ids retain a strong full-name identity", () => {
  const first = normalizeSlug("腾讯云 API", "company");
  const second = normalizeSlug("阿里云 API", "company");
  assert.notEqual(first, second);
  assert.match(first, /^company:-api-[a-f0-9]{32}$/);
  assert.equal(normalizeSlug("TSMC", "company"), "company:tsmc");
});

test("an occupied generated id never overwrites a different entity", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const id = normalizeSlug("腾讯云 API", "company");
    const now = Date.now();
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, "company", "Different Company", "", "[]", 0, now, now);
    const graph = store;
    // Exercise the private ingestion path through its public transaction API.
    graph.ingest([{ name:"腾讯云 API",type:"company",confidence:.9,evidence_span:"e" }], [], "test");
    const rows = store.db.prepare("SELECT id,name FROM kg_nodes ORDER BY id").all();
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.id === id).name, "Different Company");
    assert.equal(rows.some(row => row.name === "腾讯云 API"), true);
  } finally { store.close(); }
});

test("legacy identity audit is paginated, read-only, and limited to pre-v1.0.1 ids", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const now = Date.now();
    const legacyNames = ["\u817e\u8baf\u4e91 API", "\u963f\u91cc\u4e91 Cloud"];
    const insert = store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
    for (const name of legacyNames) insert.run(legacyNormalizeSlug(name, "company"), "company", name, "", "[]", 0, now, now);
    insert.run(normalizeSlug("Modern API", "company"), "company", "Modern API", "", "[]", 0, now, now);
    insert.run(normalizeSlug("\u5f53\u4ee3 API", "company"), "company", "\u5f53\u4ee3 API", "", "[]", 0, now, now);

    const snapshot = () => store.db.prepare("SELECT id,type,name,description,aliases,importance,created_at,updated_at FROM kg_nodes ORDER BY id").all();
    const before = snapshot();
    const first = store.auditLegacyIdentities(undefined, 1);
    assert.equal(first.items.length, 1);
    assert.equal(first.truncated, true);
    assert.equal(first.items[0].entity_id, legacyNormalizeSlug(legacyNames[0], "company"));
    assert.equal(first.items[0].expected_id, normalizeSlug(legacyNames[0], "company"));
    assert.equal(first.next_after_id, first.items[0].entity_id);

    const second = store.auditLegacyIdentities(first.next_after_id, 1);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].entity_id, legacyNormalizeSlug(legacyNames[1], "company"));
    assert.equal(second.items.some(item => item.entity_id === normalizeSlug("Modern API", "company")), false);
    assert.deepEqual(snapshot(), before);
  } finally { store.close(); }
});

test("kg_review exposes legacy identity findings without a mutation path", () => {
  const graph = new Mnemora({ config: { dbPath: ":memory:" } });
  try {
    const name = "\u817e\u8baf\u4e91 API", now = Date.now();
    graph.store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(legacyNormalizeSlug(name, "company"), "company", name, "", "[]", 0, now, now);
    const result = graph.kg_review("identity");
    assert.equal(result.items.length, 1);
    assert.throws(() => graph.kg_review("identity", "pending", true), /read-only/);
  } finally { graph.close(); }
});
