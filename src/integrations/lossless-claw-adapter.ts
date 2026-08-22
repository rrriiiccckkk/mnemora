import { createHash } from "node:crypto";
import { BoundedCommandError, SpawnCommandRunner, type CommandRunner } from "./command.js";
import { PROVIDER_ADAPTER_CONTRACT_V1, type ProviderCallOptions, type ProviderCapabilities, type ResolvedSource, type SourceProvider } from "./types.js";
import type { ExternalSourceRef } from "../trust/types.js";

const PROVIDER = "lossless-claw";

/** Uses only Lossless Claw's documented `lcm` CLI; it never opens lcm.db. */
export class LosslessClawAdapter implements SourceProvider {
  readonly id = PROVIDER;
  readonly contractVersion = PROVIDER_ADAPTER_CONTRACT_V1;
  // The documented CLI exposes a bounded message listing rather than a true
  // message-id read endpoint.  Do not advertise a stability guarantee we
  // cannot prove; callers must preserve an unresolved source as retryable.
  readonly capabilities = { searchSources: false, resolveRawSource: true, resolveSummaryLineage: true, stableExternalIds: false, returnsContentHash: false, returnsScores: false, supportsAbortSignal: true } as const;
  constructor(private readonly runner: CommandRunner = new SpawnCommandRunner()) {}

  async probe(options: ProviderCallOptions): Promise<ProviderCapabilities> {
    const output = await this.run(["status"], options);
    const data = envelope(output);
    const version = firstString(data, ["version", "pluginVersion", "plugin_version"]);
    return { providerId: PROVIDER, ...(version ? { detectedVersion: version } : {}), ...this.capabilities };
  }

  async resolveSource(ref: ExternalSourceRef, options: ProviderCallOptions): Promise<ResolvedSource | null> {
    const safeRef = normalizeRef(ref);
    const args = commandFor(safeRef);
    const output = await this.run(args, options);
    const data = envelope(output);
    const item = safeRef.summaryId ? firstRecord(data) : messageRecord(data, safeRef.messageId);
    if (item && typeof item.content === "string" && Buffer.byteLength(item.content, "utf8") > options.maxBytes) throw new BoundedCommandError("output_too_large");
    const content = item && boundedContent(item.content, options.maxBytes);
    if (!content) return null;
    const createdAt = timestamp(item.createdAt ?? item.created_at ?? item.timestamp);
    const resolvedMessageId = firstString(item, ["id", "messageId", "message_id"]);
    return { ref: { ...safeRef, ...(safeRef.messageId || !resolvedMessageId ? {} : { messageId: resolvedMessageId }) }, content, contentHash: createHash("sha256").update(content).digest("hex"), ...(createdAt == null ? {} : { createdAt }) };
  }

  private async run(args: string[], options: ProviderCallOptions): Promise<string> {
    try { return (await this.runner.run("lcm", args, { maxOutputBytes: options.maxBytes, deadlineAt: options.deadlineAt, signal: options.signal })).stdout; }
    catch (error) { if (error instanceof BoundedCommandError) throw error; throw new BoundedCommandError("operation_failed"); }
  }
}

function commandFor(ref: ExternalSourceRef): string[] {
  if (ref.summaryId) return ["summaries", "show", ref.summaryId];
  const selector = ref.conversationId ? ["--conversation-id", ref.conversationId] : ["--session-key", ref.externalId];
  if (ref.messageId) return ["messages", "list", ...selector, "--include-content", "--limit", "20"];
  return ["messages", "tail", ...selector, "--count", "1"];
}
function normalizeRef(value: ExternalSourceRef): ExternalSourceRef {
  // These values become positional CLI arguments. Leading dashes would be
  // interpreted as options by a Provider CLI, so reject them at the boundary.
  const valid = (field: unknown, max: number) => typeof field === "string" && field.trim().length > 0 && field.trim().length <= max && !field.trim().startsWith("-") && !/[\u0000-\u001f]/.test(field) ? field.trim() : undefined;
  const externalId = valid(value?.externalId, 200), provider = valid(value?.provider, 80);
  if (provider !== PROVIDER || !externalId) throw new BoundedCommandError("invalid_response");
  const conversationId = valid(value.conversationId, 80), messageId = valid(value.messageId, 160), summaryId = valid(value.summaryId, 160), externalVersion = valid(value.externalVersion, 120);
  if ((value.conversationId != null && !conversationId) || (value.messageId != null && !messageId) || (value.summaryId != null && !summaryId) || (value.externalVersion != null && !externalVersion)) throw new BoundedCommandError("invalid_response");
  return { provider: PROVIDER, externalId, ...(externalVersion ? { externalVersion } : {}), ...(conversationId ? { conversationId } : {}), ...(messageId ? { messageId } : {}), ...(summaryId ? { summaryId } : {}) };
}
function envelope(output: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new BoundedCommandError("invalid_response"); }
  if (!record(value) || value.ok !== true || !record(value.data)) throw new BoundedCommandError("invalid_response");
  return value.data;
}
function messageRecord(data: Record<string, unknown>, messageId: string | undefined): Record<string, unknown> | undefined {
  const records = collectRecords(data, 40);
  if (messageId) return records.find(item => String(item.id ?? item.messageId ?? item.message_id) === messageId);
  return records.filter(item => typeof item.content === "string").at(-1);
}
function firstRecord(data: Record<string, unknown>): Record<string, unknown> | undefined { return typeof data.content === "string" ? data : collectRecords(data, 40).find(item => typeof item.content === "string"); }
function collectRecords(value: unknown, maximum: number): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [], queue: unknown[] = [value];
  while (queue.length && found.length < maximum) {
    const current = queue.shift();
    if (Array.isArray(current)) { for (const item of current.slice(0, maximum - found.length)) queue.push(item); continue; }
    if (!record(current)) continue;
    if (typeof current.content === "string") found.push(current);
    for (const key of ["messages", "items", "rows", "results"]) if (current[key] !== undefined) queue.push(current[key]);
  }
  return found;
}
function boundedContent(value: unknown, maximum: number): string | undefined { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum ? value : undefined; }
function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined { for (const key of keys) if (typeof value[key] === "string" && value[key].length <= 120) return value[key] as string; return undefined; }
function timestamp(value: unknown): number | undefined { if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number; if (typeof value === "string") { const time = Date.parse(value); return Number.isFinite(time) && time >= 0 ? time : undefined; } return undefined; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
