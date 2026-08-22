import { createHash } from "node:crypto";
import { BoundedCommandError } from "./command.js";
import { PROVIDER_ADAPTER_CONTRACT_V1, type ProviderAdapter, type ProviderAdapterLimits, type ProviderAdapterRegistration, type ProviderCallOptions, type ProviderCapabilities, type ProviderInventoryPage, type ResolvedSource } from "./types.js";
import type { ExternalSourceRef } from "../trust/types.js";

const DEFAULT_LIMITS: ProviderAdapterLimits = { timeoutMs: 5000, maxInputChars: 4000, maxOutputBytes: 65536 };
const HARD_LIMITS: ProviderAdapterLimits = { timeoutMs: 30000, maxInputChars: 16000, maxOutputBytes: 262144 };
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,79}$/;
const PROVIDER_SCOPE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

export class ProviderAdapterContractError extends Error {
  constructor(readonly code: "invalid_provider_adapter" | "duplicate_provider_adapter") { super(code); this.name = "ProviderAdapterContractError"; }
}

export interface ProviderAdapterSummary {
  id: string;
  capabilities: ProviderCapabilities;
  limits: ProviderAdapterLimits;
}

/**
 * The sole SDK execution boundary. It validates contracts at registration,
 * gives every call a killable deadline, and re-hashes returned source text.
 * Adapter authors still have a contractual obligation to use public Provider
 * interfaces only; this registry never exposes an Mnemora path to private stores.
 */
