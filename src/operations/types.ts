/** Configuration that can lower inspector response ceilings, but never raise them. */
export interface OperationsConfig {
  maxGraphNodes: number;
  maxGraphEdges: number;
  maxGraphResponseBytes: number;
  graphDeadlineMs: number;
}

export const INSPECTOR_BIND_HOST = "127.0.0.1" as const;
export const INSPECTOR_DEFAULT_PORT = 0 as const;
export const INSPECTOR_HARD_LIMITS: Readonly<OperationsConfig> = Object.freeze({
  maxGraphNodes: 5000,
  maxGraphEdges: 20000,
  maxGraphResponseBytes: 4 * 1024 * 1024,
  graphDeadlineMs: 5000
});

const keys = ["maxGraphNodes", "maxGraphEdges", "maxGraphResponseBytes", "graphDeadlineMs"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const invalid = (): never => { throw new Error("invalid operations config"); };

/**
 * Normalizes the only user-configurable inspector limits.  Network binding is
 * intentionally absent: callers must always use the exported loopback host
 * and OS-selected port constants.
 */
export function normalizeOperationsConfig(input: unknown = {}): OperationsConfig {
  try {
    if (!isRecord(input) || ["host", "bindHost", "port"].some(key => key in input) || !Object.keys(input).every(key => (keys as readonly string[]).includes(key))) return invalid();
    const result: OperationsConfig = { ...INSPECTOR_HARD_LIMITS };
    for (const key of keys) {
      const value = input[key];
      if (value === undefined) continue;
      if (!isPositiveSafeInteger(value)) return invalid();
      result[key] = Math.min(value, INSPECTOR_HARD_LIMITS[key]);
    }
    return result;
  } catch {
    return invalid();
  }
}

export type InspectorOperation = "source_trust" | "backup" | "restore" | "orphan_cleanup" | "weight_recompute";
export type OperationPhase = "preview" | "confirm";

export interface SourceTrustPayload { source: string; weight: number; }
export interface EmptyOperationPayload { readonly [key: string]: never; }
export interface RestorePayload { artifact_id: string; }
export interface MaintenancePayload { limit?: number; }

export type OperationPayload = SourceTrustPayload | EmptyOperationPayload | RestorePayload | MaintenancePayload;

export type OperationPreviewRequest =
  | { operation: "source_trust"; phase: "preview"; graph_revision: number; config_revision: number; payload: SourceTrustPayload }
  | { operation: "backup"; phase: "preview"; graph_revision: number; payload: EmptyOperationPayload }
  | { operation: "restore"; phase: "preview"; graph_revision: number; payload: RestorePayload }
  | { operation: "orphan_cleanup" | "weight_recompute"; phase: "preview"; graph_revision: number; payload: MaintenancePayload };

export type OperationConfirmRequest =
  | { operation: "source_trust"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; config_revision: number; payload: SourceTrustPayload }
  | { operation: "backup"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; payload: EmptyOperationPayload }
  | { operation: "restore"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; payload: RestorePayload }
  | { operation: "orphan_cleanup" | "weight_recompute"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; payload: MaintenancePayload };

export type OperationRequest = OperationPreviewRequest | OperationConfirmRequest;
export type SourceTrustPreviewRequest = Extract<OperationPreviewRequest, { operation: "source_trust" }>;
export type SourceTrustConfirmRequest = Extract<OperationConfirmRequest, { operation: "source_trust" }>;
export type BackupPreviewRequest = Extract<OperationPreviewRequest, { operation: "backup" }>;
export type BackupConfirmRequest = Extract<OperationConfirmRequest, { operation: "backup" }>;
export type RestorePreviewRequest = Extract<OperationPreviewRequest, { operation: "restore" }>;
export type RestoreConfirmRequest = Extract<OperationConfirmRequest, { operation: "restore" }>;
export type OrphanCleanupPreviewRequest = { operation: "orphan_cleanup"; phase: "preview"; graph_revision: number; payload: MaintenancePayload };
export type OrphanCleanupConfirmRequest = { operation: "orphan_cleanup"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; payload: MaintenancePayload };
export type WeightRecomputePreviewRequest = { operation: "weight_recompute"; phase: "preview"; graph_revision: number; payload: MaintenancePayload };
export type WeightRecomputeConfirmRequest = { operation: "weight_recompute"; phase: "confirm"; preview_token: string; payload_hash: string; graph_revision: number; payload: MaintenancePayload };

/** Opaque public identifier; callers never receive a filesystem path. */
export interface ArtifactReference { artifact_id: string; }
export interface OperationAffectedCounts { nodes: number; edges: number; observations: number; }
export interface OperationRankDelta { id: string; delta: number; }
export interface SourceTrustPreviewResult {
  operation: "source_trust";
  phase: "preview";
  preview_token: string;
  payload_hash: string;
  graph_revision: number;
  config_revision: number;
  affected: OperationAffectedCounts;
  rank_deltas: OperationRankDelta[];
  truncated: boolean;
}
export interface BackupPreviewResult { operation: "backup"; phase: "preview"; preview_token: string; payload_hash: string; graph_revision: number; affected: OperationAffectedCounts; truncated: boolean; }
export interface RestorePreviewResult { operation: "restore"; phase: "preview"; preview_token: string; payload_hash: string; graph_revision: number; affected: OperationAffectedCounts; truncated: boolean; }
export interface OrphanCleanupPreviewResult { operation: "orphan_cleanup"; phase: "preview"; preview_token: string; payload_hash: string; graph_revision: number; affected: OperationAffectedCounts; truncated: boolean; }
export interface WeightRecomputePreviewResult { operation: "weight_recompute"; phase: "preview"; preview_token: string; payload_hash: string; graph_revision: number; affected: OperationAffectedCounts; truncated: boolean; }
export type OperationPreviewResult = SourceTrustPreviewResult | BackupPreviewResult | RestorePreviewResult | OrphanCleanupPreviewResult | WeightRecomputePreviewResult;

export interface SourceTrustConfirmResult {
  operation: "source_trust";
  phase: "confirm";
  confirmed: boolean;
  graph_revision: number;
  config_revision: number;
  audit_id: string;
  affected: OperationAffectedCounts;
}
export interface BackupResult { operation: "backup"; phase: "confirm"; confirmed: boolean; graph_revision: number; audit_id: string; artifact: ArtifactReference; }
export interface RestoreResult { operation: "restore"; phase: "confirm"; confirmed: boolean; graph_revision: number; audit_id: string; recovery_point: ArtifactReference; }
export interface OrphanCleanupConfirmResult { operation: "orphan_cleanup"; phase: "confirm"; confirmed: boolean; graph_revision: number; audit_id: string; affected: OperationAffectedCounts; }
export interface WeightRecomputeConfirmResult { operation: "weight_recompute"; phase: "confirm"; confirmed: boolean; graph_revision: number; audit_id: string; affected: OperationAffectedCounts; }
export type OperationConfirmResult = SourceTrustConfirmResult | BackupResult | RestoreResult | OrphanCleanupConfirmResult | WeightRecomputeConfirmResult;
export type OperationResult = OperationPreviewResult | OperationConfirmResult;
