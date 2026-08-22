import type { EmbeddingIdentity } from "../embeddings.js";

/** Public SDK contract. Increment this only for a breaking Vector Backend change. */
export const VECTOR_BACKEND_CONTRACT_V1 = "mnemora-vector-backend/v1" as const;
export type VectorBackendContractVersion = typeof VECTOR_BACKEND_CONTRACT_V1;

export interface VectorBackendCapabilities {
  /** The backend accepts opaque Mnemora entity ids and vectors, never source text. */
  upsertNodes: boolean;
  /** The backend can return opaque entity ids ranked for a query vector. */
  searchNodes: boolean;
  /** The backend can remove opaque entity ids for one embedding identity. */
  deleteNodes: boolean;
  /** The backend can page opaque ids for a single embedding identity. */
  listNodeIds: boolean;
  /** Every backend call must honour the supplied bounded cancellation signal. */
  supportsAbortSignal: true;
}

export interface VectorBackendProbe extends VectorBackendCapabilities {
  backendId: string;
  detectedVersion?: string;
}

export interface VectorBackendCallOptions {
  deadlineAt: number;
  signal?: AbortSignal;
}

/** A vector record contains no node name, description, evidence, or source body. */
export interface NodeVectorRecord {
  id: string;
  identity: EmbeddingIdentity;
  inputVersion: string;
  vector: number[];
}

export interface NodeVectorSearch {
  vector: number[];
  identity: EmbeddingIdentity;
  inputVersion: string;
  scope: string;
  nodeType?: string;
  limit: number;
  minimumScore: number;
}

export interface VectorMatch { id: string; score: number }

/** Deletion is identity-scoped so a model migration cannot erase another index. */
export interface NodeVectorDeletion {
  ids: readonly string[];
  identity: EmbeddingIdentity;
  inputVersion: string;
}

/** A bounded opaque-id page used only for explicit index reconciliation. */
export interface NodeVectorIdPage {
  ids: readonly string[];
  nextCursor: string | null;
}

export interface NodeVectorIdPageRequest {
  identity: EmbeddingIdentity;
  inputVersion: string;
  cursor?: string;
  limit: number;
}

/**
 * A host-injected optional ANN backend. It is an index only: Mnemora keeps SQLite
 * as the authoritative graph store and locally rechecks every returned id.
 */
export interface VectorBackend {
  readonly id: string;
  readonly contractVersion: VectorBackendContractVersion;
  readonly capabilities: VectorBackendCapabilities;
  probe(options: VectorBackendCallOptions): Promise<VectorBackendProbe>;
  upsertNodes?(records: readonly NodeVectorRecord[], options: VectorBackendCallOptions): Promise<void>;
  searchNodes?(input: NodeVectorSearch, options: VectorBackendCallOptions): Promise<readonly VectorMatch[]>;
  deleteNodes?(input: NodeVectorDeletion, options: VectorBackendCallOptions): Promise<void>;
  listNodeIds?(input: NodeVectorIdPageRequest, options: VectorBackendCallOptions): Promise<NodeVectorIdPage>;
}

export interface VectorBackendLimits {
  timeoutMs: number;
  maxBatchRecords: number;
  maxCandidates: number;
}

/** Registration is programmatic host opt-in; plugin configuration never loads code. */
export interface VectorBackendRegistration {
  backend: VectorBackend;
  limits?: Partial<VectorBackendLimits>;
}
