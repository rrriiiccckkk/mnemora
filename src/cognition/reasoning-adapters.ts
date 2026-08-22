import { createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { ReasoningMemoryService, type ReasoningApplicability, type ReasoningMemoryKind } from "./reasoning.js";
import { ReasoningRetrievalService, type ReasoningRetrievalInput } from "./reasoning-retrieval.js";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";

export const REASONING_AGENT_ADAPTER_CONTRACT_V1 = "mnemora-reasoning-agent-adapter/v1" as const;
export type ReasoningAgentAdapterContractVersion = typeof REASONING_AGENT_ADAPTER_CONTRACT_V1;
export interface CompileReasoningContextInput extends ReasoningRetrievalInput { tokenBudget?: number; maxItems?: number; signal?: AbortSignal; }
export interface CompiledReasoningItem { id: string; kind: ReasoningMemoryKind; strategy: string; authority: "operator_confirmed"; confidence: number; utility: number; applicability: ReasoningApplicability; sourceRefs: string[]; reasons: string[]; estimatedTokens: number; }
export interface CompiledReasoningContext { version: "reasoning-context-v1"; scope: string; queryApplied: boolean; tokenBudget: number; estimatedTokens: number; items: CompiledReasoningItem[]; omitted: Array<{ id: string; reason: "budget" }>; diagnostics?: { retrievalCandidates: number; qualityExcluded: number; }; }
export interface ReasoningAgentPresentation { adapterId: string; contractVersion: ReasoningAgentAdapterContractVersion; channel: "sidecar"; format: "markdown" | "json"; content: string; estimatedTokens: number; }
/** Adapter has no store, retrieval, or mutation capability: it only formats Mnemora-owned compilation output. */
export interface ReasoningAgentAdapter { readonly id: string; readonly contractVersion: ReasoningAgentAdapterContractVersion; render(context: CompiledReasoningContext): ReasoningAgentPresentation; }

export class ReasoningContextCompiler {
  private readonly retrieval: ReasoningRetrievalService;
  private readonly memories: ReasoningMemoryService;
  constructor(db: DatabaseSyncInstance) { this.retrieval = new ReasoningRetrievalService(db); this.memories = new ReasoningMemoryService(db); }
  compile(input: CompileReasoningContextInput): CompiledReasoningContext {
    abort(input.signal); const scope = normalizeScope(input.scope), tokenBudget = bounded(input.tokenBudget, 800, 64, 1600), maxItems = bounded(input.maxItems, 6, 1, 12);
    const result = this.retrieval.find({ ...input, scope, limit: Math.min(20, maxItems * 3) }), items: CompiledReasoningItem[] = [], omitted: CompiledReasoningContext["omitted"] = []; let used = 0;
    for (const candidate of result.candidates) {
      abort(input.signal); const memory = this.memories.get(candidate.id, scope); if (!memory || memory.state !== "admitted") continue;
      const sourceRefs = [createMnemoraContextRef({ scope, kind: "reasoning-memory", id: memory.id }), ...memory.evidenceRefs, ...memory.outcomeRefs].slice(0, 8), estimatedTokens = estimate(memory.strategy) + 24;
      if (items.length >= maxItems || used + estimatedTokens > tokenBudget) { omitted.push({ id: memory.id, reason: "budget" }); continue; }
      items.push({ id: memory.id, kind: memory.kind, strategy: memory.strategy, authority: "operator_confirmed", confidence: memory.confidence, utility: memory.utilityScore, applicability: memory.applicability, sourceRefs, reasons: candidate.reasons, estimatedTokens }); used += estimatedTokens;
    }
    const qualityExcluded = result.excluded.confidence + result.excluded.evidence + result.excluded.staleness + result.excluded.conflict;
    return { version: "reasoning-context-v1", scope, queryApplied: Boolean(input.query.trim()), tokenBudget, estimatedTokens: used, items, omitted, diagnostics: { retrievalCandidates: result.candidates.length, qualityExcluded } };
  }
}

export class ReasoningAgentAdapterRegistry {
  private readonly adapters = new Map<string, ReasoningAgentAdapter>();
  constructor(adapters: readonly ReasoningAgentAdapter[] = builtinReasoningAdapters()) { for (const adapter of adapters) this.register(adapter); }
  register(adapter: ReasoningAgentAdapter): void {
    if (!adapter || !/^[a-z][a-z0-9_-]{1,63}$/.test(adapter.id) || adapter.contractVersion !== REASONING_AGENT_ADAPTER_CONTRACT_V1 || typeof adapter.render !== "function" || this.adapters.has(adapter.id)) throw new Error("invalid_reasoning_agent_adapter");
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): ReasoningAgentAdapter | undefined { return this.adapters.get(id); }
  render(id: string, context: CompiledReasoningContext): ReasoningAgentPresentation { const adapter = this.get(id); if (!adapter) throw new Error("unknown_reasoning_agent_adapter"); const output = adapter.render(context); if (!output || output.adapterId !== adapter.id || output.contractVersion !== REASONING_AGENT_ADAPTER_CONTRACT_V1 || output.channel !== "sidecar" || !["markdown", "json"].includes(output.format) || typeof output.content !== "string" || Buffer.byteLength(output.content, "utf8") > 16_384) throw new Error("invalid_reasoning_agent_presentation"); return output; }
  list(): string[] { return [...this.adapters.keys()].sort(); }
}

export function builtinReasoningAdapters(): ReasoningAgentAdapter[] { return [new MarkdownReasoningAdapter("generic"), new MarkdownReasoningAdapter("codex"), new MarkdownReasoningAdapter("openclaw")]; }
class MarkdownReasoningAdapter implements ReasoningAgentAdapter {
  readonly contractVersion = REASONING_AGENT_ADAPTER_CONTRACT_V1;
  constructor(readonly id: "generic" | "codex" | "openclaw") {}
  render(context: CompiledReasoningContext): ReasoningAgentPresentation {
    const content = ["<MNEMORA_REASONING_CONTEXT authority=\"non_authoritative_reference\">", "Use these as evidence-backed reference procedures; verify against the current task.", ...context.items.map((item, index) => `${index + 1}. [${item.kind}] ${item.strategy}\n   authority=${item.authority}; confidence=${item.confidence.toFixed(3)}; utility=${item.utility.toFixed(3)}; refs=${item.sourceRefs.join(",")}`), "</MNEMORA_REASONING_CONTEXT>"].join("\n").slice(0, 16_384);
    return { adapterId: this.id, contractVersion: this.contractVersion, channel: "sidecar", format: "markdown", content, estimatedTokens: estimate(content) };
  }
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); }
function bounded(value: unknown, fallback: number, min: number, max: number): number { return Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback; }
function estimate(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }
