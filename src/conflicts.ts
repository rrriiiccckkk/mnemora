import { createHash } from "node:crypto";
import { intervalsOverlap } from "./temporal.js";
import type { RelationshipType } from "./relationships.js";

export interface ConflictFact {
  edge_id: string;
  observation_id: string;
  source_id: string;
  target_id: string;
  confidence: number;
  source_count: number;
  valid_from: number | null;
  valid_to: number | null;
  scope: string;
}

export interface ConflictPair {
  id: string;
  pair_key: string;
  edge_a: string;
  edge_b: string;
  observation_a: string;
  observation_b: string;
  category: "overlapping_single_valued_facts";
  overlap_from: number | null;
  overlap_to: number | null;
  confidence_a: number;
  confidence_b: number;
  source_count_a: number;
  source_count_b: number;
  fingerprint_a: string;
  fingerprint_b: string;
  preview_hash: string;
}

export function detectConflictPairs(input: { relationshipType: RelationshipType; singleValued: boolean; scope?: string; facts: ConflictFact[] }): ConflictPair[] {
  if (!input.singleValued) return [];
  const scope = typeof input.scope === "string" && input.scope.length > 0 ? input.scope : "default";
  const facts = [...input.facts].sort((left, right) => left.observation_id.localeCompare(right.observation_id));
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    const a = facts[i], b = facts[j];
    if (a.source_id !== b.source_id || a.target_id === b.target_id || !intervalsOverlap(a, b)) continue;
    // `|` is excluded from normalized scopes and generated observation ids.
    // Avoid NUL: some SQLite bindings preserve it in JS but truncate it at the
    // SQL uniqueness boundary.
    const pair_key = `${scope}|${a.observation_id}|${b.observation_id}`;
    const fingerprint_a = factFingerprint(input.relationshipType, a);
    const fingerprint_b = factFingerprint(input.relationshipType, b);
    const category = "overlapping_single_valued_facts" as const;
    const preview_hash = hash([category, pair_key, fingerprint_a, fingerprint_b]);
    pairs.push({
      id: `conflict:${hash([scope, pair_key])}`, pair_key, edge_a: a.edge_id, edge_b: b.edge_id,
      observation_a: a.observation_id, observation_b: b.observation_id, category,
      overlap_from: maximumStart(a.valid_from, b.valid_from), overlap_to: minimumEnd(a.valid_to, b.valid_to),
      confidence_a: bounded(a.confidence), confidence_b: bounded(b.confidence),
      source_count_a: boundedCount(a.source_count), source_count_b: boundedCount(b.source_count),
      fingerprint_a, fingerprint_b, preview_hash
    });
  }
  return pairs;
}

function factFingerprint(type: RelationshipType, fact: ConflictFact): string {
  return hash([type, fact.edge_id, fact.observation_id, fact.source_id, fact.target_id, fact.valid_from, fact.valid_to, bounded(fact.confidence), boundedCount(fact.source_count)]);
}

function maximumStart(a: number | null, b: number | null): number | null { return a == null ? b : b == null ? a : Math.max(a, b); }
function minimumEnd(a: number | null, b: number | null): number | null { return a == null ? b : b == null ? a : Math.min(a, b); }
function bounded(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }
function boundedCount(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
