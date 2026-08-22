import { VECTOR_BACKEND_CONTRACT_V1, type NodeVectorDeletion, type NodeVectorIdPage, type NodeVectorIdPageRequest, type NodeVectorRecord, type NodeVectorSearch, type VectorBackend, type VectorBackendCallOptions, type VectorBackendLimits, type VectorBackendProbe, type VectorBackendRegistration, type VectorMatch } from "./types.js";

const DEFAULT_LIMITS: VectorBackendLimits = { timeoutMs: 3000, maxBatchRecords: 32, maxCandidates: 64 };
const HARD_LIMITS: VectorBackendLimits = { timeoutMs: 30000, maxBatchRecords: 128, maxCandidates: 128 };
const BACKEND_ID = /^[a-z][a-z0-9-]{0,79}$/;
const ENTITY_ID = /^[a-z][a-z0-9:_-]{0,199}$/;

export class VectorBackendContractError extends Error {
  constructor(readonly code: "invalid_vector_backend" | "duplicate_vector_backend" | "unregistered_vector_backend") { super(code); this.name = "VectorBackendContractError"; }
}
export class VectorBackendCallError extends Error {
  constructor(readonly code: "unavailable" | "timeout" | "cancelled" | "invalid_response" | "operation_failed") { super(code); this.name = "VectorBackendCallError"; }
}

export interface VectorBackendSummary { id: string; capabilities: VectorBackendCapabilitiesSnapshot; limits: VectorBackendLimits }
export interface VectorBackendCapabilitiesSnapshot { upsertNodes: boolean; searchNodes: boolean; deleteNodes: boolean; listNodeIds: boolean; supportsAbortSignal: boolean }

