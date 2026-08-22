import assert from "node:assert/strict";
import test from "node:test";
import { hubPenalty, normalizeRankingWeights, rankQualityCandidates, sourceDiversityScore } from "../dist/ranking.js";
import { GraphologyStore } from "../dist/store.js";

test("source diversity and hub penalties follow bounded formulas", () => {
  assert.equal(sourceDiversityScore(0), 0);
  assert.equal(sourceDiversityScore(5), 1);
  assert.equal(sourceDiversityScore(2), Math.log1p(2) / Math.log1p(5));
  assert.equal(hubPenalty(10, 10, .6), 1);
  assert.equal(hubPenalty(20, 10, .6), .6);
  assert.equal(hubPenalty(Number.NaN, 10, .6), 1);
});

test("ranking weights normalize positive values and restore exact defaults when invalid", () => {
  assert.deepEqual(normalizeRankingWeights(), { semantic: .35, lexical: .20, confidence: .15, recency: .10, source_diversity: .05, ppr: .15 });
  assert.deepEqual(normalizeRankingWeights({ semantic: 2, lexical: 1, confidence: 1, recency: 0, source_diversity: 0, ppr: 0 }), { semantic: .5, lexical: .25, confidence: .25, recency: 0, source_diversity: 0, ppr: 0 });
  assert.deepEqual(normalizeRankingWeights({ semantic: -1, lexical: 0, confidence: 0, recency: 0, source_diversity: 0, ppr: 0 }), normalizeRankingWeights());
});

test("quality ranking exposes numeric components and applies each penalty once", () => {
  const [ranked] = rankQualityCandidates({
    now: Date.parse("2026-07-14T00:00:00Z"), halfLifeDays: 90, conflictFactor: .75, hubFloor: .6, degreeP95: 10,
    candidates: [{ id: "company:a", semantic: 1, lexical: .5, confidence: .8, reference_time: Date.parse("2026-04-15T00:00:00Z"), source_count: 5, ppr: .4, unresolved_conflict: true, degree: 20 }]
  });
  assert.equal(ranked.components.recency, .5);
  assert.equal(ranked.components.source_diversity, 1);
  assert.deepEqual(ranked.penalties, { conflict: .75, hub: .6 });
  assert.equal(ranked.score >= 0 && ranked.score <= 1, true);
  assert.doesNotMatch(JSON.stringify(ranked), /quote|payload/i);
});

test("exact lexical candidates remain protected from quality demotion", () => {
  const ranked = rankQualityCandidates({
    candidates: [
      { id: "exact", semantic: 0, lexical: 1, confidence: 0, reference_time: null, source_count: 0, ppr: 0, unresolved_conflict: true, degree: 100, exactLexical: true },
      { id: "other", semantic: 1, lexical: 0, confidence: 1, reference_time: Date.now(), source_count: 5, ppr: 1, unresolved_conflict: false, degree: 1 }
    ], degreeP95: 10
  });
  assert.equal(ranked.some(item => item.id === "exact"), true);
  assert.equal(ranked.find(item => item.id === "exact").score >= .2, true);
});

test("a result limit cannot evict exact lexical candidates", () => {
  const ranked = rankQualityCandidates({ limit: 2, weights: { semantic: 1, lexical: 0, confidence: 0, recency: 0, source_diversity: 0, ppr: 0 }, candidates: [
    { id: "exact", semantic: 0, lexical: 1, confidence: 0, reference_time: null, source_count: 0, ppr: 0, unresolved_conflict: false, degree: 0, exactLexical: true },
    ...[1, 2, 3].map(index => ({ id: `semantic:${index}`, semantic: 1, lexical: 0, confidence: 0, reference_time: null, source_count: 0, ppr: 0, unresolved_conflict: false, degree: 0 }))
  ] });
  assert.equal(ranked.length, 2);
  assert.equal(ranked.some(item => item.id === "exact"), true);
});

test("store quality summaries are bounded numeric metadata without evidence text", () => {
  const store = new GraphologyStore(":memory:");
  try {
    store.ingest([{ name: "Alice", type: "person", confidence: .9, evidence_span: "Alice" }, { name: "Acme", type: "company", confidence: .8, evidence_span: "Acme" }],
      [{ source: "Alice", target: "Acme", type: "works_at", confidence: .7, evidence_span: "secret quote", valid_from: 100, valid_to: 300 }], "source:one");
    store.ingest([{ name: "Acme", type: "company", confidence: 1, evidence_span: "Acme again" }], [], "source:two");
    const snapshot = store.qualityEvidenceSummaries(["company:acme"], 200);
    assert.equal(snapshot.items["company:acme"].source_count, 2);
    assert.equal(snapshot.items["company:acme"].confidence > 0, true);
    assert.equal(snapshot.items["company:acme"].reference_time > 0, true);
    assert.equal(snapshot.items["company:acme"].degree, 1);
    assert.equal(snapshot.degree_p95 >= 1, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|quote|payload/i);
  } finally { store.close(); }
});
