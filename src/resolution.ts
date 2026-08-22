import { createHash } from "node:crypto";
import type { DuplicateSignal, EvidenceSummary, KgNode } from "./types.js";

const lookup = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();

export function duplicatePairKey(a: string, b: string): string {
  return [a, b].sort().join("\u0000");
}

export function entityFingerprint(node: KgNode, evidence: EvidenceSummary[] = []): string {
  return createHash("sha256").update(JSON.stringify({
    type: node.type,
    name: node.name,
    aliases: [...node.aliases].sort(),
    description: node.description,
    evidence: evidence.map(item => [item.source, item.quote, item.confidence]).sort()
  })).digest("hex");
}

export function scoreDuplicatePair(a: KgNode, b: KgNode): { signals: DuplicateSignal[]; reasons: string[]; score: number } | undefined {
  if (a.id === b.id || a.type !== b.type) return undefined;
  const namesA = new Set([lookup(a.name), ...a.aliases.map(lookup)]);
  const namesB = new Set([lookup(b.name), ...b.aliases.map(lookup)]);
  const overlap = [...namesA].filter(value => value && namesB.has(value));
  if (overlap.length === 0) return undefined;
  const exactName = lookup(a.name) === lookup(b.name);
  const signals: DuplicateSignal[] = [{
    kind: exactName ? "name_exact" : "alias_exact",
    score: exactName ? 1 : .9,
    detail: overlap[0]
  }];
  return {
    signals,
    reasons: [exactName ? "Normalized names match exactly." : `Exact alias overlap: ${overlap[0]}.`],
    score: signals[0].score
  };
}