/** The only execution boundary for an optional external vector index. */
export class VectorBackendRegistry {
  private readonly backends = new Map<string, { backend: VectorBackend; limits: VectorBackendLimits }>();
  constructor(registrations: readonly VectorBackendRegistration[] = [], private readonly now: () => number = Date.now) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: VectorBackendRegistration): void {
    const backend = registration?.backend;
    if (!validBackend(backend)) throw new VectorBackendContractError("invalid_vector_backend");
    if (this.backends.has(backend.id)) throw new VectorBackendContractError("duplicate_vector_backend");
    this.backends.set(backend.id, { backend, limits: normalizeLimits(registration.limits) });
  }
  has(id: string): boolean { return this.backends.has(id); }
  list(): VectorBackendSummary[] { return [...this.backends.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({ id, capabilities: { ...entry.backend.capabilities }, limits: { ...entry.limits } })); }

  async probe(id: string, signal?: AbortSignal): Promise<VectorBackendProbe> {
    const entry = this.entry(id);
    const value = await this.call(entry, options => entry.backend.probe(options), signal);
    if (!value || typeof value !== "object" || value.backendId !== entry.backend.id || value.supportsAbortSignal !== true) throw new VectorBackendCallError("invalid_response");
    if (value.upsertNodes !== entry.backend.capabilities.upsertNodes || value.searchNodes !== entry.backend.capabilities.searchNodes || value.deleteNodes !== entry.backend.capabilities.deleteNodes || value.listNodeIds !== entry.backend.capabilities.listNodeIds) throw new VectorBackendCallError("invalid_response");
    const detectedVersion = boundedText(value.detectedVersion, 120);
    return { backendId: entry.backend.id, ...(detectedVersion ? { detectedVersion } : {}), ...entry.backend.capabilities };
  }

  async upsertNodes(id: string, records: readonly NodeVectorRecord[], signal?: AbortSignal): Promise<void> {
    const entry = this.entry(id);
    if (!entry.backend.capabilities.upsertNodes || !entry.backend.upsertNodes) throw new VectorBackendCallError("unavailable");
    const valid = records.map(normalizeRecord);
    for (let offset = 0; offset < valid.length; offset += entry.limits.maxBatchRecords) {
      await this.call(entry, options => entry.backend.upsertNodes!(valid.slice(offset, offset + entry.limits.maxBatchRecords), options), signal);
    }
  }

  async searchNodes(id: string, input: NodeVectorSearch, signal?: AbortSignal): Promise<VectorMatch[]> {
    const entry = this.entry(id);
    if (!entry.backend.capabilities.searchNodes || !entry.backend.searchNodes) throw new VectorBackendCallError("unavailable");
    const safe = normalizeSearch(input, entry.limits.maxCandidates);
    const values = await this.call(entry, options => entry.backend.searchNodes!(safe, options), signal);
    if (!Array.isArray(values)) throw new VectorBackendCallError("invalid_response");
    const found = new Map<string, number>();
    for (const value of values.slice(0, entry.limits.maxCandidates)) {
      if (!value || typeof value !== "object" || !ENTITY_ID.test(value.id) || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) continue;
      const previous = found.get(value.id);
      if (previous == null || value.score > previous) found.set(value.id, value.score);
    }
    return [...found.entries()].map(([matchId, score]) => ({ id: matchId, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, safe.limit);
  }

  async deleteNodes(id: string, input: NodeVectorDeletion, signal?: AbortSignal): Promise<void> {
    const entry = this.entry(id);
    if (!entry.backend.capabilities.deleteNodes || !entry.backend.deleteNodes) throw new VectorBackendCallError("unavailable");
    const safe = normalizeDeletion(input);
    for (let offset = 0; offset < safe.ids.length; offset += entry.limits.maxBatchRecords) {
      await this.call(entry, options => entry.backend.deleteNodes!({ ...safe, ids: safe.ids.slice(offset, offset + entry.limits.maxBatchRecords) }, options), signal);
    }
  }

  async listNodeIds(id: string, input: NodeVectorIdPageRequest, signal?: AbortSignal): Promise<NodeVectorIdPage> {
    const entry = this.entry(id);
    if (!entry.backend.capabilities.listNodeIds || !entry.backend.listNodeIds) throw new VectorBackendCallError("unavailable");
    const safe = normalizeIdPageRequest(input, entry.limits.maxCandidates);
    const value = await this.call(entry, options => entry.backend.listNodeIds!(safe, options), signal);
    if (!value || typeof value !== "object" || !Array.isArray(value.ids) || (value.nextCursor != null && !validCursor(value.nextCursor))) throw new VectorBackendCallError("invalid_response");
    const ids = [...new Set(value.ids.slice(0, entry.limits.maxCandidates).filter(value => typeof value === "string" && ENTITY_ID.test(value)))].sort();
    return { ids, nextCursor: value.nextCursor ?? null };
  }

  private entry(id: string) {
    const entry = this.backends.get(id);
    if (!entry) throw new VectorBackendContractError("unregistered_vector_backend");
    return entry;
  }
  private async call<T>(entry: { backend: VectorBackend; limits: VectorBackendLimits }, invoke: (options: VectorBackendCallOptions) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (callerSignal?.aborted) throw new VectorBackendCallError("cancelled");
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const deadlineAt = this.now() + entry.limits.timeoutMs;
    let timedOut = false;
    let rejectTimeout!: (reason: unknown) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("vector backend timeout")); rejectTimeout(new VectorBackendCallError("timeout")); }, entry.limits.timeoutMs);
    try { return await Promise.race([invoke({ deadlineAt, signal }), timeout]); }
    catch (error) {
      if (timedOut) throw new VectorBackendCallError("timeout");
      if (callerSignal?.aborted) throw new VectorBackendCallError("cancelled");
      if (error instanceof VectorBackendCallError) throw error;
      throw new VectorBackendCallError("operation_failed");
    } finally { clearTimeout(timer); }
  }
}

