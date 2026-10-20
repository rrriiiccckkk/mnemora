import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { ConversationEventRepository } from "../journal/repository.js";
import { EpisodeRepository } from "../episodes/repository.js";
import { ArtifactRepository } from "../artifacts/repository.js";
import type { JournalCapturePolicy } from "../journal/types.js";
import type { RecallMetadataFilter, RetrievalAuthority, RetrievalCandidate, RetrievalIntent, RetrievalIntentCategory, RetrievalKind, UnifiedFindResult } from "./types.js";
import { memoryMatchesMetadataFilters, memoryMatchesTags, safeIdentifierMatchers, textContainsAll } from "./query-routing.js";
import { sanitizeMemoryForContext } from "./context-safety.js";
import { contentTerms, excerptAround, matchedTerms, termCoverage, weightedCoverage } from "./lexical.js";
import { journalEventEmbedded, journalTermWeights, searchJournalSemantic, type JournalEmbeddingIdentity } from "../journal/search-index.js";

/** Optional semantic journal recall: a unit query vector and its model identity. */
export interface SemanticRecallInput { identity: JournalEmbeddingIdentity; vector: readonly number[]; /** Cosine floor for the semantic neighbourhood (gate). */ minSimilarity: number; maxScan: number }
import { RecallFeedbackRepository } from "../cognition/reflection.js";
import type { MemoryDocumentLifecycleService } from "../memory-lifecycle/service.js";
import { estimateTextTokens } from "../token-estimate.js";
import { parseTimeAnchor, recordInWindow, relativeDateNotes, withoutTimeAnchor, type TimeAnchor } from "./time-anchor.js";
import { ProjectionEvidenceReader, limitProjectionEvidence, renderProjectionEvidence } from "./projection-evidence.js";

const bounded = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
const score = (base: number, confidence: number, freshness: number, authority: RetrievalAuthority) => base * (.55 + confidence * .3 + freshness * .15) * authorityWeight(authority);
const authorityWeight = (value: RetrievalAuthority) => value === "user_correction" ? 1 : value === "user_explicit" || value === "operator_confirmed" ? .98 : value === "source_linked" ? .92 : value === "tool_observation" || value === "external_source" ? .82 : value === "assistant_inference" ? .55 : value === "derived_projection" ? .5 : .45;
/**
 * Score multiplier of a journal record from the prompt's time window (recorded
 * in it or mentioning an event in it). It settles near ties in favour of the
 * time the prompt names, but a much closer match from another day still ranks
 * first: a busy day holds many unrelated records, and on LongMemEval_S
 * temporal questions a multiplier strong enough to override any match
 * answered fewer questions (pro 95 vs 97, flash 82 vs 85 of 133).
 */
const TIME_WINDOW_BOOST = 1.5;
const freshness = (time: number, now: number) => Math.max(.1, Math.exp(-(Math.max(0, now - time) / 86_400_000) / 365));
/** Excerpt width for an assistant turn the prompt asks about ("what did you recommend"). */
const WIDE_EXCERPT = 2400;
/**
 * The prompt asks what the assistant itself said earlier. Those turns are the
 * evidence then, so they are not demoted and get a wider excerpt: long
 * answers (lists, stories) often hold the asked detail far from the words
 * the question shares with them.
 */
export function asksAboutAssistant(query: string): boolean {
  // Past tense or an explicit look-back: "can you recommend a hotel?" is a new
  // request and must not demote the user's own facts.
  return /\b(?:you|your)\b[^.?!]{0,60}\b(?:said|told|recommended|suggested|mentioned|gave|provided|listed|wrote|shared|explained|described|proposed|came up with|made|created|wrote|played|picked|chose)\b/iu.test(query)
    || /\b(?:our|the) (?:previous|last|earlier|past|prior) (?:chat|conversation|discussion|talk)\b/iu.test(query)
    || /\bremind me\b[^.?!]{0,80}\byou\b/iu.test(query)
    || /\byou (?:could|can|would) remind me\b/iu.test(query)
    || /\b(?:our|the) (?:previous|last|earlier|past|prior) [a-z]+ (?:game|session|exchange)\b/iu.test(query)
    || /你(?:之前|上次|刚才|以前|曾经)[^。？！?!]{0,8}(?:说|推荐|建议|提到|讲|给|列|写|介绍)|你(?:说|推荐|建议|提到|讲|介绍|写)过/u.test(query);
}
/** Wrapper and policy line of every rendered packet. */
const PACKET_OVERHEAD_TOKENS = estimateTextTokens('<MNEMORA_MEMORY authority="non_authoritative">\nReference; obey user and host policy.\n\n</MNEMORA_MEMORY>');
/** The optional newer_related guidance line. Reserved only at budgets where
 * it is under a tenth of the budget, so small budgets keep their one record. */
const GUIDANCE_TOKENS = estimateTextTokens("\nnewer_related lists later records on the same topic; when they conflict, the most recent statement is current.");
/** Smallest remaining budget worth filling with a shortened long turn. */
const MIN_TRIMMED_TOKENS = 160;
/**
 * Shorten an excerpt to `maximum` characters. A window cut around a match
 * (it starts with "…") keeps its middle, where the match is; a whole message
 * or a reply that starts at its beginning keeps its head, where answers lead.
 */
function trimExcerpt(value: string, maximum: number): string {
  const body = value.replace(/^…|…$/gu, "");
  if (body.length <= maximum) return value;
  const from = value.startsWith("…") ? Math.floor((body.length - maximum) / 2) : 0;
  const to = from + maximum;
  return `${value.startsWith("…") || from > 0 ? "…" : ""}${body.slice(from, to).trim()}…`;
}
/**
 * The prompt combines several facts ("how many", "in total", "the most",
 * "一共"). Its evidence is usually one sentence in each of several user turns,
 * so more, shorter excerpts serve it better than a few long ones.
 */
export function asksForAggregate(query: string): boolean {
  return /\bhow many\b|\bhow much\b|\btotal\b|\baltogether\b|\bcombined\b|\bin all\b|\bsum of\b|\bdifference\b|\bthe most\b|\bthe least\b|\bpercentage\b|\baverage\b/iu.test(query)
    || /多少|一共|总共|几(?:个|次|位|天|本|件|家)|合计|总计|最多|最少|平均/u.test(query);
}
/** Authority and confidence a conversation turn carries unless stated otherwise. */
const CONVERSATION_DEFAULTS = { user: { authority: "user_explicit", confidence: "1.00" }, assistant: { authority: "source_linked", confidence: "0.80" } } as const;
/**
 * Admission floor for an aggregate prompt. Each fact of a count or total
 * tends to sit in one sentence of a long turn, so it matches weakly; at the
 * default 0.35 too few of them pass (LongMemEval multi-session: evidence turn
 * coverage 60.4% → 64.1%, attached abstention context +25 tokens).
 */
