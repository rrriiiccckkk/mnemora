import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";

const insertNode = (store, { id, name, aliases = [], type = "company", description = "" }) => {
  const now = Date.now();
  store.db.prepare(`INSERT INTO kg_nodes
    (id,type,name,description,aliases,importance,deleted_at,created_at,updated_at)
    VALUES (?,?,?,?,?,0,NULL,?,?)`
  ).run(id, type, name, description, JSON.stringify(aliases), now, now);
};

test("bounded duplicate scan persists one explainable unordered candidate", () => {
  const store = new GraphologyStore(":memory:");
  try {
    insertNode(store, { id: "company:sk-hynix", name: "SK Hynix", aliases: ["SK海力士"] });
    insertNode(store, { id: "company:sk-hailishi", name: "SK海力士", aliases: ["海力士"] });

    const scan = store.scanDuplicateCandidates("", 20);
    assert.deepEqual(
      { processed: scan.processed, created: scan.created, complete: scan.complete },
      { processed: 2, created: 1, complete: true }
    );

    const review = store.reviewCandidates({ status: "pending", limit: 10 });
    assert.equal(review.items.length, 1);
    assert.deepEqual(
      [review.items[0].entity_a, review.items[0].entity_b],
      ["company:sk-hailishi", "company:sk-hynix"]
    );
    assert.equal(review.items[0].signals.some((signal) => signal.kind === "alias_exact"), true);
    assert.match(review.items[0].reasons.join(" "), /alias/i);

    store.scanDuplicateCandidates("", 20);
    assert.equal(store.reviewCandidates({ status: "pending", limit: 10 }).items.length, 1);
  } finally {
    store.close();
  }
});

test("incremental duplicate discovery scans the ingested neighbourhood, not unrelated first rows", () => {
  const store = new GraphologyStore(":memory:");
  try {
    insertNode(store, { id: "company:a", name: "Alpha" });
    insertNode(store, { id: "company:b", name: "Beta", aliases: ["Zeta Systems"] });
    insertNode(store, { id: "company:z", name: "Zeta Systems" });
    const result = store.scanDuplicateCandidatesForIds(["company:z"]);
    assert.deepEqual(result, { processed: 1, created: 1, updated: 0 });
    assert.deepEqual([store.reviewCandidates({ status: "pending" }).items[0].entity_a, store.reviewCandidates({ status: "pending" }).items[0].entity_b].sort(), ["company:b", "company:z"]);
  } finally { store.close(); }
});

test("rejected candidates stay suppressed until an entity fingerprint changes", () => {
  const store = new GraphologyStore(":memory:");
  try {
    insertNode(store, { id: "company:a", name: "Acme", aliases: ["Acme Corp"] });
    insertNode(store, { id: "company:b", name: "Acme Corp", aliases: [] });
    store.scanDuplicateCandidates("", 20);
    const candidate = store.reviewCandidates({ status: "pending" }).items[0];

    store.decideCandidate(candidate.id, "rejected");
    store.scanDuplicateCandidates("", 20);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 0);
    assert.equal(store.reviewCandidates({ status: "rejected" }).items.length, 1);

    store.db.prepare("UPDATE kg_nodes SET description=?, updated_at=? WHERE id=?")
      .run("Changed identity evidence", Date.now() + 1, "company:b");
    store.scanDuplicateCandidates("", 20);
    assert.equal(store.reviewCandidates({ status: "pending" }).items.length, 1);
  } finally {
    store.close();
  }
});

test("weekly duplicate scan persists and resumes its stable cursor", () => {
  const store = new GraphologyStore(":memory:");
  try {
    insertNode(store, { id: "company:a", name: "Alpha" });
    insertNode(store, { id: "company:b", name: "Beta" });
    insertNode(store, { id: "company:c", name: "Gamma" });

    const first = store.scanDuplicateCandidates(undefined, 2, { persistCursor: true });
    assert.deepEqual({ processed: first.processed, next: first.next_after_id, complete: first.complete }, { processed: 2, next: "company:b", complete: false });
    const state = store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='duplicate_scan_cursor'").get();
    assert.equal(state.value, "company:b");

    const second = store.scanDuplicateCandidates(undefined, 2, { persistCursor: true });
    assert.deepEqual({ processed: second.processed, complete: second.complete }, { processed: 1, complete: true });
    assert.equal(store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='duplicate_scan_cursor'").get().value, "");
    assert.equal(store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key='duplicate_scan_completed_at'").get() != null, true);
  } finally {
    store.close();
  }
});
