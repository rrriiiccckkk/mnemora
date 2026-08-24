import assert from "node:assert/strict";
import test from "node:test";
import {
  MnemoraContextRefError,
  MNEMORA_CONTEXT_REF_KIND_REGISTRY_REVISION,
  MNEMORA_CONTEXT_REF_KINDS,
  authorizeMnemoraContextRef,
  createMnemoraContextRef,
  parseMnemoraContextRef,
  resolveMnemoraContextRef
} from "../dist/index.js";

test("mnemora v1 references round-trip with canonical encoded segments", () => {
  const reference = createMnemoraContextRef({ scope: "project:alpha", kind: "conversation-event", id: "event:你好" });
  assert.equal(reference, "mnemora://v1/scope/project%3Aalpha/conversation-event/event%3A%E4%BD%A0%E5%A5%BD");
  assert.deepEqual(parseMnemoraContextRef(reference), {
    version: "v1", scope: "project:alpha", kind: "conversation-event", id: "event:你好", canonical: reference
  });
});

test("mnemora v1 kind registry additively covers cognition objects and corpus citations", () => {
  assert.equal(MNEMORA_CONTEXT_REF_KIND_REGISTRY_REVISION, 6);
  for (const kind of ["memory-candidate", "belief", "decision", "task-outcome", "reasoning-memory", "reasoning-delivery-item", "corpus-chunk"]) {
    assert.equal(MNEMORA_CONTEXT_REF_KINDS.includes(kind), true);
    const reference = createMnemoraContextRef({ scope: "personal", kind, id: `${kind}:1` });
    assert.equal(parseMnemoraContextRef(reference).kind, kind);
  }
});

test("mnemora parser rejects unknown versions, traversal, ambiguous encoding, and path syntax", () => {
  const invalid = [
    ["https://v1/scope/default/claim/claim%3A1", "invalid_scheme"],
    ["mnemora://v2/scope/default/claim/claim%3A1", "unsupported_version"],
    ["mnemora://v1/scope/default/unknown/id", "invalid_kind"],
    ["mnemora://v1/scope/%ZZ/claim/id", "invalid_encoding"],
    ["mnemora://v1/scope/default/claim/%2E%2E", "invalid_id"],
    ["mnemora://v1/scope/default/claim/%252E%252E", "invalid_id"],
    ["mnemora://v1/scope/project%3aalpha/claim/id", "non_canonical"],
    ["mnemora://v1/scope/Project%3AAlpha/claim/id", "invalid_scope"],
    ["mnemora://v1/scope/default/claim/id/extra", "invalid_shape"]
  ];
  for (const [reference, code] of invalid) {
    assert.throws(() => parseMnemoraContextRef(reference), error => error instanceof MnemoraContextRefError && error.code === code && error.message === code);
  }
  assert.throws(() => createMnemoraContextRef({ scope: "../../secret", kind: "claim", id: "x" }), /invalid_scope/);
  assert.throws(() => createMnemoraContextRef({ scope: "default", kind: "claim", id: "folder\\secret" }), /invalid_id/);
});

test("mnemora resolution authorizes scope and kind before invoking a repository", async () => {
  const reference = createMnemoraContextRef({ scope: "project:a", kind: "claim", id: "claim:1" });
  let calls = 0;
  assert.throws(() => authorizeMnemoraContextRef(reference, { scope: "project:b" }), error => error.code === "scope_mismatch");
  await assert.rejects(resolveMnemoraContextRef(reference, { scope: "project:a", kinds: ["artifact"] }, () => ++calls), error => error.code === "invalid_kind");
  assert.equal(calls, 0);
  assert.deepEqual(await resolveMnemoraContextRef(reference, { scope: "project:a", kinds: ["claim"] }, parsed => ({ id: parsed.id })), { id: "claim:1" });
  assert.equal(calls, 0);
});

test("mnemora resolver honors AbortSignal without leaking raw references in errors", async () => {
  const secretId = "secret-token-value";
  const reference = createMnemoraContextRef({ scope: "default", kind: "artifact", id: secretId });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveMnemoraContextRef(reference, { scope: "default", signal: controller.signal }, () => "never"), error => {
    assert.equal(error.code, "aborted");
    assert.doesNotMatch(error.message, /secret-token-value/);
    return true;
  });
  await assert.rejects(resolveMnemoraContextRef(reference, { scope: "default" }, () => { throw new Error("private repository body"); }), error => {
    assert.equal(error.code, "resolution_failed");
    assert.equal(error.message, "resolution_failed");
    return true;
  });
});
