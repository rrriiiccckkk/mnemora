import assert from "node:assert/strict";
import test from "node:test";
import { GraphologyStore } from "../dist/store.js";
import { ArtifactRepository } from "../dist/artifacts/repository.js";

test("artifact storage is redacted, scope isolated, bounded, and represented by a safe placeholder", () => {
  const store = new GraphologyStore(":memory:");
  try {
    const repository = new ArtifactRepository(store.db, { maxInlineChars: 4096, maxEventBytes: 8192, sensitiveContentPolicy: "redact" });
    const artifact = repository.put({ scope: "private", kind: "tool_result", content: "api_key=SECRET_VALUE\n" + "x".repeat(2048) });
    assert.doesNotMatch(artifact.preview, /SECRET_VALUE/);
    assert.equal(repository.metadata(artifact.id, "other"), undefined);
    const range = repository.readRange(artifact.id, "private", 0, 64);
    assert.ok(range.content.length <= 64);
    assert.equal(range.truncated, true);
    assert.deepEqual(repository.search("other", "x"), []);
    assert.match(repository.placeholder(artifact), new RegExp(artifact.id));
    assert.throws(() => repository.readRange(artifact.id, "private", 0, 65537), /invalid_artifact_range/);
  } finally { store.close(); }
});
