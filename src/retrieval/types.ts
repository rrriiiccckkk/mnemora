export type RetrievalIntent = "exact_history" | "prior_episode" | "artifact" | "structured_fact" | "general";
/** Deterministic corpus category used only as a derived ranking/routing hint. */
export type RetrievalIntentCategory = "preference" | "decision" | "entity" | "event" | "fact";
export type RecallMetadataPrefix = "proj" | "env" | "team";
export interface RecallMetadataFilter { prefix: RecallMetadataPrefix; value: string; }
export type RetrievalKind = "conversation-event" | "summary" | "episode" | "artifact" | "memory-document" | "claim" | "belief" | "decision" | "reasoning-memory" | "profile";
export type RetrievalAuthority = "user_explicit" | "user_correction" | "source_linked" | "operator_confirmed" | "tool_observation" | "external_source" | "assistant_inference" | "derived_projection" | "unknown";
export interface RetrievalCandidate { contextRef: string; kind: RetrievalKind; scope: string; title: string; excerpt: string; estimatedTokens: number; bytes: number; score: number; sourceIds: string[]; sourceRefs: string[]; authority: RetrievalAuthority; confidence: number; freshness: number; selectionReason: "lexical_match" | "semantic_match" | "source_linked_projection" | "governed_memory"; }
export interface UnifiedFindResult { version: "unified-find-v2"; intent: RetrievalIntent; scope: string; candidates: RetrievalCandidate[]; excluded: { duplicate: number; budget: number; lowConfidence: number; stale: number; }; empty: boolean; }
