import type { KgContextResult } from "../types.js";
import type { RetrievalCandidate } from "./types.js";
import { safeIdentifierMatchers } from "./query-routing.js";
import { joinHanSingles } from "./lexical.js";

export type InjectionSuppressionReason = "no_anchor_terms" | "no_anchor_match" | "below_relevance_floor";

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
  /** Relevance floor on `queryMatch` for each record; 0 or absent disables it. */
  minQueryMatch?: number;
  /**
   * Floor on `queryMatch` that at least one record must reach, outside any
   * semantic neighbourhood, for anything to be attached. It decides whether
   * the prompt is answered from memory at all, not which records go in.
   */
  gateQueryMatch?: number;
  /** A record whose semantic similarity reaches this floor needs no shared word. */
  minSemanticSimilarity?: number;
}): InjectionCandidateSelection {
  const anchors = queryAnchors([input.query, ...(input.alternates ?? [])]);
  // A tag-only or other exact local constraint deliberately has no free-text
  // anchor. Its candidate set was already narrowed by the retrieval SQL and
  // rechecked in-process, so withholding it here would make valid constrained
  // recall impossible while adding no precision protection.
  if (!anchors.length && input.exactLocalConstraint) return { candidates: diversify(input.candidates, input.maxItems, input.diversityLambda), suppressed: 0 };
  const semanticFloor = input.minSemanticSimilarity;
  const semantic = (candidate: RetrievalCandidate) => semanticFloor !== undefined && candidate.semanticSimilarity !== undefined && candidate.semanticSimilarity >= semanticFloor;
  if (!anchors.length) {
    const close = input.candidates.filter(semantic);
    return close.length ? { candidates: diversify(close, input.maxItems, input.diversityLambda), suppressed: input.candidates.length - close.length } : { candidates: [], suppressed: input.candidates.length, reason: "no_anchor_terms" };
  }
  const identifiers = safeIdentifierMatchers(input.query);
  const floor = Number.isFinite(input.minQueryMatch) ? Math.max(0, Math.min(1, input.minQueryMatch!)) : 0;
  const gateFloor = Math.max(floor, Number.isFinite(input.gateQueryMatch) ? Math.max(0, Math.min(1, input.gateQueryMatch!)) : 0);
  const hasIdentifier = (candidate: RetrievalCandidate) => {
    const content = `${candidate.title}\n${candidate.excerpt}`.toLocaleUpperCase();
    return identifiers.some(identifier => identifier.test(content));
  };
  // The floor drops records that share only common words with the prompt
  // (a long history matches almost any word somewhere). An exact technical
  // identifier is specific evidence on its own and is never floored.
  const passes = (candidate: RetrievalCandidate, minimum: number) => !minimum || candidate.queryMatch === undefined || candidate.queryMatch >= minimum;
  const relevant = (candidate: RetrievalCandidate) => semantic(candidate) || (identifiers.length > 0 && hasIdentifier(candidate)) || passes(candidate, floor);
  // The semantic neighbourhood and the gate floor decide whether memory is
  // attached at all: a prompt whose word matches all lie outside it is about
  // something else. Once one record clears that bar, the others are judged
  // on their own words, because a fact asked about in aggregate ("how many
  // doctors") often sits in a turn the embedding places far from the prompt
  // (LongMemEval multi-session: 47.9% answered with per-record gating,
  // 56.2% with this gate; foreign and off-topic prompts unchanged).
  const opensPacket = (candidate: RetrievalCandidate) => semantic(candidate) || (identifiers.length > 0 && hasIdentifier(candidate)) || !candidate.semanticallyDistant && passes(candidate, gateFloor);
  // A reply attached to a matching user turn is anchored through that turn:
  // "the restaurant you recommended" is answered by text that may share no
  // word with the prompt. It is only produced for assistant-recall prompts.
  const anchoredTurns = new Set(input.candidates.filter(candidate => candidate.selectionReason !== "reply_to_match" && (semantic(candidate) || containsAnchor(`${candidate.title}\n${candidate.excerpt}`, anchors))).map(candidate => candidate.contextRef));
  const anchored = input.candidates.filter(candidate => anchoredTurns.has(candidate.contextRef) || candidate.selectionReason === "reply_to_match" && anchoredTurns.size > 0);
  if (!anchored.length) return { candidates: [], suppressed: input.candidates.length, reason: "no_anchor_match" };
  const matched = anchored.filter(relevant);
  if (!matched.length || !matched.some(opensPacket)) return { candidates: [], suppressed: input.candidates.length, reason: "below_relevance_floor" };
  const exact = identifiers.length ? matched.filter(hasIdentifier) : [];
  // Diversify within exact task matches before considering generic history.
  // Otherwise final prompt packing can drop the only task completion after
  // MMR moves it behind less-overlapping, but unrelated, generic records.
  if (exact.length) {
    const refs = new Set(exact.map(candidate => candidate.contextRef));
    const selected = diversify(exact, input.maxItems, input.diversityLambda);
    const remaining = Math.max(0, Math.min(20, Math.trunc(input.maxItems)) - selected.length);
    if (remaining) selected.push(...diversify(matched.filter(candidate => !refs.has(candidate.contextRef)), remaining, input.diversityLambda));
    return { candidates: selected, suppressed: input.candidates.length - matched.length };
  }
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
  "什么", "介绍", "功能", "关于", "如何", "怎么", "工作", "系统", "记忆", "这个", "那个", "问题", "喜欢"
]);

function queryAnchors(queries: readonly string[]): string[] {
  const values = new Set<string>();
  for (const query of queries) for (const term of joinHanSingles(words(query).map(word => word.toLocaleLowerCase()))) {
    const value = term.toLocaleLowerCase();
    // A single Han character is commonly a pronoun, particle, or broad noun
    // (for example “我” or “茶”).  It is useful for manual candidate recall
    // but too weak to justify automatic prompt attachment.
    const minimumLength = /\p{Script=Han}/u.test(value) ? 2 : 3;
    if (!genericTerms.has(value) && value.length >= minimumLength) values.add(value);
  }
  const anchors = [...values].slice(0, 12);
  // Anchors match as substrings, so "wedding" already finds "weddings" but a
  // plural prompt ("how many weddings") would miss the singular record
  // ("a friend's wedding"). Each plural anchor also matches its singular.
  return [...new Set([...anchors, ...anchors.flatMap(singular)])];
}

/** Singular of a plain English plural ("babies" → "baby", "boxes" → "box"); none otherwise. */
function singular(value: string): string[] {
  if (!/^[a-z]{4,}$/u.test(value) || /(?:ss|us|is)$/u.test(value)) return [];
  if (value.endsWith("ies")) return [`${value.slice(0, -3)}y`];
  if (/(?:ches|shes|xes|zes|sses)$/u.test(value)) return [value.slice(0, -2)];
  return value.endsWith("s") ? [value.slice(0, -1)] : [];
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
