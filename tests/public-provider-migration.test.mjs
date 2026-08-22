import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore, PROVIDER_ADAPTER_CONTRACT_V1, ProviderAdapterRegistry, PublicProviderMigrationService } from "../dist/index.js";

const capabilities = { searchSources: true, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: true, returnsScores: false, supportsAbortSignal: true };

test("public provider migration is preview-first, resumable, hash-verified, and never requires a provider store", async () => {
  const store = new GraphologyStore(":memory:");
  let content = "migration evidence", ingested = 0;
  const adapter = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities,
    async probe() { return { providerId: "memory-lancedb-pro", detectedVersion: "fixture", ...capabilities }; },
    async searchCandidates(query, providerScope, limit, options) {
      assert.equal(query, "migration"); assert.equal(providerScope, "global"); assert.ok(limit >= 1 && limit <= 10); assert.ok(options.signal instanceof AbortSignal);
      return [{ ref: { provider: "memory-lancedb-pro", externalId: "memory:1" }, content, contentHash: "ignored" }];
    }
  };
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter }]), async ({ source, scope }) => { assert.equal(scope, "work"); assert.equal(source.ref.externalId, "memory:1"); ingested++; return { status: "succeeded" }; });
    const preview = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "migration", providerScope: "global", limit: 2 });
    assert.equal(preview.status, "previewed"); assert.equal(preview.items[0].status, "pending"); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM mnemora_provider_migration_items").get().n, 1);
    const applied = await service.apply({ id: preview.id });
    assert.equal(applied.status, "completed"); assert.equal(applied.items[0].status, "imported"); assert.equal(ingested, 1);
    const changedPreview = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "migration", providerScope: "global" });
    content = "changed after preview";
    const changed = await service.apply({ id: changedPreview.id });
    assert.equal(changed.status, "completed_with_failures"); assert.equal(changed.items[0].status, "source_changed");
    assert.equal(service.rollback(preview.id).status, "rollback_requires_restore");
  } finally { store.close(); }
});

test("public inventory migration is page-bounded, resumable, and retains only bounded lifecycle metadata", async () => {
  const store = new GraphologyStore(":memory:"), calls = [], imported = [];
  const inventoryCapabilities = { ...capabilities, searchSources: false };
  const adapter = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities: inventoryCapabilities,
    async probe() { return { providerId: "memory-lancedb-pro", ...inventoryCapabilities }; },
    async listSources(scope, limit, offset) {
      calls.push({ scope, limit, offset });
      const rows = offset === 0 ? [{ ref: { provider: "memory-lancedb-pro", externalId: "m:1" }, content: "first", contentHash: "ignored", metadata: { category: "fact", importance: .9 } }] : [{ ref: { provider: "memory-lancedb-pro", externalId: "m:2" }, content: "second", contentHash: "ignored", metadata: { category: "decision", importance: .7 } }];
      return { sources: rows, complete: offset > 0, ...(offset === 0 ? { nextOffset: 1 } : {}) };
    }
  };
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter }]), async ({ source }) => { imported.push(source); return { status: "succeeded" }; });
    const first = await service.preview({ provider: "memory-lancedb-pro", scope: "work", providerScope: "global", limit: 1, offset: 0 });
    assert.deepEqual(first.inventory, { offset: 0, nextOffset: 1, complete: false });
    assert.deepEqual(first.items[0].metadata, { category: "fact", importance: .9 });
    const completed = await service.apply({ id: first.id });
    assert.equal(completed.items[0].status, "imported");
    assert.deepEqual(imported[0].metadata, { category: "fact", importance: .9 });
    const second = await service.preview({ provider: "memory-lancedb-pro", scope: "work", providerScope: "global", limit: 1, offset: 1 });
    assert.deepEqual(second.inventory, { offset: 1, complete: true });
    assert.deepEqual(calls, [{ scope: "global", limit: 1, offset: 0 }, { scope: "global", limit: 1, offset: 0 }, { scope: "global", limit: 1, offset: 1 }]);
    assert.equal(JSON.stringify(store.db.prepare("SELECT metadata_json FROM mnemora_provider_migration_items WHERE run_id=?").get(first.id)).match(/provider_db|private/), null);
  } finally { store.close(); }
});

