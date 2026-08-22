import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Mnemora, BoundedCommandError, PROVIDER_ADAPTER_CONTRACT_V1, ProviderAdapterContractError, ProviderAdapterRegistry } from "../dist/index.js";

const text = "Public provider result: Acme supplies advanced packaging.";
const extraction = { entities: [{ name: "Acme", type: "company", confidence: .9, evidence_span: "Acme supplies advanced packaging." }], relations: [] };

function fixture(overrides = {}) {
  const calls = [];
  const adapter = {
    id: "public-fixture",
    contractVersion: PROVIDER_ADAPTER_CONTRACT_V1,
    capabilities: { searchSources: true, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true },
    async probe(options) {
      calls.push({ operation: "probe", options });
      return { providerId: "public-fixture", detectedVersion: "0.1.0", ...this.capabilities };
    },
    async searchCandidates(query, scope, limit, options) {
      calls.push({ operation: "search", query, scope, limit, options });
      return [{ ref: { provider: "public-fixture", externalId: "record:1" }, content: text, contentHash: "untrusted", providerMetadata: { privatePath: "C:\\private\\store.db" } }];
    },
    ...overrides
  };
  return { adapter, calls };
}

test("public Adapter SDK validates its contract, bounds calls, and normalizes Provider output", async () => {
  const { adapter, calls } = fixture();
  const registry = new ProviderAdapterRegistry([{ adapter, limits: { timeoutMs: 1000, maxInputChars: 32, maxOutputBytes: 4096 } }]);
  const capabilities = await registry.probe("public-fixture");
  const candidates = await registry.searchCandidates("public-fixture", "packaging", "global", 3);
  assert.equal(capabilities.detectedVersion, "0.1.0");
  assert.equal(calls[0].options.maxBytes, 4096);
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.equal(calls[1].query, "packaging");
  assert.equal(calls[1].limit, 3);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].contentHash, createHash("sha256").update(text).digest("hex"));
  assert.equal(JSON.stringify(candidates).includes("private"), false);
  await assert.rejects(() => registry.searchCandidates("public-fixture", "x".repeat(257), "global", 1), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  assert.equal(calls.length, 2);
});

test("public Adapter SDK rejects invalid declarations, dishonest probes, and cancellation", async () => {
  assert.throws(() => new ProviderAdapterRegistry([{ adapter: { id: "Bad_ID", contractVersion: PROVIDER_ADAPTER_CONTRACT_V1, capabilities: { searchSources: false, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: false, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true }, probe: async () => ({}) } }]), error => error instanceof ProviderAdapterContractError && error.code === "invalid_provider_adapter");
  const dishonest = fixture({ probe: async () => ({ providerId: "public-fixture", searchSources: false, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true }) });
  const registry = new ProviderAdapterRegistry([{ adapter: dishonest.adapter }]);
  await assert.rejects(() => registry.probe("public-fixture"), error => error instanceof BoundedCommandError && error.category === "invalid_response");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => registry.searchCandidates("public-fixture", "query", "global", 1, controller.signal), error => error instanceof BoundedCommandError && error.category === "cancelled");
});

test("a host can deliberately register an Adapter and preserve its source anchor through the normal ingest path", async () => {
  const { adapter } = fixture();
  const graph = new Mnemora({ config: { dbPath: ":memory:", trustLayer: { enabled: true } }, extractor: { extract: async () => extraction }, providerAdapters: [{ adapter }] });
  try {
    const [candidate] = await graph.providerAdapters.searchCandidates("public-fixture", "packaging", "global", 1);
    const result = await graph.ingestProviderSource({ source: candidate, scope: "project:adapter" });
    assert.equal(result.status, "succeeded");
    assert.deepEqual({ ...graph.store.db.prepare("SELECT provider,external_id,scope,status FROM kg_source_anchors").get() }, { provider: "public-fixture", external_id: "record:1", scope: "project:adapter", status: "available" });
    assert.equal(graph.providerAdapters.list()[0].id, "public-fixture");
  } finally { graph.close(); }
});
