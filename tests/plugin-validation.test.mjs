import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import plugin from "../dist/plugin.js";
import * as validator from "../scripts/validate-plugin.mjs";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const clone = (value) => structuredClone(value);

test("advanced validator exposes a reusable authoritative gate", () => {
  assert.equal(typeof validator.validateAdvancedPlugin, "function");
  assert.doesNotThrow(() => validator.validateAdvancedPlugin({ manifest, pkg, plugin, readme }));
});

test("advanced validator rejects config schema drift", () => {
  const invalid = clone(manifest);
  invalid.configSchema.properties.recall.properties.autoRecall.type = "string";
  assert.throws(() => validator.validateAdvancedPlugin({ manifest: invalid, pkg, plugin, readme }), /config schema/i);
});

test("plugin schema rejects non-positive embedding batch sizes", () => {
  assert.equal(plugin.configSchema.safeParse({ embeddings: { batchSize: 0 } }).success, false);
  assert.equal(plugin.configSchema.safeParse({ embeddings: { batchSize: -1 } }).success, false);
});

test("plugin and manifest schemas publish matching embedding defaults", () => {
  const defaults = manifest.configSchema.properties.embeddings.properties;
  assert.equal(defaults.enabled.default, false);
  assert.equal(defaults.provider.default, "ollama");
  assert.equal(defaults.provider.const, "ollama");
  assert.equal(defaults.baseURL.default, "http://127.0.0.1:11434");
  assert.equal(defaults.model.default, "qwen3-embedding:4b");
  assert.equal(plugin.configSchema.safeParse({ embeddings: { enabled: false, provider: "ollama", baseURL: "http://127.0.0.1:11434", model: "qwen3-embedding:4b" } }).success, true);
  assert.equal(plugin.configSchema.safeParse({ embeddings: { provider: "unsupported" } }).success, false);
});

test("plugin and manifest schemas expose bounded hybrid recall configuration", () => {
  const valid = { recall: { mode: "semantic", semanticMinScore: .4, hybridWeights: { semantic: .45, lexical: .25, confidence: .2, freshness: .1 } } };
  assert.equal(plugin.configSchema.safeParse(valid).success, true);
  assert.equal(plugin.configSchema.safeParse({ recall: { mode: "unknown" } }).success, false);
  assert.equal(plugin.configSchema.safeParse({ recall: { semanticMinScore: 2 } }).success, false);
  assert.equal(plugin.configSchema.safeParse({ recall: { hybridWeights: { semantic: .5, lexical: .5, confidence: 0, freshness: 2 } } }).success, false);
  assert.doesNotThrow(() => validator.validateAdvancedPlugin({ manifest, pkg, plugin, readme }));
});

test("advanced validator rejects declared tool contract drift", () => {
  const invalid = clone(manifest);
  invalid.contracts.tools[0] = "kg_missing";
  assert.throws(() => validator.validateAdvancedPlugin({ manifest: invalid, pkg, plugin, readme }), /tool contracts/i);
});

test("authoritative plugin contract declares exactly thirty-two tools without ContextEngine metadata", () => {
  assert.equal(manifest.contracts.tools.length, 32);
  assert.equal(manifest.contracts.tools.includes("kg_insights"), true);
  assert.equal(manifest.contracts.tools.includes("kg_profile"), true);
  assert.equal(manifest.contracts.tools.includes("kg_profile_lock"), true);
  assert.equal(manifest.contracts.tools.includes("kg_scopes"), true);
  assert.equal(manifest.contracts.tools.includes("kg_recall_canary"), true);
  assert.equal(manifest.contracts.tools.includes("kg_recall_explain"), true);
  for (const name of ["kg_query", "kg_timeline", "kg_compare", "kg_watch", "kg_digest", "kg_export", "kg_import", "kg_query_history"]) assert.equal(manifest.contracts.tools.includes(name), true);
  assert.equal("contextEngine" in manifest.contracts, false);
  assert.doesNotThrow(() => validator.validateAdvancedPlugin({ manifest, pkg, plugin, readme }));
});

test("advanced validator rejects hook activation drift", () => {
  const invalidPlugin = { ...plugin, register(api) { api.registerTool({ name: "kg_ingest" }); api.on("gateway_stop", () => {}); } };
  assert.throws(() => validator.validateAdvancedPlugin({ manifest, pkg, plugin: invalidPlugin, readme }), /hook activation|tool contracts/i);
});

test("advanced validator rejects missing ContextEngine lifecycle documentation", () => {
  assert.throws(() => validator.validateAdvancedPlugin({ manifest, pkg, plugin, readme: readme.replace("registers no `before_prompt_build` or `agent_end` hook", "registers legacy hooks") }), /removed hooks/i);
});

test("plugin and manifest schemas expose the opt-in bounded corpus boundary", () => {
  const corpus = manifest.configSchema.properties.corpus.properties;
  assert.equal(corpus.enabled.default, false);
  assert.equal(corpus.maxFileBytes.maximum, 1048576);
  assert.equal(plugin.configSchema.safeParse({ corpus: { enabled: true, workspaceRoot: "C:/workspace", includeSessions: true }, workspaceBoundary: { userMdExclusive: { enabled: true } } }).success, true);
  assert.equal(plugin.configSchema.safeParse({ corpus: { maxFiles: 1001 } }).success, false);
  assert.equal(manifest.skills.includes("skills/mnemora"), true);
  assert.equal(manifest.commandAliases.some(entry => entry.name === "mnemora"), true);
});

test("advanced validator rejects package and manifest version drift", () => {
  assert.throws(() => validator.validateAdvancedPlugin({ manifest, pkg: { ...pkg, version: "9.9.9" }, plugin, readme }), /version/i);
});