test("both legacy provider paths preserve public source identity and resume an interrupted migration", async () => {
  const store = new GraphologyStore(":memory:"), rawCapabilities = { ...capabilities, searchSources: false, resolveRawSource: true };
  let lancedbAttempts = 0;
  const lancedb = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities,
    async probe() { return { providerId: "memory-lancedb-pro", ...capabilities }; },
    async searchCandidates() { return [{ ref: { provider: "memory-lancedb-pro", externalId: "public-memory-7" }, content: "Migration keeps public source identity", contentHash: "ignored" }]; }
  };
  const lossless = {
    id: "lossless-claw", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities: rawCapabilities,
    async probe() { return { providerId: "lossless-claw", ...rawCapabilities }; },
    async resolveSource(ref) { return ref.externalId === "turn:42" ? { ref, content: "Historical turn from the public export", contentHash: "ignored" } : null; }
  };
  const imported = [];
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter: lancedb }, { adapter: lossless }]), async ({ source }) => {
      imported.push(source.ref);
      if (source.ref.provider === "memory-lancedb-pro" && lancedbAttempts++ === 0) return { status: "failed" };
      return { status: "succeeded" };
    });
    const lancedbPreview = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "identity", providerScope: "global" });
    assert.equal((await service.apply({ id: lancedbPreview.id })).status, "completed_with_failures");
    const resumed = await service.apply({ id: lancedbPreview.id });
    assert.equal(resumed.status, "completed"); assert.deepEqual(resumed.items, [{ externalId: "public-memory-7", contentHash: lancedbPreview.items[0].contentHash, sourceRef: { provider: "memory-lancedb-pro", externalId: "public-memory-7" }, status: "imported" }]);
    const losslessPreview = await service.preview({ provider: "lossless-claw", scope: "work", externalRefs: [{ provider: "lossless-claw", externalId: "turn:42" }] });
    const losslessApplied = await service.apply({ id: losslessPreview.id });
    assert.equal(losslessApplied.status, "completed");
    assert.deepEqual(imported.map(item => item.externalId), ["public-memory-7", "public-memory-7", "turn:42"]);
    const storedRef = store.db.prepare("SELECT source_ref_json FROM mnemora_provider_migration_items WHERE run_id=?").get(losslessPreview.id);
    assert.deepEqual(JSON.parse(storedRef.source_ref_json), { provider: "lossless-claw", externalId: "turn:42" });
    assert.equal(JSON.stringify(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='mnemora_provider_migration_items'").get()).includes("provider_db"), false);
  } finally { store.close(); }
});

test("migration resolves stable ids exactly and never calls a missing search result source_changed", async () => {
  const store = new GraphologyStore(":memory:"), exactCapabilities = { ...capabilities, resolveRawSource: true };
  let includeInSearch = true, resolved = 0;
  const adapter = {
    id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities: exactCapabilities,
    async probe() { return { providerId: "memory-lancedb-pro", ...exactCapabilities }; },
    async searchCandidates() { return includeInSearch ? [{ ref: { provider: "memory-lancedb-pro", externalId: "stable:1" }, content: "stable source", contentHash: "ignored" }] : []; },
    async resolveSource(ref) { resolved++; return { ref, content: "stable source", contentHash: "ignored" }; }
  };
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter }]), async () => ({ status: "succeeded" }));
    const preview = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "stable", providerScope: "global" });
    includeInSearch = false;
    const applied = await service.apply({ id: preview.id });
    assert.equal(resolved, 1);
    assert.equal(applied.items[0].status, "imported");
  } finally { store.close(); }
});

test("migration marks an unavailable provider source retryable rather than changed", async () => {
  const store = new GraphologyStore(":memory:");
  let available = true;
  const adapter = {
    id: "lossless-claw", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities: { ...capabilities, searchSources: false, resolveRawSource: true },
    async probe() { return { providerId: "lossless-claw", ...this.capabilities }; },
    async resolveSource(ref) { return available ? { ref, content: "initial source", contentHash: "ignored" } : null; }
  };
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter }]), async () => ({ status: "succeeded" }));
    const preview = await service.preview({ provider: "lossless-claw", scope: "work", externalRefs: [{ provider: "lossless-claw", externalId: "turn:missing" }] });
    available = false;
    const applied = await service.apply({ id: preview.id });
    assert.deepEqual({ status: applied.status, item: applied.items[0].status, code: applied.items[0].errorCode }, { status: "completed_with_failures", item: "failed", code: "source_unavailable" });
  } finally { store.close(); }
});

test("rerunning a preview removes stale pending items while retaining imported audit rows", async () => {
  const store = new GraphologyStore(":memory:"), capabilities = { searchSources: true, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: true, returnsScores: false, supportsAbortSignal: true };
  const ids = ["memory:keep"];
  const adapter = { id: "memory-lancedb-pro", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities, async probe() { return { providerId: "memory-lancedb-pro", ...capabilities }; }, async searchCandidates() { return ids.map(externalId => ({ ref: { provider: "memory-lancedb-pro", externalId }, content: externalId, contentHash: "ignored" })); } };
  try {
    const service = new PublicProviderMigrationService(store.db, new ProviderAdapterRegistry([{ adapter }]), async () => ({ status: "succeeded" }));
    const first = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "same", providerScope: "global" });
    store.db.prepare("INSERT INTO mnemora_provider_migration_items(run_id,ordinal,external_id,source_ref_json,content_hash,status,updated_at) VALUES(?,?,?,?,?,'pending',?)").run(first.id, 9, "memory:stale", JSON.stringify({ provider: "memory-lancedb-pro", externalId: "memory:stale" }), "a".repeat(64), 1);
    const second = await service.preview({ provider: "memory-lancedb-pro", scope: "work", query: "same", providerScope: "global" });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.items.map(item => item.externalId), ["memory:keep"]);
  } finally { store.close(); }
});
