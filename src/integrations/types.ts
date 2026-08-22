import type { ExternalSourceRef } from "../trust/types.js";

/** Public SDK contract. Increment this value only for a breaking Adapter change. */
export const PROVIDER_ADAPTER_CONTRACT_V1 = "mnemora-provider-adapter/v1" as const;
export type ProviderAdapterContractVersion = typeof PROVIDER_ADAPTER_CONTRACT_V1;

/**
 * Capability declarations are intentionally narrow. An Adapter may only expose
 * documented public commands or APIs; it must never read a Provider's private
 * database, file tree, or implementation-only endpoint.
 */
export interface ProviderCapabilityContract {
  searchSources: boolean;
  resolveRawSource: boolean;
  resolveSummaryLineage: boolean;
  stableExternalIds: boolean;
  returnsContentHash: boolean;
  returnsScores: boolean;
  /** Every Adapter call must receive and honour the bounded cancellation signal. */
  supportsAbortSignal: true;
}

export interface ProviderCapabilities {
  providerId: string;
  detectedVersion?: string;
  searchSources: boolean;
  resolveRawSource: boolean;
  resolveSummaryLineage: boolean;
  stableExternalIds: boolean;
  returnsContentHash: boolean;
  returnsScores: boolean;
  supportsAbortSignal: boolean;
}

export interface ResolvedSource {
  ref: ExternalSourceRef;
  content: string;
  contentHash: string;
  createdAt?: number;
  /**
   * Bounded, public lifecycle metadata.  This is deliberately not provider
   * evidence: callers must preserve it as migration provenance only and may
   * not turn it into a graph fact without a separate admission decision.
   */
  metadata?: Record<string, string | number | boolean | null>;
}

/** A bounded, offset-based public inventory page.  Offsets are opaque to
 * callers other than the Adapter that issued them, and are never file paths
 * or Provider-private database cursors. */
export interface ProviderInventoryPage {
  sources: ResolvedSource[];
  nextOffset?: number;
  complete: boolean;
}

export interface ProviderCallOptions {
  maxBytes: number;
  deadlineAt: number;
  signal?: AbortSignal;
}

/** Limits owned by Mnemora, rather than an Adapter or Provider response. */
export interface ProviderAdapterLimits {
  timeoutMs: number;
  maxInputChars: number;
  maxOutputBytes: number;
}

/**
 * Stable public Adapter contract for library hosts. Adapter methods receive
 * already-bounded inputs, a deadline, and an AbortSignal. Returned source
 * content is revalidated and hashed by ProviderAdapterRegistry before Mnemora uses
 * it, so Provider metadata and scores never become graph evidence implicitly.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly contractVersion: ProviderAdapterContractVersion;
  readonly capabilities: ProviderCapabilityContract;
  probe(options: ProviderCallOptions): Promise<ProviderCapabilities>;
  resolveSource?(ref: ExternalSourceRef, options: ProviderCallOptions): Promise<ResolvedSource | null>;
  searchCandidates?(query: string, providerScope: string, limit: number, options: ProviderCallOptions): Promise<ResolvedSource[]>;
  /** Optional public inventory.  Its presence is capability-probed by the
   * registry; v1 search/resolve-only adapters remain fully compatible. */
  listSources?(providerScope: string, limit: number, offset: number, options: ProviderCallOptions): Promise<ProviderInventoryPage>;
}

/** Passing a registration to Mnemora is an explicit host-level opt-in. */
export interface ProviderAdapterRegistration {
  adapter: ProviderAdapter;
  /** May only lower/shorten the SDK defaults and compiled hard maxima. */
  limits?: Partial<ProviderAdapterLimits>;
}

/** Explicitly ingest a source already returned by the bounded SDK registry. */
export interface ProviderSourceIngestionInput {
  source: ResolvedSource;
  scope?: string;
  force?: boolean;
}

export interface SourceProvider extends ProviderAdapter {
  resolveSource(ref: ExternalSourceRef, options: ProviderCallOptions): Promise<ResolvedSource | null>;
}

/** Candidate-only retrieval adapter: no private-store access and no provider mutation. */
export interface CandidateSourceProvider extends ProviderAdapter {
  searchCandidates(query: string, providerScope: string, limit: number, options: ProviderCallOptions): Promise<ResolvedSource[]>;
}

export type IntegrationHealth = "healthy" | "degraded" | "unavailable" | "disabled";
export type IntegrationWarningCode = "disabled" | "unavailable" | "timeout" | "cancelled" | "output_too_large" | "invalid_response" | "not_found" | "not_in_search_window" | "operation_failed";

export interface IntegrationStatusRecord {
  provider: string;
  detected_version: string | null;
  capabilities: ProviderCapabilities;
  status: Exclude<IntegrationHealth, "disabled">;
  warning_code: Exclude<IntegrationWarningCode, "disabled"> | null;
  last_probe_at: number;
}

export type IntegrationProviderId = "lossless-claw" | "memory-lancedb-pro";
export type KgIntegrationInput =
  | { operation: "status"; provider?: IntegrationProviderId }
  | { operation: "probe"; provider: IntegrationProviderId; signal?: AbortSignal }
  | { operation: "ingest"; provider: "lossless-claw"; external_ref: ExternalSourceRef; scope?: string; signal?: AbortSignal }
  | { operation: "search"; provider: "memory-lancedb-pro"; query: string; provider_scope?: string; limit?: number; signal?: AbortSignal }
  | { operation: "ingest"; provider: "memory-lancedb-pro"; query: string; external_id: string; provider_scope?: string; scope?: string; signal?: AbortSignal }
  | { operation: "migration_preview"; provider: IntegrationProviderId; scope?: string; query?: string; provider_scope?: string; external_refs?: ExternalSourceRef[]; limit?: number; offset?: number; signal?: AbortSignal }
  | { operation: "migration_apply" | "migration_resume"; provider: IntegrationProviderId; run_id: string; signal?: AbortSignal }
  | { operation: "migration_verify" | "migration_rollback"; provider: IntegrationProviderId; run_id: string };

export interface KgIntegrationResult {
  provider: IntegrationProviderId;
  operation: "status" | "probe" | "search" | "ingest" | "migration_preview" | "migration_apply" | "migration_resume" | "migration_verify" | "migration_rollback";
  status: IntegrationHealth;
  warning_code?: IntegrationWarningCode;
  capabilities?: ProviderCapabilities;
  external_id?: string;
  content_hash?: string;
  candidates?: Array<{ external_id: string; content_hash: string }>;
  migration?: { id: string; status: string; items: Array<{ external_id: string; content_hash: string; status: string; error_code?: string }>; inventory?: { offset: number; next_offset?: number; complete: boolean }; rollback: "restore_required" | "not_requested"; };
  ingestion?: { status: "succeeded" | "skipped_duplicate" | "failed"; source: string; fingerprint: string; counts: { entities: number; relations: number; observations: number }; warnings: string[]; error?: { category: string; summary: string } };
}
