export type JournalEventKind = "user_message" | "assistant_message" | "tool_call" | "tool_result" | "system_marker" | "compaction_marker";
export type JournalRole = "user" | "assistant" | "tool" | "system";
export type JournalIdentityOrigin = "host" | "derived" | "local_receipt";
export type JournalContextDomain = "user_chat" | "system" | "tool" | "background" | "unknown";
export type JournalPart = { type: "text"; text: string } | { type: "artifact_ref"; artifactId: string; preview: string; byteLength: number } | { type: "tool_call"; callId: string; name: string } | { type: "tool_result"; callId: string; inlinePreview?: string; success?: boolean; truncated?: boolean };
export interface JournalEventInput { id?: string; scope: string; sessionId: string; branchId?: string; parentId?: string; sequence?: number; kind: JournalEventKind; role?: JournalRole; contextDomain?: JournalContextDomain; parts: JournalPart[]; hostCorrelation?: string; identityOrigin?: JournalIdentityOrigin; createdAt?: number; }
/** A tombstoned event preserves identity and provenance after retention has
 * removed its content.  It can be used only as an evidence anchor. */
export interface JournalEvent { id: string; scope: string; sessionId: string; branchId: string; parentId?: string; sequence: number; kind: JournalEventKind; role?: JournalRole; contextDomain: JournalContextDomain; parts: JournalPart[]; contentHash: string; normalizedText?: string; identityOrigin: JournalIdentityOrigin; hostCorrelation?: string; createdAt: number; tombstoned?: true; }
export interface JournalCapturePolicy { maxInlineChars: number; maxEventBytes: number; sensitiveContentPolicy: "redact" | "hash_only" | "metadata_only" | "drop"; replayFloodThresholdExternal?: number; replayFloodThresholdInternal?: number; }
export interface JournalDiagnostics { enabled: boolean; events: number; sessions: number; pendingTasks: number; }
/** Aggregate-only, scope-local evidence that completed turns were durably captured. */
export interface JournalScopeActivity { events: number; sessions: number; lastCommittedAt: number | null; }

/** A source message can be linked without interpreting or mutating the host transcript. */
export interface JournalTurnEventInput extends JournalEventInput { parentEventOrdinal?: number; hostEntryId?: string; }
export type JournalDerivedTaskKind = "auto_extract" | "episode" | "smart_episode" | "summary_l1" | "summary_l2" | "consolidation" | "reflection";
/** Opaque host receipt identifying one accepted durable transcript turn.
 * The durable key and payload hash make a host retry verifiable without
 * exposing transcript data. The separate compatibility fingerprint is used
 * only to match an ID-less legacy callback to that already-accepted turn. */
export interface JournalTurnAdvancement {
  key: string;
  payloadHash: string;
  /** One-way public-message fingerprint for an ID-less legacy callback. */
  compatibilityFingerprint: string;
  admissionEntryId: string;
  terminalEntryId: string;
  /** Public host transcript positions fence the legacy callback without
   * treating repeated message content as one logical turn. */
  admissionMessagePosition: number;
  terminalMessagePosition: number;
}
export interface JournalTurnCaptureInput { scope: string; sessionId: string; branchId?: string; hostCorrelation: string; events: readonly JournalTurnEventInput[]; derivedTaskKinds?: readonly JournalDerivedTaskKind[]; createdAt?: number; advancement?: JournalTurnAdvancement; }
export interface JournalDerivedTask { id: string; scope: string; commitId: string; kind: JournalDerivedTaskKind | string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; attempts: number; leaseOwner?: string; leaseExpiresAt?: number; deadlineAt?: number; errorCategory?: string; createdAt: number; updatedAt: number; }
export interface JournalTurnReceipt { receiptId: string; commitId: string; scope: string; sessionId: string; branchId: string; events: JournalEvent[]; tasks: JournalDerivedTask[]; inserted: boolean; replaySuppressed?: boolean; advancementStatus?: "committed" | "duplicate"; }