export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, { adapter: ProviderAdapter; limits: ProviderAdapterLimits }>();
  private readonly now: () => number;

  constructor(registrations: readonly ProviderAdapterRegistration[] = [], now: () => number = Date.now) {
    this.now = now;
    for (const registration of registrations) this.register(registration);
  }

  register(registration: ProviderAdapterRegistration): void {
    const adapter = registration?.adapter;
    if (!validAdapter(adapter)) throw new ProviderAdapterContractError("invalid_provider_adapter");
    if (this.adapters.has(adapter.id)) throw new ProviderAdapterContractError("duplicate_provider_adapter");
    this.adapters.set(adapter.id, { adapter, limits: normalizeLimits(registration.limits) });
  }

  has(provider: string): boolean { return this.adapters.has(provider); }
  get(provider: string): ProviderAdapter | undefined { return this.adapters.get(provider)?.adapter; }
  supportsPublicInventory(provider: string): boolean { return Boolean(this.adapters.get(provider)?.adapter.listSources); }
  limits(provider: string): ProviderAdapterLimits | undefined { const limits = this.adapters.get(provider)?.limits; return limits ? { ...limits } : undefined; }
  capabilities(provider: string): ProviderCapabilities | undefined {
    const entry = this.adapters.get(provider);
    return entry ? declaredCapabilities(entry.adapter) : undefined;
  }
  list(): ProviderAdapterSummary[] {
    return [...this.adapters.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({ id, capabilities: declaredCapabilities(entry.adapter), limits: { ...entry.limits } }));
  }

  async probe(provider: string, signal?: AbortSignal): Promise<ProviderCapabilities> {
    const entry = this.entry(provider);
    const value = await this.call(entry, options => entry.adapter.probe(options), signal);
    return normalizeProbe(entry.adapter, value);
  }

  async resolveSource(provider: string, ref: ExternalSourceRef, signal?: AbortSignal): Promise<ResolvedSource | null> {
    const entry = this.entry(provider);
    if (!entry.adapter.resolveSource || !entry.adapter.capabilities.resolveRawSource) throw new BoundedCommandError("invalid_response");
    const safeRef = normalizeRef(ref, provider);
    const resolved = await this.call(entry, options => entry.adapter.resolveSource!(safeRef, options), signal);
    return resolved == null ? null : normalizeResolvedSource(resolved, provider, entry.limits.maxOutputBytes);
  }

  async searchCandidates(provider: string, query: string, providerScope: string, limit: number, signal?: AbortSignal): Promise<ResolvedSource[]> {
    const entry = this.entry(provider);
    if (!entry.adapter.searchCandidates || !entry.adapter.capabilities.searchSources) throw new BoundedCommandError("invalid_response");
    const safeQuery = boundedText(query, entry.limits.maxInputChars), safeScope = boundedScope(providerScope);
    if (!safeQuery || !safeScope) throw new BoundedCommandError("invalid_response");
    const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    if (!Number.isFinite(safeLimit)) throw new BoundedCommandError("invalid_response");
    const values = await this.call(entry, options => entry.adapter.searchCandidates!(safeQuery, safeScope, safeLimit, options), signal);
    if (!Array.isArray(values)) throw new BoundedCommandError("invalid_response");
    return values.slice(0, safeLimit).map(value => normalizeResolvedSource(value, provider, entry.limits.maxOutputBytes));
  }

  /** Lists a public inventory page when, and only when, the Adapter has
   * explicitly exposed one.  This is not inferred from a Provider's storage. */
  async listSources(provider: string, providerScope: string, limit: number, offset = 0, signal?: AbortSignal): Promise<ProviderInventoryPage> {
    const entry = this.entry(provider);
    if (!entry.adapter.listSources || !entry.adapter.capabilities.stableExternalIds) throw new BoundedCommandError("invalid_response");
    const safeScope = boundedScope(providerScope), safeLimit = Math.max(1, Math.min(100, Math.trunc(limit))), safeOffset = Math.max(0, Math.min(1_000_000, Math.trunc(offset)));
    if (!safeScope || !Number.isFinite(safeLimit) || !Number.isFinite(safeOffset)) throw new BoundedCommandError("invalid_response");
    const page = await this.call(entry, options => entry.adapter.listSources!(safeScope, safeLimit, safeOffset, options), signal);
    if (!page || typeof page !== "object" || !Array.isArray(page.sources) || typeof page.complete !== "boolean") throw new BoundedCommandError("invalid_response");
    const nextOffset = page.nextOffset == null ? undefined : Math.trunc(page.nextOffset);
    if (nextOffset != null && (!Number.isSafeInteger(nextOffset) || nextOffset <= safeOffset || nextOffset > 1_000_000)) throw new BoundedCommandError("invalid_response");
    if (!page.complete && nextOffset == null) throw new BoundedCommandError("invalid_response");
    return { sources: page.sources.slice(0, safeLimit).map(value => normalizeResolvedSource(value, provider, entry.limits.maxOutputBytes)), complete: page.complete, ...(nextOffset == null ? {} : { nextOffset }) };
  }

  private entry(provider: string): { adapter: ProviderAdapter; limits: ProviderAdapterLimits } {
    const entry = this.adapters.get(provider);
    if (!entry) throw new BoundedCommandError("unavailable");
    return entry;
  }

  private async call<T>(entry: { adapter: ProviderAdapter; limits: ProviderAdapterLimits }, invoke: (options: ProviderCallOptions) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (callerSignal?.aborted) throw new BoundedCommandError("cancelled");
    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const deadlineAt = this.now() + entry.limits.timeoutMs;
    let timedOut = false;
    let rejectTimeout!: (reason: unknown) => void;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("provider timeout")); rejectTimeout(new BoundedCommandError("timeout")); }, entry.limits.timeoutMs);
    try { return await Promise.race([invoke({ maxBytes: entry.limits.maxOutputBytes, deadlineAt, signal }), timeout]); }
    catch (error) {
      if (timedOut) throw new BoundedCommandError("timeout");
      if (callerSignal?.aborted) throw new BoundedCommandError("cancelled");
      if (error instanceof BoundedCommandError) throw error;
      throw new BoundedCommandError("operation_failed");
    } finally { clearTimeout(timer); }
  }
}

function validAdapter(value: unknown): value is ProviderAdapter {
  if (!value || typeof value !== "object") return false;
  const adapter = value as Partial<ProviderAdapter>;
  if (!validProviderId(adapter.id) || adapter.contractVersion !== PROVIDER_ADAPTER_CONTRACT_V1 || typeof adapter.probe !== "function") return false;
  const capabilities = adapter.capabilities;
  if (!capabilities || typeof capabilities !== "object" || capabilities.supportsAbortSignal !== true) return false;
  const keys: Array<keyof import("./types.js").ProviderCapabilityContract> = ["searchSources", "resolveRawSource", "resolveSummaryLineage", "stableExternalIds", "returnsContentHash", "returnsScores", "supportsAbortSignal"];
  if (keys.some(key => typeof capabilities[key] !== "boolean")) return false;
  return (!capabilities.searchSources || typeof adapter.searchCandidates === "function") && (!capabilities.resolveRawSource || typeof adapter.resolveSource === "function") && (adapter.listSources == null || typeof adapter.listSources === "function");
}

