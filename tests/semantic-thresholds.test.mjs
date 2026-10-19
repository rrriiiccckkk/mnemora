import assert from "node:assert/strict";
import test from "node:test";
import { embeddingModelKey, outsideModelLanguage, semanticThresholds } from "../dist/retrieval/semantic-thresholds.js";
import { normalizeConfig } from "../dist/config.js";

test("model keys drop Ollama tags and vendor prefixes", () => {
  assert.equal(embeddingModelKey("all-minilm:latest"), "all-minilm");
  assert.equal(embeddingModelKey("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"), "paraphrase-multilingual-minilm-l12-v2");
  assert.equal(embeddingModelKey(" BAAI/bge-small-zh-v1.5 "), "bge-small-zh-v1.5");
  assert.equal(embeddingModelKey(undefined), "");
});

test("calibrated models carry their own thresholds; unknown models get the all-MiniLM pair", () => {
  const pick = model => { const value = semanticThresholds(model); return [value.minSimilarity, value.gateSimilarity, value.englishOnly, value.calibrated]; };
  assert.deepEqual(pick("all-minilm"), [.45, .2, true, true]);
  assert.deepEqual(pick("sentence-transformers/all-MiniLM-L6-v2"), [.45, .2, true, true]);
  assert.deepEqual(pick("paraphrase-multilingual-MiniLM-L12-v2"), [.65, .3, false, true]);
  assert.deepEqual(pick("bge-small-zh-v1.5"), [.6, .45, false, true]);
  assert.deepEqual(pick("paraphrase-multilingual:latest"), [.65, .35, false, true]);
  assert.deepEqual(pick("nomic-embed-text"), [.45, .2, false, false]);
});

test("operator-set thresholds win over the model's calibration", () => {
  const value = semanticThresholds("bge-small-zh", { minSimilarity: .7 });
  assert.equal(value.minSimilarity, .7);
  assert.equal(value.gateSimilarity, .45);
  // Unset values stay unset in the normalized config, so the model decides.
  assert.equal(normalizeConfig({}).unifiedRetrieval.semantic.minSimilarity, undefined);
  assert.equal(normalizeConfig({ unifiedRetrieval: { semantic: { gateSimilarity: 3 } } }).unifiedRetrieval.semantic.gateSimilarity, 1);
});

test("an English-only model sits out prompts outside Latin script", () => {
  const english = semanticThresholds("all-minilm"), multilingual = semanticThresholds("bge-small-zh");
  assert.equal(outsideModelLanguage(english, "我对什么过敏？"), true);
  assert.equal(outsideModelLanguage(english, "What am I allergic to?"), false);
  assert.equal(outsideModelLanguage(multilingual, "我对什么过敏？"), false);
});
