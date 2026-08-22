import { createHash } from "node:crypto";
import { BoundedCommandError, SpawnCommandRunner, type CommandRunner } from "./command.js";
import { PROVIDER_ADAPTER_CONTRACT_V1, type CandidateSourceProvider, type ProviderCallOptions, type ProviderCapabilities, type ProviderInventoryPage, type ResolvedSource } from "./types.js";

const PROVIDER = "memory-lancedb-pro";

/** Uses only documented `openclaw memory-pro ... --json` commands; it never opens LanceDB. */
export class MemoryLanceDbProAdapter implements CandidateSourceProvider {
  readonly id = PROVIDER;
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_V1;
  readonly capabilities = { searchSources: true, resolveRawSource: false, resolveSummaryLineage: false, stableExternalIds: true, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true } as const;
  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  async probe(options: ProviderCallOptions): Promise<ProviderCapabilities> {
    const data = parseJson(await this.run(["memory-pro", "stats", "--json"], options));
    const version = firstString(data, ["version", "pluginVersion", "plugin_version"]);
    return { providerId: PROVIDER, ...(version ? { detectedVersion: version } : {}), ...this.capabilities };
  }

  async searchCandidates(query: string, providerScope: string, limit: number, options: ProviderCallOptions): Promise<ResolvedSource[]> {
    const safeQuery = boundedText(query, 1000), safeScope = boundedScope(providerScope), safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    if (!safeQuery || !safeScope || !Number.isFinite(safeLimit)) throw new BoundedCommandError("invalid_response");
    const value = parseUnknown(await this.run(["memory-pro", "search", safeQuery, "--scope", safeScope, "--limit", String(safeLimit), "--json"], options));
    const rows = candidateRows(value);
    if (!rows) throw new BoundedCommandError("invalid_response");
    const result: ResolvedSource[] = [];
    for (const row of rows.slice(0, safeLimit)) {
      if (typeof row.content === "string" && Buffer.byteLength(row.content, "utf8") > options.maxBytes) throw new BoundedCommandError("output_too_large");
      const id = firstString(row, ["id", "memoryId", "memory_id"]), content = boundedContent(row.content, options.maxBytes);
      if (!id || !content) continue;
      result.push({ ref: { provider: PROVIDER, externalId: id }, content, contentHash: createHash("sha256").update(content).digest("hex") });
    }
    return result;
  }

  /** Public, offset-paginated inventory documented by memory-lancedb-pro's
   * CLI.  No LanceDB path, table, or private API is consulted. */
  async listSources(providerScope: string, limit: number, offset: number, options: ProviderCallOptions): Promise<ProviderInventoryPage> {
    const safeScope = boundedScope(providerScope), safeLimit = Math.max(1, Math.min(100, Math.trunc(limit))), safeOffset = Math.max(0, Math.min(1_000_000, Math.trunc(offset)));
    if (!safeScope || !Number.isFinite(safeLimit) || !Number.isFinite(safeOffset)) throw new BoundedCommandError("invalid_response");
    const value = parseUnknown(await this.run(["memory-pro", "list", "--scope", safeScope, "--limit", String(safeLimit), "--offset", String(safeOffset), "--json"], options));
    const rows = candidateRows(value);
    if (!rows) throw new BoundedCommandError("invalid_response");
    const result: ResolvedSource[] = [];
    for (const row of rows.slice(0, safeLimit)) {
      const text = row.text ?? row.content;
      if (typeof text === "string" && Buffer.byteLength(text, "utf8") > options.maxBytes) throw new BoundedCommandError("output_too_large");
      const id = firstString(row, ["id", "memoryId", "memory_id"]), content = boundedContent(text, options.maxBytes);
      if (!id || !content) continue;
      const category = firstString(row, ["category"]), importance = finiteNumber(row.importance), timestamp = finiteTimestamp(row.timestamp ?? row.createdAt);
      const metadata = publicMetadata(row.metadata, category, importance);
      result.push({ ref: { provider: PROVIDER, externalId: id }, content, contentHash: createHash("sha256").update(content).digest("hex"), ...(timestamp == null ? {} : { createdAt: timestamp }), ...(metadata ? { metadata } : {}) });
    }
    // The documented CLI returns an array and does not expose a total count.
    // A short page is the only public, conservative completion signal.
    const complete = rows.length < safeLimit;
    return { sources: result, complete, ...(complete ? {} : { nextOffset: safeOffset + safeLimit }) };
  }

  private async run(args: string[], options: ProviderCallOptions): Promise<string> {
    try { return (await this.runner.run("openclaw", args, { maxOutputBytes: options.maxBytes, deadlineAt: options.deadlineAt, signal: options.signal })).stdout; }
    catch (error) { if (error instanceof BoundedCommandError) throw error; throw new BoundedCommandError("operation_failed"); }
  }
}

function parseJson(output: string): Record<string, unknown> {
  const value = parseUnknown(output);
  if (!record(value)) throw new BoundedCommandError("invalid_response");
  return value;
}
function parseUnknown(output: string): unknown { try { return JSON.parse(output); } catch { throw new BoundedCommandError("invalid_response"); } }
function candidateRows(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(record);
  if (!record(value)) return undefined;
  for (const key of ["results", "memories", "items", "data"]) if (Array.isArray(value[key])) return (value[key] as unknown[]).filter(record);
  return undefined;
}
// `openclaw memory-pro` receives these as positional arguments. Reject a
// leading dash so untrusted provider values cannot be parsed as CLI flags.
function boundedText(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !value.trim().startsWith("-") && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined; }
function boundedScope(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value) ? value : undefined; }
function boundedContent(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum ? value : undefined; }
function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined { for (const key of keys) { const item = boundedText(value[key], 160); if (item) return item; } return undefined; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function finiteTimestamp(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function publicMetadata(value: unknown, category?: string, importance?: number): Record<string, string | number | boolean | null> | undefined {
  const result: Record<string, string | number | boolean | null> = {};
  if (category) result.category = category;
  if (importance != null) result.importance = importance;
  if (typeof value === "string" && value.length <= 512) {
    try {
      const parsed = JSON.parse(value);
      if (record(parsed)) for (const [key, item] of Object.entries(parsed).slice(0, 16)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue;
        if (item === null || typeof item === "boolean") result[key] = item;
        else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
        else if (typeof item === "string" && item.length <= 256 && !/[\u0000-\u001f]/.test(item)) result[key] = item;
      }
    } catch { /* malformed optional metadata is intentionally ignored */ }
  }
  return Object.keys(result).length ? result : undefined;
}