function normalizeLimits(value: Partial<ProviderAdapterLimits> | undefined): ProviderAdapterLimits {
  return {
    timeoutMs: clamp(value?.timeoutMs, DEFAULT_LIMITS.timeoutMs, 1000, HARD_LIMITS.timeoutMs),
    maxInputChars: clamp(value?.maxInputChars, DEFAULT_LIMITS.maxInputChars, 256, HARD_LIMITS.maxInputChars),
    maxOutputBytes: clamp(value?.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes, 1024, HARD_LIMITS.maxOutputBytes)
  };
}

function declaredCapabilities(adapter: ProviderAdapter): ProviderCapabilities { return { providerId: adapter.id, ...adapter.capabilities }; }
function normalizeProbe(adapter: ProviderAdapter, value: unknown): ProviderCapabilities {
  if (!value || typeof value !== "object") throw new BoundedCommandError("invalid_response");
  const reported = value as Partial<ProviderCapabilities>;
  if (reported.providerId !== adapter.id || reported.supportsAbortSignal !== true) throw new BoundedCommandError("invalid_response");
  const declared = adapter.capabilities;
  const keys: Array<Exclude<keyof import("./types.js").ProviderCapabilityContract, "supportsAbortSignal">> = ["searchSources", "resolveRawSource", "resolveSummaryLineage", "stableExternalIds", "returnsContentHash", "returnsScores"];
  if (keys.some(key => reported[key] !== declared[key])) throw new BoundedCommandError("invalid_response");
  const version = boundedText(reported.detectedVersion, 120);
  return { providerId: adapter.id, ...(version ? { detectedVersion: version } : {}), ...declared };
}

function normalizeResolvedSource(value: unknown, provider: string, maxBytes: number): ResolvedSource {
  if (!value || typeof value !== "object") throw new BoundedCommandError("invalid_response");
  const source = value as Partial<ResolvedSource>;
  const ref = normalizeRef(source.ref, provider);
  const content = typeof source.content === "string" && source.content.length > 0 && Buffer.byteLength(source.content, "utf8") <= maxBytes ? source.content : undefined;
  if (!content) throw new BoundedCommandError("invalid_response");
  const createdAt = finiteTime(source.createdAt);
  const metadata = normalizeMetadata(source.metadata);
  return { ref, content, contentHash: createHash("sha256").update(content).digest("hex"), ...(createdAt == null ? {} : { createdAt }), ...(metadata ? { metadata } : {}) };
}

function normalizeRef(value: unknown, provider: string): ExternalSourceRef {
  if (!value || typeof value !== "object") throw new BoundedCommandError("invalid_response");
  const ref = value as Partial<ExternalSourceRef>;
  if (ref.provider !== provider) throw new BoundedCommandError("invalid_response");
  const externalId = boundedText(ref.externalId, 200);
  if (!externalId) throw new BoundedCommandError("invalid_response");
  const optional = (input: unknown, maximum: number) => boundedText(input, maximum);
  const externalVersion = optional(ref.externalVersion, 120), conversationId = optional(ref.conversationId, 80), messageId = optional(ref.messageId, 160), summaryId = optional(ref.summaryId, 160);
  return { provider, externalId, ...(externalVersion ? { externalVersion } : {}), ...(conversationId ? { conversationId } : {}), ...(messageId ? { messageId } : {}), ...(summaryId ? { summaryId } : {}) };
}

function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined; }
function boundedScope(value: unknown): string | undefined { return typeof value === "string" && PROVIDER_SCOPE.test(value) ? value : undefined; }
function validProviderId(value: unknown): value is string { return typeof value === "string" && PROVIDER_ID.test(value); }
function finiteTime(value: unknown): number | undefined { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined; }
function normalizeMetadata(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
    if (item == null || typeof item === "boolean") result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "string" && item.length <= 512 && !/[\u0000-\u001f]/.test(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}
function clamp(value: unknown, fallback: number, minimum: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value as number))) : fallback; }