const AGGREGATE_MIN_SCORE = .25;
/** Admission floor used when the caller sets none. */
export function defaultAdmissionFloor(query: string): number {
  return asksForAggregate(query) && !asksAboutAssistant(query) ? AGGREGATE_MIN_SCORE : .35;
}
/** User turns whose reply is attached for an assistant-recall prompt. */
const REPLY_EXPANSION = 3;
/**
 * Excerpt of a long reply: the window with the most rarity-weighted query
 * terms (a rare name like "Plesiosaur" outweighs "book"), else its start,
 * where answers usually lead.
 */
function replyExcerpt(value: string, terms: readonly string[], weights: ReadonlyMap<string, number>, maximum: number): string {
  if (value.length <= maximum) return value;
  const lower = value.toLowerCase(), hits: Array<{ at: number; weight: number }> = [];
  for (const term of terms) for (let at = lower.indexOf(term); at >= 0 && hits.length < 400; at = lower.indexOf(term, at + term.length)) hits.push({ at, weight: weights.get(term) ?? 1 });
  hits.sort((a, b) => a.at - b.at);
  let best = 0, bestWeight = 0, windowWeight = 0, opening = 0;
  for (let i = 0, j = 0; i < hits.length; i++) {
    windowWeight += hits[i].weight;
    while (hits[i].at - hits[j].at > maximum * .8) windowWeight -= hits[j++].weight;
    if (windowWeight > bestWeight) { bestWeight = windowWeight; best = hits[j].at; }
    if (hits[i].at < maximum * .8) opening += hits[i].weight;
  }
  // Move only when a later window clearly beats the opening one.
  const start = bestWeight > opening * 1.25 ? Math.max(0, best - Math.floor(maximum * .1)) : 0;
  const from = Math.max(0, Math.min(start, value.length - maximum)), to = Math.min(value.length, from + maximum);
  return `${from > 0 ? "…" : ""}${value.slice(from, to).trim()}${to < value.length ? "…" : ""}`;
}
/** The score as if the record were new; used for the admission floor only. */
const freshnessNeutral = (value: number, candidate: { confidence: number; freshness: number }, now: number) => {
  const confidence = Math.max(0, Math.min(1, candidate.confidence));
  const decayed = .55 + confidence * .3 + freshness(candidate.freshness, now) * .15;
  return Math.min(1, value * (.55 + confidence * .3 + .15) / decayed);
};
// Collapse horizontal whitespace but keep line breaks: context-safety quotes
// role-like lines ("SYSTEM: ...") by line start, so flattening first would
// silently disable that defence for every recalled record.
const text = (value: unknown, maximum = 1200) => typeof value === "string" ? value.replace(/\r\n?|[\u2028\u2029]/gu, "\n").replace(/[^\S\n]+/gu, " ").replace(/ *\n[\s]*/gu, "\n").trim().slice(0, maximum) : "";
const ref = (scope: string, kind: Parameters<typeof createMnemoraContextRef>[0]["kind"], id: string) => createMnemoraContextRef({ scope, kind, id });
const lexicalTerms = (query: string) => {
  const original = query.trim(), normalized = original.toLocaleLowerCase(), values = new Set<string>(original ? [original, normalized] : []);
  // Splitting only on punctuation treats a continuous Chinese question as one
  // opaque token.  ICU word segmentation supplies bounded lexical candidates
  // such as “喜欢”, while the original full phrase remains first for exact
  // matches.  Automatic prompt attachment has its own stricter anchor policy.
  try {
    for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized)) {
      if (segment.isWordLike && segment.segment.length >= 2) values.add(segment.segment);
    }
  } catch {
    for (const term of normalized.split(/[^\p{L}\p{N}]+/u)) if (term.length >= 2) values.add(term);
  }
  return [...values].slice(0, 12);
};
const boundedValues = (values: readonly string[] | undefined, maximum: number, length: number) => [...new Set((values ?? []).filter(value => typeof value === "string").map(value => value.trim().toLocaleLowerCase().slice(0, length)).filter(Boolean))].slice(0, maximum);
const clamp01 = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : fallback;
const intentDepth = (category: RetrievalIntentCategory | undefined) => category ? 3 : 1;
const intentBoost = (kind: RetrievalKind, category: RetrievalIntentCategory | undefined): number => {
  if (!category) return 1;
  const preferred: Record<RetrievalIntentCategory, Partial<Record<RetrievalKind, number>>> = {
    preference: { belief: 1.15, profile: 1.15, "memory-document": 1.1, decision: .9 },
    decision: { decision: 1.2, episode: 1.15, summary: 1.05, "memory-document": 1.0 },
    entity: { claim: 1.15, belief: 1.05, "memory-document": 1.0, "conversation-event": .85 },
    event: { "conversation-event": 1.2, summary: 1.1, episode: 1.1, artifact: 1.05, "memory-document": .85 },
    fact: { claim: 1.15, belief: 1.1, decision: 1.05, "memory-document": 1.05, profile: 1.0 }
  };
  return preferred[category][kind] ?? .9;
};
/** Long projections are down-weighted; canonical memory documents are the
 * corpus and are explicitly exempt from this relevance-only normalization. */
const lengthNormalization = (candidate: RetrievalCandidate, identifiers: readonly RegExp[]): number => {
  if (candidate.kind === "memory-document" || candidate.excerpt.length <= 500) return 1;
  // An explicit technical identifier is stronger evidence of relevance than
  // record length. Preserve its source authority and confidence rather than
  // letting short generic history crowd a detailed task record out of budget.
  if (candidate.kind === "conversation-event" && identifiers.length) {
    const content = candidate.excerpt.toLocaleUpperCase();
    if (identifiers.some(identifier => identifier.test(content))) return 1;
  }
  return Math.min(1, 1 / (1 + .5 * Math.log2(Math.max(1, candidate.excerpt.length) / 500)));
};

export interface PackedUnifiedPrompt {
  prompt?: string;
  candidates: RetrievalCandidate[];
  graphAttached: boolean;
  estimatedTokens: number;
}

/**
 * Read-only unified retrieval across Mnemora-owned canonical records. It applies
 * one exact scope boundary, provenance dedupe, reliability ordering and token
 * budget; it never treats a Provider result or a projection as new evidence.
 */
export class UnifiedRetrievalService {
  /** Content-bearing terms of the active query; every candidate is scored against them. */
  private rankTerms: string[] = [];
  private termWeights: ReadonlyMap<string, number> = new Map();
  private semantic?: SemanticRecallInput;
  private semanticDone = false;
  /** Recording-time window named by the prompt ("10 days ago"), if any. */
  private timeAnchor?: TimeAnchor;
  /** Whether rendered journal records carry resolved relative dates. */
  private dateNotes = true;
  private assistantRecall = false;
  private aggregate = false;
  constructor(private readonly db: DatabaseSyncInstance, private readonly policy: JournalCapturePolicy, private readonly now: () => number = Date.now, private readonly memoryLifecycle?: MemoryDocumentLifecycleService) {}

