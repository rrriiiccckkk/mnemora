import type { KgContextResult } from "../types.js";
import type { RetrievalCandidate } from "./types.js";

export type InjectionSuppressionReason = "no_anchor_terms" | "no_anchor_match";

export interface InjectionCandidateSelection {
  candidates: RetrievalCandidate[];
  suppressed: number;
  reason?: InjectionSuppressionReason;
}

export interface GraphInjectionSelection {
  allowed: boolean;
  candidates: number;
  reason?: InjectionSuppressionReason;
}

/**
 * Automatic context attachment is deliberately stricter than manual search.
 * Retrieval may return a broad lexical candidate pool, but a candidate reaches
 * a prompt only when it shares a non-generic query anchor or clears the fixed
 * semantic floor. This is a read-time policy: it never changes stored facts.
 */
export function selectInjectionCandidates(input: {
  query: string;
  alternates?: readonly string[];
  candidates: readonly RetrievalCandidate[];
  maxItems: number;
  diversityLambda: number;
  /** An exact local metadata or content constraint already limited candidates. */
  exactLocalConstraint?: boolean;
}): InjectionCandidateSelection {
  const anchors = queryAnchors([input.query, ...(input.alternates ?? [])]);
  // A tag-only or other exact local constraint deliberately has no free-text
  // anchor. Its candidate set was already narrowed by the retrieval SQL and
  // rechecked in-process, so withholding it here would make valid constrained
  // recall impossible while adding no precision protection.
  if (!anchors.length && input.exactLocalConstraint) return { candidates: diversify(input.candidates, input.maxItems, input.diversityLambda), suppressed: 0 };
  if (!anchors.length) return { candidates: [], suppressed: input.candidates.length, reason: "no_anchor_terms" };
  const matched = input.candidates.filter(candidate => containsAnchor(`${candidate.title}\n${candidate.excerpt}`, anchors));
  if (!matched.length) return { candidates: [], suppressed: input.candidates.length, reason: "no_anchor_match" };
  return { candidates: diversify(matched, input.maxItems, input.diversityLambda), suppressed: input.candidates.length - matched.length };
}

/** A graph supplement may be attached only when its graph/memory candidates
 * prove an anchor match, or an embedding score clears a conservative floor. */
export function selectGraphInjection(input: {
  query: string;
  alternates?: readonly string[];
  context: KgContextResult;
}): GraphInjectionSelection {
  const candidates = input.context.nodes.length + (input.context.memories?.length ?? 0);
  if (!candidates) return { allowed: false, candidates };
  const anchors = queryAnchors([input.query, ...(input.alternates ?? [])]);
  if (!anchors.length) return { allowed: false, candidates, reason: "no_anchor_terms" };
  const lexicalMatch = input.context.nodes.some(item => containsAnchor(`${item.node.name}\n${item.node.description}\n${item.node.aliases.join("\n")}\n${item.evidence.map(evidence => evidence.quote).join("\n")}`, anchors))
    || (input.context.memories ?? []).some(item => containsAnchor(`${item.title}\n${item.excerpt}`, anchors));
  const semanticMatch = input.context.nodes.some(item => semanticScore(item) >= .72)
    || (input.context.memories ?? []).some(item => semanticScore(item) >= .72);
  return lexicalMatch || semanticMatch ? { allowed: true, candidates } : { allowed: false, candidates, reason: "no_anchor_match" };
}

const genericTerms = new Set([
  "a", "an", "and", "about", "does", "do", "explain", "for", "help", "how", "in", "is", "it", "me", "memory", "of", "on", "please", "system", "tell", "the", "to", "what", "with", "work",
  "什么", "介绍", "功能", "关于", "如何", "怎么", "工作", "系统", "记忆", "这个", "那个", "问题"
]);

function queryAnchors(queries: readonly string[]): string[] {
  const values = new Set<string>();
  for (const query of queries) for (const term of words(query)) {
    const value = term.toLocaleLowerCase();
    if (!genericTerms.has(value) && (value.length >= 3 || /\p{Script=Han}/u.test(value))) values.add(value);
  }
  return [...values].slice(0, 12);
}

function words(value: string): string[] {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(value)]
      .flatMap(segment => segment.isWordLike ? [segment.segment] : []);
  } catch {
    return value.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  }
}

function containsAnchor(value: string, anchors: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return anchors.some(anchor => normalized.includes(anchor));
}

function semanticScore(value: { score_components?: { semantic?: unknown } }): number {
  const score = Number(value.score_components?.semantic);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function diversify(candidates: readonly RetrievalCandidate[], maxItems: number, lambda: number): RetrievalCandidate[] {
  const limit = Math.max(1, Math.min(20, Math.trunc(maxItems)));
  const weight = Number.isFinite(lambda) ? Math.max(0, Math.min(1, lambda)) : 1;
  const remaining = [...candidates].sort((left, right) => right.score - left.score || left.contextRef.localeCompare(right.contextRef));
  if (weight >= 1 || remaining.length <= 1) return remaining.slice(0, limit);
  const selected: RetrievalCandidate[] = [];
  while (remaining.length && selected.length < limit) {
    let index = 0, best = -Infinity;
    for (let candidateIndex = 0; candidateIndex < remaining.length; candidateIndex++) {
      const candidate = remaining[candidateIndex];
      const overlap = selected.length ? Math.max(...selected.map(item => jaccard(candidate, item))) : 0;
      const score = weight * candidate.score - (1 - weight) * overlap;
      if (score > best || score === best && candidate.contextRef.localeCompare(remaining[index].contextRef) < 0) { best = score; index = candidateIndex; }
    }
    selected.push(remaining.splice(index, 1)[0]);
  }
  return selected;
}

function jaccard(left: RetrievalCandidate, right: RetrievalCandidate): number {
  const terms = (candidate: RetrievalCandidate) => new Set(words(`${candidate.title}\n${candidate.excerpt}`).map(term => term.toLocaleLowerCase()).filter(term => term.length >= 3 && !genericTerms.has(term)).slice(0, 128));
  const a = terms(left), b = terms(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  return shared / (a.size + b.size - shared);
}
