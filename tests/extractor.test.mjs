import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekExtractor, normalizeExtraction } from "../dist/extractor.js";

test("DeepSeekExtractor passes the supplied abort signal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = init.signal;
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"entities":[],"relations":[]}' } }] }) };
  };
  try {
    const extractor = new DeepSeekExtractor({ apiKey: "secret", baseURL: "https://example.test", model: "test" });
    controller.abort();
    await extractor.extract("text", "source", { signal: controller.signal });
    assert.equal(captured, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extraction prompt forbids related_to from representing co-occurrence", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"entities":[],"relations":[]}' } }] }) };
  };
  try {
    await new DeepSeekExtractor({ apiKey: "secret", baseURL: "https://example.test", model: "test" }).extract("A and B were mentioned.");
    assert.match(request.messages[0].content, /co-occurrence alone is not a relationship/i);
    assert.match(request.messages[0].content, /related_to.*explicit relationship/i);
    assert.match(request.messages[0].content, /Do not create entities for filenames, scripts/i);
    assert.match(request.messages[0].content, /Calibrate confidence/i);
    assert.doesNotMatch(request.messages[0].content, /"confidence":0\.9/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeekExtractor does not include provider response bodies in errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "provider secret" });
  try {
    const extractor = new DeepSeekExtractor({ apiKey: "secret", baseURL: "https://example.test", model: "test" });
    await assert.rejects(extractor.extract("text"), /^Error: LLM extraction failed: 401$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeekExtractor classifies malformed provider JSON without exposing it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"private":"provider secret"' } }] })
  });
  try {
    const extractor = new DeepSeekExtractor({ apiKey: "secret", baseURL: "https://example.test", model: "test" });
    await assert.rejects(extractor.extract("text"), (error) => {
      assert.equal(error.message, "LLM extraction returned invalid JSON");
      assert.equal(error.code, "INVALID_RESPONSE");
      assert.doesNotMatch(String(error), /provider secret/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeExtraction rejects operational artifacts instead of calling them products", () => {
  const result = normalizeExtraction({ entities: [
    { name: "AGENTS.md", type: "product", confidence: .95, evidence_span: "AGENTS.md" },
    { name: "sepa_scan.py", type: "tool", confidence: .95, evidence_span: "sepa_scan.py" },
    { name: "daily-check", type: "product", confidence: .95, evidence_span: "daily-check" },
    { name: "Mnemora", type: "product", confidence: .85, evidence_span: "Mnemora" }
  ], relations: [] });
  assert.deepEqual(result.entities.map(entity => entity.name), ["Mnemora"]);
});

test("normalizeExtraction keeps well-known dotted technology names while rejecting actual files", () => {
  const result = normalizeExtraction({ entities: [
    { name: "Node.js", type: "product", confidence: .9 },
    { name: "Next.js", type: "product", confidence: .9 },
    { name: "React.js", type: "product", confidence: .9 },
    { name: "build.js", type: "product", confidence: .9 }
  ], relations: [] });
  assert.deepEqual(result.entities.map(entity => entity.name), ["Node.js", "Next.js", "React.js"]);
});

test("DeepSeekExtractor rejects oversized provider bodies before JSON parsing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
  try {
    await assert.rejects(
      new DeepSeekExtractor({ apiKey:"secret",baseURL:"https://example.test",model:"test" }).extract("text"),
      error => error.code === "INVALID_RESPONSE" && !String(error).includes("xxxx")
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("normalizeExtraction keeps strict schema output", () => {
  const result = normalizeExtraction({
    entities: [
      { name: "Murata", type: "company", confidence: 0.95, evidence_span: "Murata supplies MLCC" }
    ],
    relations: [
      { source: "Murata", target: "MLCC", type: "supplies_product", confidence: 0.9, evidence_span: "Murata supplies MLCC" }
    ]
  });

  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].type, "company");
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].type, "supplies_product");
});

test("normalizeExtraction repairs common LLM field names and aliases", () => {
  const result = normalizeExtraction({
    entities: [
      { entity: "DeepSeek", entity_type: "Software", confidence: "0.82", evidence: "DeepSeek is used by Mnemora" },
      { label: "Mnemora", category: "Organization", quote: "DeepSeek is used by Mnemora" }
    ],
    relationships: [
      { subject: "Mnemora", object: "DeepSeek", predicate: "uses technology", confidence: "1.4", quote: "DeepSeek is used by Mnemora" }
    ]
  });

  assert.deepEqual(result.entities.map((entity) => [entity.name, entity.type, entity.confidence]), [
    ["DeepSeek", "product", 0.82],
    ["Mnemora", "company", 0.5]
  ]);
  assert.equal(result.entities[0].evidence_span, "DeepSeek is used by Mnemora");
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].source, "Mnemora");
  assert.equal(result.relations[0].target, "DeepSeek");
  assert.equal(result.relations[0].type, "uses");
  assert.equal(result.relations[0].confidence, 1);
});

test("normalizeExtraction drops unsupported or malformed facts", () => {
  const result = normalizeExtraction({
    entities: [
      { name: "MaybeCorp", type: "rumor", confidence: 0.8 },
      { name: "NoConfidence", type: "company", confidence: "not-a-number" }
    ],
    relations: [
      { source: "A", target: "B", type: "likes", confidence: 0.9 },
      { subject: "A", predicate: "works_for", confidence: 0.9 }
    ]
  });

  assert.deepEqual(result, { entities: [], relations: [], suggested_duplicates: undefined });
});

test("normalizeExtraction keeps only explicit strict temporal evidence", () => {
  const result = normalizeExtraction({
    entities: [{ name: "Nvidia", type: "company", confidence: .9, evidence_span: "since 2026", valid_from: "2026-01-01", temporal_confidence: .8 }],
    relations: [
      { source: "Nvidia", target: "AMD", type: "competes_with", confidence: .9, evidence_span: "during 2026", valid_to: "2026-12-31T23:59:59Z" },
      { source: "AMD", target: "Nvidia", type: "competes_with", confidence: .9, evidence_span: "ambiguous", valid_from: "01/02/2026" }
    ]
  });
  assert.deepEqual({ valid_from: result.entities[0].valid_from, valid_to: result.entities[0].valid_to, temporal_confidence: result.entities[0].temporal_confidence }, {
    valid_from: Date.parse("2026-01-01T00:00:00Z"), valid_to: null, temporal_confidence: .8
  });
  assert.equal(result.relations[0].valid_to, Date.parse("2026-12-31T23:59:59Z"));
  assert.equal("valid_from" in result.relations[1], false);
});