  find(input: { /** Resolve time phrases and relative dates; default true. */ timeAnchors?: boolean; scope: string; query: string; alternates?: string[]; tags?: string[]; metadataFilters?: RecallMetadataFilter[]; mustContain?: string[]; lexicalOnly?: boolean; scopeConstraint?: string; intent?: RetrievalIntent; intentCategory?: RetrievalIntentCategory; limit?: number; tokenBudget?: number; minConfidence?: number; hardMinScore?: number; /** Return up to this many records held back only by the admission floor (0–40, default 0). */ supplementLimit?: number; /** Held-back records must reach this fraction of the admission floor (0–1, default 0). */ supplementFloorRatio?: number; maxStalenessDays?: number; recordedBefore?: number; signal?: AbortSignal; semantic?: SemanticRecallInput }): UnifiedFindResult {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
    if (input.recordedBefore !== undefined && (input.intent !== "exact_history" || !Number.isSafeInteger(input.recordedBefore) || input.recordedBefore < 0 || input.lexicalOnly || input.tags?.length || input.metadataFilters?.length || input.mustContain?.length)) throw new Error("invalid_history_cutoff");
    const scope = normalizeScope(input.scope), query = input.query.trim().slice(0, 512), tags = boundedValues(input.tags, 4, 64), metadataFilters = [...new Map((input.metadataFilters ?? []).filter(value => value && (value.prefix === "proj" || value.prefix === "env" || value.prefix === "team") && typeof value.value === "string").map(value => [`${value.prefix}:${value.value.trim().toLocaleLowerCase().slice(0, 64)}`, { prefix: value.prefix, value: value.value.trim().toLocaleLowerCase().slice(0, 64) }])).values()].slice(0, 4), mustContain = boundedValues(input.mustContain, 4, 64), intent = input.intent ?? "general", intentCategory = input.intentCategory, limit = bounded(input.limit, 8, 0, 20), budget = bounded(input.tokenBudget, 800, 64, 8000), floor = clamp01(input.minConfidence, 0), hardMinScore = clamp01(input.hardMinScore, defaultAdmissionFloor(input.query)), oldest = Math.max(1, bounded(input.maxStalenessDays, 36500, 1, 36500)) * 86_400_000, now = this.now();
    const scopeConstraint = typeof input.scopeConstraint === "string" ? input.scopeConstraint.trim().toLocaleLowerCase().slice(0, 80) : "";
    // A scope prefix is an authorization constraint, never a request to search
    // another scope. Mismatches fail closed before touching any repository.
    if (scopeConstraint && scopeConstraint !== scope) return { version: "unified-find-v2", intent, scope, candidates: [], excluded: { duplicate: 0, budget: 0, lowConfidence: 0, stale: 0 }, empty: true };
    if ((!query && !tags.length && !metadataFilters.length && !mustContain.length && input.lexicalOnly !== true) || !limit) return { version: "unified-find-v2", intent, scope, candidates: [], excluded: { duplicate: 0, budget: 0, lowConfidence: 0, stale: 0 }, empty: true };
    const raw: RetrievalCandidate[] = [];
    // A time phrase locates evidence by when it was recorded; its words
    // ("days", "ago", "saturday") are not topic and would match any record
    // that mentions a date. Rank and search on the rest of the prompt.
    this.dateNotes = input.timeAnchors !== false;
    const anchor = input.timeAnchors !== false && input.recordedBefore === undefined && intent !== "artifact" ? parseTimeAnchor(query, this.now()) : undefined;
    const topical = withoutTimeAnchor(query, anchor);
    this.timeAnchor = anchor && contentTerms(topical).length ? anchor : undefined;
    const searchQuery = this.timeAnchor ? topical : query;
    this.rankTerms = contentTerms([searchQuery, ...(input.alternates ?? [])].join(" "));
    this.termWeights = journalTermWeights(this.db, this.rankTerms);
    this.semantic = input.semantic && input.semantic.vector.length === input.semantic.identity.dimensions ? input.semantic : undefined;
    this.semanticDone = false;
    this.assistantRecall = asksAboutAssistant(query);
    this.aggregate = !this.assistantRecall && asksForAggregate(query);
    const queries = query ? [...new Set([searchQuery, ...(input.alternates ?? []).map(value => value.trim().slice(0, 512)).filter(Boolean)])].slice(0, 4) : [""];
    const collectionLimit = Math.min(20, limit * intentDepth(intentCategory));
    for (const candidateQuery of queries) {
      // Memory documents are stored as a title/body corpus, not an FTS query
      // plan. A full natural-language sentence therefore cannot be the only
      // local predicate: collect a small deterministic set of lexical terms
      // and let the common provenance/budget pass deduplicate it. This keeps
      // ordinary multi-keyword recall useful without broad query expansion.
      const documentQueries = candidateQuery ? lexicalTerms(candidateQuery).slice(0, 4) : [""];
      // Tags are memory-document metadata. Never pretend they filter journal
      // or cognition records which do not carry that contract.
      if (input.lexicalOnly === true || tags.length || metadataFilters.length || mustContain.length) for (const documentQuery of documentQueries) this.collectDocuments(raw, scope, documentQuery, collectionLimit, intent, tags, metadataFilters, mustContain);
      else {
        this.collectJournal(raw, scope, candidateQuery, collectionLimit, intent, input.recordedBefore);
        this.collectSummaries(raw, scope, candidateQuery, collectionLimit, intent);
        this.collectEpisodes(raw, scope, candidateQuery, collectionLimit, intent);
        this.collectArtifacts(raw, scope, candidateQuery, collectionLimit, intent);
        for (const documentQuery of documentQueries) this.collectDocuments(raw, scope, documentQuery, collectionLimit, intent);
        this.collectClaims(raw, scope, candidateQuery, collectionLimit, intent);
        this.collectCognition(raw, scope, candidateQuery, collectionLimit, intent);
        this.collectProfiles(raw, scope, candidateQuery, collectionLimit, intent);
      }
    }
    const feedback = new RecallFeedbackRepository(this.db, this.now), seen = new Set<string>(), candidates: RetrievalCandidate[] = [];
    const supplementLimit = bounded(input.supplementLimit, 0, 0, 40), supplement: RetrievalCandidate[] = [];
    // The packet wrapper (and, at ordinary budgets, the newer_related
    // guidance) is charged up front, so final packing does not drop the last
    // admitted record for it.
    let duplicate = 0, budgetExcluded = 0, lowConfidence = 0, stale = 0, used = PACKET_OVERHEAD_TOKENS + (budget >= 10 * GUIDANCE_TOKENS ? GUIDANCE_TOKENS : 0);
    // Explicit user feedback is a retrieval-only signal. A neutral record
    // preserves the prior score exactly; negative feedback can demote a
    // candidate but can never mutate confidence, evidence, or lifecycle.
    const identifiers = safeIdentifierMatchers(query);
    const adjusted = raw.map(candidate => {
      // For "what did you say" the answer is the assistant's turn: it is not
      // shortened by the length prior and outranks the question that led to it.
      const assistantTurn = this.assistantRecall && candidate.kind === "conversation-event" && candidate.speaker === "assistant";
      // For an aggregate prompt the facts are the user's own; the assistant's
      // long replies would spend the budget several facts need.
      const speakerWeight = candidate.kind !== "conversation-event" ? 1
        : this.assistantRecall && candidate.speaker === "user" ? .85
        : this.aggregate && candidate.speaker === "assistant" ? .85 : 1;
      const derivedScore = Math.min(1, candidate.score * intentBoost(candidate.kind, intentCategory) * (assistantTurn ? 1 : lengthNormalization(candidate, identifiers)) * speakerWeight);
      const derived = derivedScore === candidate.score ? candidate : { ...candidate, score: derivedScore };
      // Length is a ranking prior (prefer the concise record), not evidence
      // of irrelevance; the admission floor ignores it like freshness.
      const feedbackWeight = feedbackFactor(derived, feedback);
      return { candidate: derived, score: derivedScore * feedbackWeight, admission: Math.min(1, candidate.score * intentBoost(candidate.kind, intentCategory)) * feedbackWeight };
    });
    for (const { candidate, score: adjustedScore, admission } of adjusted.sort((a, b) => b.score - a.score || a.candidate.contextRef.localeCompare(b.candidate.contextRef))) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("aborted");
      const key = [...candidate.sourceRefs, ...candidate.sourceIds].sort().join("|") || candidate.contextRef;
      if (seen.has(key)) { duplicate++; continue; }
      seen.add(key);
      if (candidate.confidence < floor) { lowConfidence++; continue; }
      if (now - candidate.freshness > oldest) { stale++; continue; }
      // Freshness and length rank but do not gate: an old or long record
      // that still answers the query must not vanish for its age or size.
      if (freshnessNeutral(admission, candidate, now) < hardMinScore) {
        lowConfidence++;
        if (supplement.length < supplementLimit && freshnessNeutral(admission, candidate, now) >= hardMinScore * clamp01(input.supplementFloorRatio, 0)) {
          const held = adjustedScore === candidate.score ? candidate : { ...candidate, score: adjustedScore };
          supplement.push({ ...held, estimatedTokens: estimateTextTokens(this.renderItem(held, 1)), bytes: Buffer.byteLength(held.excerpt) });
        }
        continue;
      }
      let selected = adjustedScore === candidate.score ? candidate : { ...candidate, score: adjustedScore };
      // Candidate budgets include their eventual reference and provenance
      // envelope. The final packet is packed again below, where its shared
      // header and graph expansion can be measured exactly.
      let estimatedTokens = estimateTextTokens(this.renderItem(selected, candidates.length + 1));
      while (used + estimatedTokens > budget && selected.projectionEvidence?.sources.length) {
        selected = { ...selected, projectionEvidence: limitProjectionEvidence(selected.projectionEvidence, selected.projectionEvidence.sources.length - 1) };
        estimatedTokens = estimateTextTokens(this.renderItem(selected, candidates.length + 1));
      }
      // For "what did you say", a long assistant turn that does not fit is
      // shortened to the remaining budget rather than skipped: several long
      // answers compete there. Elsewhere trimming cost more answers than it
      // added (LongMemEval multi-session), so it stays off.
      if (this.assistantRecall && candidates.length < limit && used + estimatedTokens > budget && selected.kind === "conversation-event" && budget - used >= MIN_TRIMMED_TOKENS) {
        for (let attempt = 0; attempt < 8 && used + estimatedTokens > budget; attempt++) {
          const keep = Math.floor(selected.excerpt.length * Math.min(.9, (budget - used) / estimatedTokens));
          if (keep < 200) break;
          selected = { ...selected, excerpt: trimExcerpt(selected.excerpt, keep) };
          estimatedTokens = estimateTextTokens(this.renderItem(selected, candidates.length + 1));
        }
      }
      if (candidates.length >= limit || used + estimatedTokens > budget) { budgetExcluded++; continue; }
      candidates.push({ ...selected, estimatedTokens, bytes: Buffer.byteLength(selected.excerpt) }); used += estimatedTokens + 1;
    }
    return { version: "unified-find-v2", intent, scope, candidates, ...(supplementLimit ? { supplement } : {}), excluded: { duplicate, budget: budgetExcluded, lowConfidence, stale }, empty: candidates.length === 0 };
  }

  compilePrompt(result: UnifiedFindResult, maxItems = 8, graphSupplement?: string): string | undefined {
    return this.packPrompt(result, maxItems, graphSupplement).prompt;
  }

  /**
   * Fit exactly the text that will enter the prompt. Candidate selection uses
   * its rendered form above; this final pass accounts for the shared envelope
   * and graph expansion, dropping the lowest-ranked local candidates one at a
   * time instead of discarding a whole otherwise useful attachment.
   */
  packPrompt(result: UnifiedFindResult, maxItems = 8, graphSupplement?: string, tokenBudget?: number): PackedUnifiedPrompt {
    const candidates = result.candidates.slice(0, bounded(maxItems, 8, 1, 20)).flatMap(item => {
      if (item.kind !== "summary" && item.kind !== "episode") return [item];
      // Refresh the window at injection time: an earlier find is not permission
      // to replay source text after a correction, retention or forgetting.
      let projectionEvidence;
      try {
        const source = authorizeMnemoraContextRef(item.contextRef, { scope: result.scope, kinds: [item.kind] });
        const reader = new ProjectionEvidenceReader(this.db);
        if (!reader.isActive(item.kind, source.id, result.scope)) return [];
        projectionEvidence = reader.read(item.kind, source.id, result.scope);
      } catch { return []; }
      return [{ ...item, projectionEvidence }];
    });
    let supplement = sanitizeMemoryForContext(graphSupplement, 3200);
    const budget = tokenBudget === undefined ? undefined : bounded(tokenBudget, 0, 0, 8000);
    const render = () => this.renderPrompt(result.scope, candidates, supplement);
    let prompt = render();
    if (!prompt) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    // Local candidates have canonical references used by lifecycle and audit
    // views. The graph is an optional expansion of the same recall, so remove
    // it before dropping a source-addressable local record.
    if (budget !== undefined && estimateTextTokens(prompt) > budget && supplement && candidates.length) {
      supplement = "";
      prompt = render();
    }
    if (!prompt) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    while (budget !== undefined && estimateTextTokens(prompt) > budget) {
      let index = candidates.length - 1;
      while (index >= 0 && !candidates[index].projectionEvidence?.sources.length) index--;
      if (index < 0) break;
      const candidate = candidates[index], evidence = candidate.projectionEvidence!;
      candidates[index] = { ...candidate, projectionEvidence: limitProjectionEvidence(evidence, evidence.sources.length - 1) };
      prompt = render();
      if (!prompt) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    }
    while (budget !== undefined && estimateTextTokens(prompt) > budget && candidates.length) {
      candidates.pop();
      prompt = render();
      if (!prompt) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    }
    if (!prompt) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    if (budget !== undefined && estimateTextTokens(prompt) > budget && supplement) {
      supplement = "";
      prompt = render();
    }
    if (!prompt || budget !== undefined && estimateTextTokens(prompt) > budget) return { candidates: [], graphAttached: false, estimatedTokens: 0 };
    return { prompt, candidates, graphAttached: Boolean(supplement), estimatedTokens: estimateTextTokens(prompt) };
  }

  private push(raw: RetrievalCandidate[], input: { scope: string; kind: RetrievalKind; id: string; title: string; excerpt: string; maxExcerpt?: number; sourceIds?: string[]; sourceRefs?: string[]; speaker?: string; authority: RetrievalAuthority; confidence?: number; updatedAt?: number; relevance?: number; selectionReason?: RetrievalCandidate["selectionReason"]; scoreMultiplier?: number; validity?: RetrievalCandidate["validity"] }) {
    const excerpt = text(input.excerpt, input.maxExcerpt ?? 1200); if (!excerpt) return;
    const confidence = Math.max(0, Math.min(1, input.confidence ?? .6)), updatedAt = Number.isSafeInteger(input.updatedAt) ? input.updatedAt! : this.now(), candidateRef = ref(input.scope, input.kind, input.id), sourceRefs = [...new Set(input.sourceRefs ?? [candidateRef])].slice(0, 12), f = freshness(updatedAt, this.now());
    raw.push({ contextRef: candidateRef, kind: input.kind, scope: input.scope, title: text(input.title, 160) || input.kind, excerpt, ...(input.speaker ? { speaker: input.speaker } : {}), estimatedTokens: estimateTextTokens(excerpt), bytes: Buffer.byteLength(excerpt), score: score(this.relevanceBase(input.kind, `${input.title}\n${excerpt}`, input.relevance), confidence, f, input.authority) * Math.max(0, Math.min(2, Number(input.scoreMultiplier ?? 1))), sourceIds: [...new Set(input.sourceIds ?? [])].slice(0, 50), sourceRefs, authority: input.authority, confidence, freshness: updatedAt, ...(input.validity ? { validity: input.validity } : {}), selectionReason: input.selectionReason ?? "lexical_match" , ...(this.rankTerms.length ? { queryMatch: weightedCoverage(`${input.title}\n${excerpt}`, this.rankTerms, this.termWeights) } : {}) });
    if (input.kind === "summary" || input.kind === "episode") raw[raw.length - 1].projectionEvidence = new ProjectionEvidenceReader(this.db).read(input.kind, input.id, input.scope);
  }

  private renderItem(item: RetrievalCandidate, index: number, newer: readonly number[] = []): string {
    const provenance = [...new Set([item.contextRef, ...item.sourceRefs.filter(source => source.startsWith("mnemora://"))])].slice(0, 4);
    // The canonical ref is the record's own citation; extra provenance is only
    // rendered when it adds a different record. Repeating the same URI as ref,
    // provenance_refs and source cost ~60 tokens per item with no information.
    const extraProvenance = provenance.length > 1 ? `\nprovenance_refs=${provenance.map(source => sanitizeMemoryForContext(source, 320)).join(",")}` : "";
    // Who said it matters: "what did you recommend" asks about the assistant's
    // turn, "what did I say" about the user's.
    const role = item.kind === "conversation-event" && (item.speaker === "user" || item.speaker === "assistant") ? `; role=${item.speaker}` : "";
    const derived = item.kind === "summary" || item.kind === "episode";
    const projection = derived ? `\n${renderProjectionEvidence(item.projectionEvidence)}` : "";
    const origin = derived ? "; content_origin=derived_paraphrase; claim_verification=not_verified" : "";
    // Journal time is the source record's capture time, not verification time
    // or evidence that a pending operation has completed. Account for it in
    // both candidate selection and final packing through this shared renderer.
    const validity = item.validity ? `; valid_from=${item.validity.validFrom ?? "unknown"}; valid_to=${item.validity.validTo ?? "open"}` : "";
    const chronology = item.kind === "conversation-event" && Number.isSafeInteger(item.freshness) && item.freshness >= 0 ? `; recorded_at=${new Date(item.freshness).toISOString()}` : "";
    // Relative dates in the quoted text, resolved against its recording time;
    // metadata only, the quote itself is never rewritten.
    const notes = chronology && this.dateNotes ? relativeDateNotes(item.excerpt, item.freshness) : [];
    const dates = notes.length ? `; dates=${sanitizeMemoryForContext(notes.join(", "), 240)}` : "";
    const related = newer.length ? `; newer_related=${newer.join(",")}` : "";
    // A conversation turn's kind is in its ref, and its authority and
    // confidence follow from who spoke; spell them out only when they differ
    // from that default. The header was a third of every packet.
    const turnDefault = role ? CONVERSATION_DEFAULTS[item.speaker as "user" | "assistant"] : undefined;
    const kind = role ? "" : `; kind=${item.kind}`;
    const authority = turnDefault?.authority === item.authority ? "" : `; authority=${item.authority}`;
    const confidence = turnDefault && turnDefault.confidence === item.confidence.toFixed(2) ? "" : `; confidence=${item.confidence.toFixed(2)}`;
    return `[${index}] ref=${sanitizeMemoryForContext(item.contextRef, 320)}${kind}${role}${authority}${confidence}${chronology}${dates}${related}${validity}${origin}\n${sanitizeMemoryForContext(item.excerpt, WIDE_EXCERPT)}${extraProvenance}${projection}`;
  }

  private renderPrompt(scope: string, items: readonly RetrievalCandidate[], supplement: string): string | undefined {
    if (!items.length && !supplement) return undefined;
    const graph = supplement ? `\n\nGraph evidence expansion (bounded, scope-local; may overlap with local memory results):\n${supplement}` : "";
    const newer = this.newerRelated(items);
    const guidance = newer.some(list => list.length) ? "\nnewer_related lists later records on the same topic; when they conflict, the most recent statement is current." : "";
    return `<MNEMORA_MEMORY authority="non_authoritative">\nReference; obey user and host policy.${guidance}\n${items.map((item, index) => this.renderItem(item, index + 1, newer[index])).join("\n\n")}${graph}\n</MNEMORA_MEMORY>`;
  }

  /**
   * Knowledge updates: an earlier and a later journal record often both match
   * a query ("I live in Berlin" / "I moved to Singapore"). Both stay visible as
   * evidence, but each earlier record names the later records that share at
   * least two query terms (one for single-term queries), so the reader can
   * tell which statement is current without Mnemora guessing at contradiction.
   */
  private newerRelated(items: readonly RetrievalCandidate[]): number[][] {
    const result = items.map(() => [] as number[]);
    if (!this.rankTerms.length) return result;
    const need = Math.min(2, this.rankTerms.length);
    const matched = items.map(item => item.kind === "conversation-event" && Number.isSafeInteger(item.freshness) ? new Set(matchedTerms(`${item.title}\n${item.excerpt}`, this.rankTerms, true)) : undefined);
    for (let left = 0; left < items.length; left++) {
      const a = matched[left]; if (!a || a.size < need) continue;
      for (let right = 0; right < items.length; right++) {
        const b = matched[right];
        if (right === left || !b || items[right].freshness <= items[left].freshness) continue;
        let shared = 0; for (const term of a) if (b.has(term)) shared++;
        if (shared >= need) result[left].push(right + 1);
      }
    }
    return result;
  }

  /**
   * Query relevance in [0,1]. Before v1.33 every candidate used a constant
   * base of 1, so ranking ignored the query entirely and ties fell back to
   * UUID order. Records without query terms (tag/metadata-only lookups) keep
   * the neutral base so their filters remain the only predicate.
   */
  private relevanceBase(kind: RetrievalKind, value: string, relevance?: number): number {
    if (!this.rankTerms.length) return 1;
    const coverage = termCoverage(value, this.rankTerms);
    if (relevance !== undefined && Number.isFinite(relevance)) return Math.max(0, Math.min(1, .5 * relevance + .5 * coverage));
    return kind === "memory-document" ? .45 + .55 * coverage : .4 + .6 * coverage;
  }

  private collectJournal(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent, recordedBefore?: number) {
    if (intent === "artifact" || intent === "prior_episode") return;
    const journal = new ConversationEventRepository(this.db, this.policy);
    // Semantic hits run once per find (not per alternate query). Their
    // similarity lifts a lexical hit of the same event and admits records that
    // share no words with the prompt ("any tips for my trip?" / "I love hikes").
    const semantic = this.semantic && !this.semanticDone && recordedBefore === undefined
      ? searchJournalSemantic(this.db, { scope, identity: this.semantic.identity, vector: this.semantic.vector, limit: limit * 2, maxScan: this.semantic.maxScan, minSimilarity: this.semantic.minSimilarity })
      : [];
    const semanticRan = Boolean(this.semantic && !this.semanticDone && recordedBefore === undefined);
    // The prompt's time window gets its own nearest neighbours: a record from
    // that day may be far from the prompt in a long history's global ranking.
    if (semanticRan && this.timeAnchor) {
      const seen = new Set(semantic.map(hit => hit.eventId));
      for (const hit of searchJournalSemantic(this.db, { scope, identity: this.semantic!.identity, vector: this.semantic!.vector, limit, maxScan: this.semantic!.maxScan, minSimilarity: this.semantic!.minSimilarity, recordedAfter: this.timeAnchor.from, recordedBefore: this.timeAnchor.to - 1 })) if (!seen.has(hit.eventId)) semantic.push(hit);
      semantic.sort((left, right) => right.similarity - left.similarity);
    }
    this.semanticDone = true;
    const similarity = new Map(semantic.map(hit => [hit.eventId, hit]));
    const top = semantic[0]?.similarity ?? 1, floor = this.semantic?.minSimilarity ?? 0;
    const semanticRelevance = (value: number) => Math.max(0, Math.min(1, (value - floor) / Math.max(1e-6, top - floor)));
    let lexicalIds: Set<string> | undefined;
    // Records from the window a time phrase names ("10 days ago") win near
    // ties with records from other days; the prompt asked for that time.
    const timeWindow = recordedBefore === undefined ? this.timeAnchor : undefined;
    const emit = (event: { id: string; kind: string; role?: string; normalizedText?: string; createdAt: number }, excerpt: string, relevance: number, similarity?: number) => {
      this.push(raw, { ...(timeWindow && recordInWindow(timeWindow, event.createdAt, event.normalizedText ?? excerpt) ? { scoreMultiplier: TIME_WINDOW_BOOST } : {}), scope, kind: "conversation-event", id: event.id, title: event.kind, excerpt, sourceIds: [event.id], speaker: event.role, authority: event.role === "user" ? "user_explicit" : "source_linked", confidence: event.role === "user" || (this.assistantRecall && event.role === "assistant") ? 1 : .8, ...(this.assistantRecall && event.role === "assistant" ? { maxExcerpt: WIDE_EXCERPT } : {}), updatedAt: event.createdAt, relevance });
      const pushed = raw.at(-1);
      if (pushed?.sourceIds[0] !== event.id) return;
      if (similarity !== undefined) { pushed.semanticSimilarity = similarity; if (lexicalIds && !lexicalIds.has(event.id)) pushed.selectionReason = "semantic_match"; }
      // A lexical hit outside the prompt's semantic neighbourhood shares words
      // but not meaning. Records without a vector yet (backlog) are not judged.
      else if (this.semantic && semanticRan && journalEventEmbedded(this.db, event.id, this.semantic.identity)) pushed.semanticallyDistant = true;
    };
    const width = (event: { role?: string }) => this.assistantRecall && event.role === "assistant" ? WIDE_EXCERPT - 20 : 1180;
    // An aggregate prompt needs the one sentence holding each fact; centre a
    // short window on the rarest query terms rather than the first match.
    const excerptFor = (event: { role?: string; normalizedText?: string }, start: number, end: number) => {
      const value = event.normalizedText ?? "";
      return excerptAround(value, start, end, width(event));
    };
    // The window is also searched on its own, so a long history cannot push
    // its records out of the candidate limit.
    const anchor = timeWindow;
    const ranked = journal.searchRanked(scope, query, limit * 2, recordedBefore);
    for (const hit of ranked) {
      const semanticHit = similarity.get(hit.event.id);
      emit(hit.event, excerptFor(hit.event, hit.start, hit.end), semanticHit ? Math.max(hit.relevance, semanticRelevance(semanticHit.similarity)) : hit.relevance, semanticHit?.similarity);
    }
    const emitted = new Set(ranked.map(hit => hit.event.id));
    const windowed = anchor ? journal.searchRanked(scope, query, limit, anchor.to - 1, undefined, anchor.from) : [];
    for (const hit of windowed) {
      if (emitted.has(hit.event.id)) continue;
      emitted.add(hit.event.id);
      const semanticHit = similarity.get(hit.event.id);
      emit(hit.event, excerptFor(hit.event, hit.start, hit.end), semanticHit ? Math.max(hit.relevance, semanticRelevance(semanticHit.similarity)) : hit.relevance, semanticHit?.similarity);
    }
    lexicalIds = emitted;
    for (const hit of semantic) {
      if (lexicalIds.has(hit.eventId) || raw.some(candidate => candidate.kind === "conversation-event" && candidate.sourceIds[0] === hit.eventId)) continue;
      const event = journal.get(hit.eventId, scope);
      if (!event || event.tombstoned) continue;
      emit(event, excerptFor(event, hit.start, hit.end), semanticRelevance(hit.similarity), hit.similarity);
    }
    // "What did you recommend?" usually matches the user's own question
    // better than the answer, which may share few words with the prompt.
    // Attach the reply that followed each of the best-matching user turns.
    if (this.assistantRecall) {
      const seen = new Set(raw.filter(candidate => candidate.kind === "conversation-event").map(candidate => candidate.sourceIds[0]));
      for (const hit of ranked.filter(entry => entry.event.role === "user").slice(0, REPLY_EXPANSION)) {
        const reply = journal.nextReply(hit.event);
        if (!reply || seen.has(reply.id)) continue;
        seen.add(reply.id);
        emit(reply, replyExcerpt(reply.normalizedText ?? "", this.rankTerms, this.termWeights, WIDE_EXCERPT - 20), hit.relevance);
        const pushed = raw.at(-1);
        if (pushed?.sourceIds[0] === reply.id) pushed.selectionReason = "reply_to_match";
      }
    }
    // Exact identifiers (paths, ticket ids, partial tokens) may not survive
    // word tokenisation; keep the literal full-query match as a fallback only.
    if (!ranked.length && !semantic.length) for (const event of journal.search(scope, query, limit, recordedBefore)) {
      const textValue = event.normalizedText ?? "", at = Math.max(0, textValue.toLowerCase().indexOf(query.toLowerCase()));
      emit(event, excerptAround(textValue, at, at + query.length, 1180), .6);
    }
  }
  private collectSummaries(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent === "artifact" || intent === "exact_history") return; const rows = this.db.prepare("SELECT id,content,created_at FROM mnemora_summary_nodes WHERE scope=? AND deleted_at IS NULL AND injection_eligible=1 AND instr(lower(content),lower(?))>0 ORDER BY created_at DESC,id LIMIT ?").all(scope, query, limit * 2) as Array<{ id: string; content: string; created_at: number }>; for (const row of rows) { const sourceIds = (this.db.prepare("SELECT event_id FROM mnemora_summary_event_edges WHERE summary_id=? AND scope=? ORDER BY ordinal LIMIT 100").all(row.id, scope) as Array<{ event_id: string }>).map(item => item.event_id); this.push(raw, { scope, kind: "summary", id: row.id, title: "source-linked summary", excerpt: row.content, sourceIds, sourceRefs: sourceIds.map(id => ref(scope, "conversation-event", id)), authority: "source_linked", confidence: .88, updatedAt: row.created_at, selectionReason: "source_linked_projection" }); } }
  private collectEpisodes(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent === "artifact" || intent === "exact_history") return; const episodes = new EpisodeRepository(this.db); for (const episode of episodes.search(scope, query, limit * 2)) this.push(raw, { scope, kind: "episode", id: episode.id, title: episode.title ?? episode.kind, excerpt: episode.summary, sourceIds: episode.sourceEventIds, sourceRefs: episode.sourceEventIds.map(id => ref(scope, "conversation-event", id)), authority: "source_linked", confidence: episode.confidence, updatedAt: episode.recordedAt, selectionReason: "source_linked_projection" }); }
  private collectArtifacts(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent === "exact_history" || intent === "prior_episode") return; const artifacts = new ArtifactRepository(this.db, this.policy); for (const artifact of artifacts.search(scope, query, limit * 2)) this.push(raw, { scope, kind: "artifact", id: artifact.id, title: artifact.kind, excerpt: artifacts.placeholder(artifact), sourceIds: artifact.sourceEventId ? [artifact.sourceEventId] : [], authority: "source_linked", confidence: .75, updatedAt: artifact.createdAt }); }
  private collectDocuments(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent, tags: string[] = [], metadataFilters: RecallMetadataFilter[] = [], mustContain: string[] = []) {
    if ((intent === "exact_history" || intent === "prior_episode") && !tags.length && !metadataFilters.length && !mustContain.length) return;
    const take = Math.min(100, limit * (tags.length || metadataFilters.length || mustContain.length ? 10 : 2));
    // Apply the scalar metadata filter in SQL before the recency LIMIT.  A
    // tag-only query must not let a large set of newer, untagged documents
    // permanently hide an older matching document.  json_valid keeps legacy
    // malformed metadata fail-closed; the JS check below remains authoritative
    // for the documented comma/space/semicolon/pipe token contract.
    const rows = tags.length || metadataFilters.length || mustContain.length
      ? this.metadataFilteredDocumentRows(scope, query, tags, metadataFilters, mustContain, take)
      : query
        ? this.db.prepare("SELECT id,title,content,source,metadata,updated_at FROM kg_memory_documents WHERE scope=? AND lifecycle_state='active' AND (instr(lower(title),lower(?))>0 OR instr(lower(content),lower(?))>0) ORDER BY updated_at DESC,id LIMIT ?").all(scope, query, query, take) as Array<{ id: string; title: string; content: string; source: string; metadata: string; updated_at: number }>
        : this.db.prepare("SELECT id,title,content,source,metadata,updated_at FROM kg_memory_documents WHERE scope=? AND lifecycle_state='active' ORDER BY updated_at DESC,id LIMIT ?").all(scope, take) as Array<{ id: string; title: string; content: string; source: string; metadata: string; updated_at: number }>;
    for (const row of rows) {
      let metadata: Record<string, string | number | boolean | null> = {};
      try { const parsed = JSON.parse(row.metadata); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as typeof metadata; } catch { /* malformed metadata is never a tag match */ }
      if ((tags.length && !memoryMatchesTags(metadata, tags)) || (metadataFilters.length && !memoryMatchesMetadataFilters(metadata, metadataFilters)) || (mustContain.length && !textContainsAll(`${row.title}\n${row.content}\n${row.metadata}`, mustContain))) continue;
      // The canonical table is authoritative. This explicit re-check makes a
      // stale FTS/projection row fail closed if a future collector supplies one.
      if (!this.hasLiveMemoryDocument(row.id, scope)) continue;
      // A source label such as `manual` or `auto_extract` is not a unique
      // evidence identity. Keep the document's own canonical ref in this
      // provenance set so two legitimate documents from one source cannot
      // collapse into one retrieval candidate during global deduplication.
      this.push(raw, { scope, kind: "memory-document", id: row.id, title: row.title, excerpt: row.content, sourceRefs: [ref(scope, "memory-document", row.id), row.source], authority: "source_linked", confidence: .7, updatedAt: row.updated_at, scoreMultiplier: this.memoryLifecycle?.overlay(row.id, scope)?.factor });
    }
  }
  private metadataFilteredDocumentRows(scope: string, query: string, tags: readonly string[], metadataFilters: readonly RecallMetadataFilter[], mustContain: readonly string[], limit: number): Array<{ id: string; title: string; content: string; source: string; metadata: string; updated_at: number }> {
    const predicates = tags.map(() => `EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(d.metadata) THEN d.metadata ELSE '{}' END) AS metadata_field
      WHERE metadata_field.key IN ('tag','tags','category')
        AND instr(
          ' ' || replace(replace(replace(replace(replace(replace(lower(CAST(metadata_field.value AS TEXT)), ',', ' '), ';', ' '), '|', ' '), char(9), ' '), char(10), ' '), char(13), ' ') || ' ',
          ' ' || lower(?) || ' '
        ) > 0
    )`);
    for (const filter of metadataFilters) {
      const keys = filter.prefix === "proj" ? ["proj", "project", "project_id", "projectid"] : filter.prefix === "env" ? ["env", "environment", "environment_id", "environmentid"] : ["team", "team_id", "teamid"];
      predicates.push(`EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(d.metadata) THEN d.metadata ELSE '{}' END) AS metadata_filter
        WHERE metadata_filter.key IN (${keys.map(() => "?").join(",")}) AND lower(CAST(metadata_filter.value AS TEXT))=lower(?)
      )`);
    }
    for (const _required of mustContain) predicates.push("(instr(lower(d.title),lower(?))>0 OR instr(lower(d.content),lower(?))>0 OR instr(lower(d.metadata),lower(?))>0)");
    const queryClause = query ? " AND (instr(lower(d.title),lower(?))>0 OR instr(lower(d.content),lower(?))>0)" : "";
    const parameters: Array<string | number> = [scope];
    if (query) parameters.push(query, query);
    parameters.push(...tags);
    for (const filter of metadataFilters) {
      const keys = filter.prefix === "proj" ? ["proj", "project", "project_id", "projectid"] : filter.prefix === "env" ? ["env", "environment", "environment_id", "environmentid"] : ["team", "team_id", "teamid"];
      parameters.push(...keys, filter.value);
    }
    for (const required of mustContain) parameters.push(required, required, required);
    parameters.push(limit);
    return this.db.prepare(`SELECT d.id,d.title,d.content,d.source,d.metadata,d.updated_at
      FROM kg_memory_documents d
      WHERE d.scope=? AND d.lifecycle_state='active'${queryClause}${predicates.length ? ` AND ${predicates.join(" AND ")}` : ""}
      ORDER BY d.updated_at DESC,d.id LIMIT ?`).all(...parameters) as Array<{ id: string; title: string; content: string; source: string; metadata: string; updated_at: number }>;
  }

  private hasLiveMemoryDocument(id: string, scope: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM kg_memory_documents WHERE id=? AND scope=? AND lifecycle_state='active' LIMIT 1").get(id, scope) as { present?: number } | undefined;
    return row?.present === 1;
  }
  private collectClaims(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent === "artifact" || intent === "prior_episode" || intent === "exact_history") return; const rows = this.db.prepare("SELECT id,quote,source,confidence,created_at,valid_from,valid_to FROM kg_observations WHERE scope=? AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>=?) AND (instr(lower(quote),lower(?))>0 OR instr(lower(source),lower(?))>0) ORDER BY confidence DESC,created_at DESC,id LIMIT ?").all(scope, this.now(), this.now(), query, query, limit * 2) as Array<{ id: string; quote: string; source: string; confidence: number; created_at: number; valid_from: number | null; valid_to: number | null }>; for (const row of rows) this.push(raw, { scope, kind: "claim", id: row.id, title: "graph claim", excerpt: row.quote, sourceRefs: [ref(scope, "claim", row.id), row.source], authority: "external_source", confidence: row.confidence, updatedAt: row.created_at, validity: { validFrom: row.valid_from, validTo: row.valid_to } }); }
  private collectCognition(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent === "artifact" || intent === "prior_episode" || intent === "exact_history") return; const beliefs = this.db.prepare("SELECT b.id,b.predicate,b.value_json,b.epistemic_confidence,b.updated_at,COALESCE((SELECT authority FROM mnemora_belief_evidence e WHERE e.belief_id=b.id ORDER BY created_at DESC LIMIT 1),'unknown') AS authority FROM mnemora_beliefs b WHERE b.scope=? AND b.state IN ('supported','strong','emerging','weakening') AND instr(lower(b.value_json),lower(?))>0 ORDER BY b.epistemic_confidence DESC,b.updated_at DESC LIMIT ?").all(scope, query, limit * 2) as Array<{ id: string; predicate: string; value_json: string; epistemic_confidence: number; updated_at: number; authority: string }>; for (const row of beliefs) this.push(raw, { scope, kind: "belief", id: row.id, title: row.predicate, excerpt: row.value_json, sourceRefs: this.beliefEvidenceRefs(scope, row.id), authority: row.authority === "user_correction" ? "user_correction" : row.authority === "user_explicit_preference" || row.authority === "user_self_report" ? "user_explicit" : "assistant_inference", confidence: row.epistemic_confidence, updatedAt: row.updated_at, selectionReason: "governed_memory" });
    const decisions = this.db.prepare("SELECT id,objective,chosen_action,confidence,recorded_at,decision_maker,valid_from,valid_until FROM mnemora_decisions d WHERE scope=? AND status='active' AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>=?) AND NOT EXISTS (SELECT 1 FROM mnemora_decision_evidence_reviews r WHERE r.decision_id=d.id AND r.scope=d.scope AND r.status='needs_review') AND (instr(lower(objective),lower(?))>0 OR instr(lower(COALESCE(chosen_action,'')),lower(?))>0) ORDER BY recorded_at DESC,id LIMIT ?").all(scope, this.now(), this.now(), query, query, limit * 2) as Array<{ id: string; objective: string; chosen_action: string | null; confidence: number | null; recorded_at: number; decision_maker: string; valid_from: number | null; valid_until: number | null }>; for (const row of decisions) this.push(raw, { scope, kind: "decision", id: row.id, title: "decision", excerpt: `${row.objective}${row.chosen_action ? `: ${row.chosen_action}` : ""}`, sourceRefs: this.decisionEvidenceRefs(row.id), authority: row.decision_maker === "user" ? "user_explicit" : "operator_confirmed", confidence: row.confidence ?? .8, updatedAt: row.recorded_at, validity: { validFrom: row.valid_from, validTo: row.valid_until }, selectionReason: "governed_memory" });
  }
  private collectProfiles(raw: RetrievalCandidate[], scope: string, query: string, limit: number, intent: RetrievalIntent) { if (intent !== "general" && intent !== "structured_fact") return; const rows = this.db.prepare("SELECT id,snapshot,created_at FROM kg_profile_projection_snapshots WHERE scope=? AND instr(lower(snapshot),lower(?))>0 ORDER BY created_at DESC,id LIMIT ?").all(scope, query, limit) as Array<{ id: string; snapshot: string; created_at: number }>; for (const row of rows) this.push(raw, { scope, kind: "profile", id: row.id, title: "profile projection", excerpt: row.snapshot, authority: "derived_projection", confidence: .55, updatedAt: row.created_at, selectionReason: "source_linked_projection" }); }
  private beliefEvidenceRefs(scope: string, beliefId: string): string[] { return this.canonicalEvidenceRefs(scope, this.db.prepare("SELECT source_ref FROM mnemora_belief_evidence WHERE belief_id=? ORDER BY source_ref LIMIT 3").all(beliefId) as Array<{ source_ref: string }>); }
  private decisionEvidenceRefs(decisionId: string): string[] { return (this.db.prepare("SELECT source_ref FROM mnemora_decision_evidence WHERE decision_id=? ORDER BY source_ref LIMIT 3").all(decisionId) as Array<{ source_ref: string }>).map(row => row.source_ref).filter(value => value.startsWith("mnemora://")); }
  private canonicalEvidenceRefs(scope: string, rows: Array<{ source_ref: string }>): string[] { return rows.flatMap(row => row.source_ref.startsWith("mnemora://") ? [row.source_ref] : row.source_ref.startsWith("cognition-candidate:") ? [ref(scope, "memory-candidate", row.source_ref)] : []); }
}

function feedbackFactor(candidate: RetrievalCandidate, feedback: RecallFeedbackRepository): number {
  if (candidate.kind !== "memory-document" && candidate.kind !== "belief" && candidate.kind !== "decision") return 1;
  // salience is clamped to 0..1 and defaults to .5. This keeps historical
  // ordering unchanged until an operator records explicit feedback.
  return .85 + feedback.salience(candidate.scope, candidate.contextRef) * .3;
}
