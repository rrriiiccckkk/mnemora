import assert from "node:assert/strict";
import test from "node:test";
import {
  OllamaEmbedder,
  cosineSimilarity,
  createEmbedder,
  decodeEmbedding,
  embeddingInput,
  embeddingInputVersion,
  encodeEmbedding
} from "../dist/embeddings.js";

const config = {
  enabled: true, provider: "ollama", baseURL: "http://127.0.0.1:11434",
  model: "qwen3-embedding:4b", timeoutMs: 10000, batchSize: 16,
  maxInputChars: 16000, queryCacheSize: 256, maxVectorScanNodes: 10000
};

test("OllamaEmbedder validates returned vectors and reports actual identity", async () => {
  const embedder = new OllamaEmbedder(config, async () => new Response(JSON.stringify({ embeddings: [[3, 4]] })));
  const result = await embedder.embed(["semiconductor upstream"]);
  assert.deepEqual(result.identity, { provider: "ollama", model: "qwen3-embedding:4b", dimensions: 2 });
  assert.deepEqual(result.vectors, [[0.6, 0.8]]);
});

test("OllamaEmbedder sends the provider request without exposing response bodies", async () => {
  let request;
  const embedder = new OllamaEmbedder(config, async (url, init) => {
    request = { url, init };
    return new Response("secret provider details", { status: 503 });
  });
  await assert.rejects(embedder.embed(["x"]), (error) => {
    assert.match(error.message, /embedding request failed: 503/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(request.url, "http://127.0.0.1:11434/api/embed");
  assert.deepEqual(JSON.parse(request.init.body), { model: config.model, input: ["x"], truncate: true });
});

test("OllamaEmbedder rejects malformed vectors", async () => {
  for (const embeddings of [[], [[0, 0]], [[1, NaN]], [[1], [1, 2]]]) {
    const inputs = embeddings.length === 2 ? ["a", "b"] : ["a"];
    const embedder = new OllamaEmbedder(config, async () => new Response(JSON.stringify({ embeddings })));
    await assert.rejects(embedder.embed(inputs), /embedding vectors/);
  }
});

test("createEmbedder creates the configured provider", () => {
  assert.ok(createEmbedder(config) instanceof OllamaEmbedder);
});

test("embedding input is stable and includes populated fields", () => {
  assert.equal(embeddingInputVersion, "node-v1");
  assert.equal(embeddingInput({ type: "company", name: "Mnemora", description: "Graph memory", aliases: ["local", "memory"] }),
    "type: company\nname: Mnemora\ndescription: Graph memory\naliases: local, memory");
  assert.equal(embeddingInput({ type: "company", name: "Mnemora", description: "", aliases: [] }), "type: company\nname: Mnemora");
});

test("embedding codec round trips float32 values and validates dimensions", () => {
  const bytes = encodeEmbedding([0.6, 0.8]);
  assert.equal(bytes.length, 8);
  const decoded = decodeEmbedding(bytes, 2);
  assert.ok(Math.abs(decoded[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(decoded[1] - 0.8) < 1e-6);
  assert.throws(() => encodeEmbedding([0, 0]), /embedding vector/);
  assert.throws(() => encodeEmbedding([1, NaN]), /embedding vector/);
  assert.throws(() => decodeEmbedding(bytes, 3), /embedding byte length/);
});

test("cosine similarity handles normalized and invalid vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /embedding vector/);
  assert.throws(() => cosineSimilarity([1], [1, 0]), /dimensions/);
});