function validBackend(value: unknown): value is VectorBackend {
  if (!value || typeof value !== "object") return false;
  const backend = value as Partial<VectorBackend>, capabilities = backend.capabilities;
  return !!capabilities && typeof capabilities === "object" && BACKEND_ID.test(backend.id ?? "") && backend.contractVersion === VECTOR_BACKEND_CONTRACT_V1 && typeof backend.probe === "function" && capabilities.supportsAbortSignal === true && typeof capabilities.upsertNodes === "boolean" && typeof capabilities.searchNodes === "boolean" && typeof capabilities.deleteNodes === "boolean" && typeof capabilities.listNodeIds === "boolean" && (!capabilities.upsertNodes || typeof backend.upsertNodes === "function") && (!capabilities.searchNodes || typeof backend.searchNodes === "function") && (!capabilities.deleteNodes || typeof backend.deleteNodes === "function") && (!capabilities.listNodeIds || typeof backend.listNodeIds === "function");
}
function normalizeLimits(value: Partial<VectorBackendLimits> | undefined): VectorBackendLimits { return { timeoutMs: clamp(value?.timeoutMs, DEFAULT_LIMITS.timeoutMs, 250, HARD_LIMITS.timeoutMs), maxBatchRecords: clamp(value?.maxBatchRecords, DEFAULT_LIMITS.maxBatchRecords, 1, HARD_LIMITS.maxBatchRecords), maxCandidates: clamp(value?.maxCandidates, DEFAULT_LIMITS.maxCandidates, 1, HARD_LIMITS.maxCandidates) }; }
function normalizeRecord(value: NodeVectorRecord): NodeVectorRecord {
  if (!value || !ENTITY_ID.test(value.id) || !validIdentity(value.identity) || !validInputVersion(value.inputVersion) || !validVector(value.vector, value.identity.dimensions)) throw new VectorBackendCallError("invalid_response");
  return { id: value.id, identity: { ...value.identity }, inputVersion: value.inputVersion, vector: [...value.vector] };
}
function normalizeSearch(value: NodeVectorSearch, maximum: number): NodeVectorSearch {
  if (!value || !validIdentity(value.identity) || !validInputVersion(value.inputVersion) || !validVector(value.vector, value.identity.dimensions) || !validScope(value.scope)) throw new VectorBackendCallError("invalid_response");
  const nodeType = typeof value.nodeType === "string" && /^[a-z][a-z_]{0,31}$/.test(value.nodeType) ? value.nodeType : undefined;
  const limit = clamp(value.limit, 10, 1, maximum), minimumScore = Number.isFinite(value.minimumScore) ? Math.min(1, Math.max(0, value.minimumScore)) : 0;
  return { vector: [...value.vector], identity: { ...value.identity }, inputVersion: value.inputVersion, scope: value.scope, ...(nodeType ? { nodeType } : {}), limit, minimumScore };
}
function normalizeDeletion(value: NodeVectorDeletion): NodeVectorDeletion {
  const ids = [...new Set(Array.isArray(value?.ids) ? value.ids.filter(id => typeof id === "string" && ENTITY_ID.test(id)) : [])].slice(0, HARD_LIMITS.maxBatchRecords);
  if (!ids.length || !validIdentity(value?.identity) || !validInputVersion(value?.inputVersion)) throw new VectorBackendCallError("invalid_response");
  return { ids, identity: { ...value.identity }, inputVersion: value.inputVersion };
}
function normalizeIdPageRequest(value: NodeVectorIdPageRequest, maximum: number): NodeVectorIdPageRequest {
  if (!value || !validIdentity(value.identity) || !validInputVersion(value.inputVersion) || (value.cursor != null && !validCursor(value.cursor))) throw new VectorBackendCallError("invalid_response");
  return { identity: { ...value.identity }, inputVersion: value.inputVersion, ...(value.cursor ? { cursor: value.cursor } : {}), limit: clamp(value.limit, maximum, 1, maximum) };
}
function validIdentity(value: unknown): value is { provider: string; model: string; dimensions: number } { return !!value && typeof value === "object" && boundedText((value as { provider?: unknown }).provider, 80) != null && boundedText((value as { model?: unknown }).model, 160) != null && Number.isInteger((value as { dimensions?: unknown }).dimensions) && Number((value as { dimensions: number }).dimensions) > 0 && Number((value as { dimensions: number }).dimensions) <= 8192; }
function validInputVersion(value: unknown): value is string { return boundedText(value, 120) != null; }
function validScope(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value); }
function validCursor(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value); }
function validVector(value: unknown, dimensions: number): value is number[] { return Array.isArray(value) && value.length === dimensions && value.every(item => Number.isFinite(item)); }
function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined; }
function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value as number))) : fallback; }
