import { createHash } from "node:crypto";
import { delegateCompactionToRuntime, type ContextEngine } from "openclaw/plugin-sdk";
import type { MnemoraConfig } from "../index.js";
import { ConversationEventRepository } from "../journal/repository.js";
import type { JournalDerivedTaskKind, JournalEventInput, JournalEventKind, JournalRole, JournalTurnReceipt } from "../journal/types.js";
import type { CompletedTurn, ContextAssemblyInput } from "./lifecycle.js";
import { contextDomain, estimateMessageTokens, messageText, selectBoundHostMessages, type HostMessage } from "./message-safety.js";
import { UnifiedRetrievalService } from "../retrieval/service.js";
import { planRecallQuery } from "../retrieval/query-routing.js";
import { RecallUsageRepository } from "../recall-lifecycle/repository.js";
import { ConfiguredCompactionSummarizer, RuntimeCompactionSummarizer } from "./compaction-model.js";
import { activeJournalTokenEstimate, ContextCompactionService, type CompactionOptions } from "./compaction-service.js";
import { estimateTextTokens } from "./token-estimate.js";
import { mnemoraVersion } from "../version.js";
import { sessionWriteDisposition } from "../journal/session-policy.js";
import { SummaryRepository, type SummaryNode } from "./summary-repository.js";
import { ToolPayloadArtifactService } from "../artifacts/tool-payload-service.js";
import { parseMnemoraContextRef } from "../context/context-ref.js";

type BootstrapParams = Parameters<NonNullable<ContextEngine["bootstrap"]>>[0];
type IngestParams = Parameters<ContextEngine["ingest"]>[0];
type IngestBatchParams = Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0];
type AfterTurnParams = Parameters<NonNullable<ContextEngine["afterTurn"]>>[0];
type AssembleParams = Parameters<ContextEngine["assemble"]>[0];
type CompactParams = Parameters<ContextEngine["compact"]>[0];
type MaintainParams = Parameters<NonNullable<ContextEngine["maintain"]>>[0];
type RuntimeMessage = IngestParams["message"];
type ContextTurnLifecycle = {
  derivedTaskKinds?(): readonly JournalDerivedTaskKind[];
  onCompletedTurn?(turn: CompletedTurn, receipt: JournalTurnReceipt): Promise<void> | void;
  onAssemble?(input: ContextAssemblyInput): string | undefined;
  /** Bounded, content-free observability for fail-open host capture errors. */
  onCaptureFailure?(event: { source: string; category: "invalid_input" | "persistence_failed"; messageCount: number }): void;
};

const estimate = (messages: HostMessage[]) => messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const asHostMessage = (message: RuntimeMessage): HostMessage => message as unknown as HostMessage;

/**
 * Public ContextEngine implementation. Host compaction remains the default.
 * A separately explicit opt-in enables only bounded, source-linked model
 * compaction through the host's documented rewrite capability.
 */
export class MnemoraContextEngine implements ContextEngine {
  readonly info: ContextEngine["info"];

  constructor(private readonly config: MnemoraConfig, private readonly openGraph: () => import("../tools.js").Mnemora, private readonly delegate = delegateCompactionToRuntime, private readonly lifecycle: ContextTurnLifecycle = {}) {
    const ownsCompaction = config.contextEngine?.compaction?.enabled === true;
    this.info = {
      id: "mnemora",
      name: "Mnemora",
      version: mnemoraVersion,
      ownsCompaction,
      turnMaintenanceMode: ownsCompaction ? "background" : undefined,
      hostRequirements: {
        "agent-run": { requiredCapabilities: ["bootstrap", "assemble-before-prompt", "after-turn", "compact"], unsupportedMessage: "Mnemora standalone requires the public OpenClaw ContextEngine lifecycle." },
        "manual-compact": { requiredCapabilities: ["compact"], unsupportedMessage: ownsCompaction ? "Mnemora bounded compaction requires OpenClaw's public transcript rewrite capability." : "Mnemora delegates compaction to OpenClaw unless local compaction is explicitly enabled." }
      }
    };
  }

  private policy() {
    const value = this.config.conversationJournal!;
    return { maxInlineChars: value.maxInlineChars!, maxEventBytes: value.maxEventBytes!, sensitiveContentPolicy: value.sensitiveContentPolicy!, replayFloodThresholdExternal: value.replayFloodThresholdExternal!, replayFloodThresholdInternal: value.replayFloodThresholdInternal! };
  }

  private scope() { return this.config.scope!.default!; }

  async bootstrap(params: BootstrapParams) {
    const graph = this.openGraph();
    try {
      const count = Number((graph.store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_conversation_events WHERE scope=? AND session_id=? AND deleted_at IS NULL").get(this.scope(), params.sessionId) as { value: number }).value);
      // The public ContextEngine bootstrap contract exposes session metadata,
      // not a private transcript reader. Reconcile durable Journal state here;
      // future afterTurn/maintain callbacks supply the public messages needed
      // for source-linked backfill without duplicating an existing event.
      return {
        bootstrapped: true,
        importedMessages: 0,
        reason: count > 0 ? "journal_session_reconciled" : "journal_session_empty_public_history_unavailable"
      };
    } finally { graph.close(); }
  }

  async ingest(params: IngestParams) {
    let graph: ReturnType<MnemoraContextEngine["openGraph"]> | undefined;
    try {
      graph = this.openGraph();
      const receipt = this.capture(graph.store.db, params.sessionId, [params.message], { isHeartbeat: params.isHeartbeat, baseIndex: 0, source: "ingest" });
      return { ingested: receipt?.inserted === true };
    } catch (error) {
      this.reportCaptureFailure("ingest", 1, error);
      return { ingested: false };
    } finally { try { graph?.close(); } catch { /* host capture remains fail-open */ } }
  }

  async ingestBatch(params: IngestBatchParams) {
    let graph: ReturnType<MnemoraContextEngine["openGraph"]> | undefined;
    try {
      graph = this.openGraph();
      const receipt = this.capture(graph.store.db, params.sessionId, params.messages, { isHeartbeat: params.isHeartbeat, baseIndex: 0, source: "ingest_batch" });
      return { ingestedCount: receipt?.inserted ? receipt.events.length : 0 };
    } catch (error) {
      this.reportCaptureFailure("ingest_batch", Array.isArray(params.messages) ? params.messages.length : 0, error);
      return { ingestedCount: 0 };
    } finally { try { graph?.close(); } catch { /* host capture remains fail-open */ } }
  }

  async afterTurn(params: AfterTurnParams): Promise<void> {
    if (!Array.isArray(params.messages)) {
      this.reportCaptureFailure("after_turn", 0, new Error("invalid_journal_turn"));
      return;
    }
    // The host may omit this advisory count or provide NaN. Treating either
    // as zero replays the entire transcript on every turn. With no trusted
    // boundary, capture nothing and wait for the next lifecycle callback.
    const count = Number(params.prePromptMessageCount);
    const start = Number.isFinite(count) ? Math.min(params.messages.length, Math.max(0, Math.floor(count))) : params.messages.length;
    const messages = params.messages.slice(start);
    if (!messages.length) return;
    let graph: ReturnType<MnemoraContextEngine["openGraph"]> | undefined;
    let receipt: JournalTurnReceipt | undefined;
    try {
      graph = this.openGraph();
      receipt = this.capture(graph.store.db, params.sessionId, messages, { isHeartbeat: params.isHeartbeat, baseIndex: start, source: "after_turn" });
    } catch (error) {
      this.reportCaptureFailure("after_turn", messages.length, error);
    } finally { try { graph?.close(); } catch { /* host capture remains fail-open */ } }
    const turn = this.completedTurn(params.sessionId, messages, Boolean(params.isHeartbeat), params.runtimeContext?.llm);
    // Derived work is optional. Durable capture has already committed and the
    // host must never lose a completed turn because extraction or an optional
    // local lifecycle callback later fails.
    if (turn && receipt) try { await this.lifecycle.onCompletedTurn?.(turn, receipt); } catch { /* fail open */ }
    if (receipt && !params.isHeartbeat) await this.proactiveCompact(params);
  }

  async assemble(params: AssembleParams): Promise<Awaited<ReturnType<ContextEngine["assemble"]>>> {
    const requestedBudget = Number.isFinite(params.tokenBudget) ? Math.max(1, Math.floor(params.tokenBudget!)) : this.config.contextEngine!.maxContextTokens!;
    const budget = Math.min(this.config.contextEngine!.maxContextTokens!, requestedBudget);
    const hostMessages = params.messages.map(asHostMessage);
    let toolProjectedMessages = hostMessages;
    if (this.config.artifacts?.enabled && this.config.artifacts.toolPayloads?.enabled) {
      const graphForToolProjection = this.openGraph();
      try { toolProjectedMessages = new ToolPayloadArtifactService(this.config, graphForToolProjection.store.db).project(this.scope(), params.sessionId, hostMessages); }
      catch { toolProjectedMessages = hostMessages; }
      finally { try { graphForToolProjection.close(); } catch { /* preserve public host context on optional projection failure */ } }
    }
    const projected = this.compactionProjection(params.sessionId, toolProjectedMessages, budget);
    const boundedMessages = selectBoundHostMessages(projected.messages, Math.max(1, budget - projected.summaryTokens));
    const projectedMessages = projected.summary ? this.insertSummaryProjection(boundedMessages.messages, projected.summary) : boundedMessages.messages;
    const messages = projectedMessages as unknown as typeof params.messages;
    const estimatedTokens = boundedMessages.estimatedTokens + projected.summaryTokens;
    const agentId = this.activeAgentId(params.messages);
    const automaticWorkExcluded = this.isExcludedAgent(agentId);
    // The public AssembleResult explicitly supports systemPromptAddition. It
    // is the one and only injection point in standalone mode. Mnemora registers
    // no legacy prompt hook, so duplicate recall cannot be revived by runtime
    // ordering or an old compatibility setting.
    const additions: string[] = [];
    const available = Math.max(0, budget - estimatedTokens);
    if (!automaticWorkExcluded && this.config.mode === "standalone" && this.config.unifiedRetrieval?.enabled && available >= 64 && typeof params.prompt === "string" && params.prompt.trim()) {
      const graph = this.openGraph();
      try {
        const retrieval = new UnifiedRetrievalService(graph.store.db, this.policy(), Date.now, graph.memoryLifecycle);
        const recallBudget = Math.min(available, this.config.unifiedRetrieval.tokenBudget!);
        const graphBudget = recallBudget >= 128 ? Math.max(64, Math.floor(recallBudget * .4)) : 0;
        const lexicalBudget = Math.max(64, recallBudget - graphBudget);
        const plan = planRecallQuery(params.prompt, this.config.recall?.queryRouting), retrievalQuery = plan.query;
        const result = retrieval.find({ scope: this.scope(), query: retrievalQuery, alternates: plan.alternates, tags: plan.tags, metadataFilters: plan.metadataFilters, mustContain: plan.mustContain, lexicalOnly: plan.lexicalOnly, scopeConstraint: plan.scopeConstraint, intent: plan.intent, intentCategory: plan.category, tokenBudget: lexicalBudget, limit: this.config.unifiedRetrieval.maxItems, minConfidence: this.config.unifiedRetrieval.minConfidence, maxStalenessDays: this.config.unifiedRetrieval.maxStalenessDays });
        // Graph recall is bounded by the same standalone budget and joins the
        // memory corpus inside this one attachment. Hybrid uses embeddings when
        // configured; otherwise the graph's exact lexical path remains useful.
        let graphSupplement: string | undefined;
        // Prefix-constrained retrieval has an exact local-document contract.
        // Do not add a broad graph supplement beside it, and never turn an
        // incompatible `scope:` constraint into a same-scope graph search.
        const routeAllowsGraph = plan.lexicalOnly !== true && (!plan.scopeConstraint || plan.scopeConstraint === this.scope());
        if (routeAllowsGraph && graphBudget && retrievalQuery && typeof graph.kg_context === "function") {
          const graphContext = await graph.kg_context(retrievalQuery, this.config.unifiedRetrieval.maxItems, 1, this.config.unifiedRetrieval.minConfidence, graphBudget, this.config.embeddings?.enabled ? "hybrid" : "lexical", undefined, this.scope(), { recordMetrics: false });
          if ((graphContext.nodes.length || graphContext.memories?.length) && graphContext.context !== "") graphSupplement = graphContext.context;
        }
        const rendered = retrieval.compilePrompt(result, this.config.unifiedRetrieval.maxItems, graphSupplement);
        if (rendered && estimateTextTokens(rendered) <= available) {
          additions.push(rendered);
          // Only this successful public ContextEngine attachment counts as a
          // recall. Search, shadow diagnostics, graph expansion, and a prompt
          // that did not fit are intentionally not lifecycle signals.
          try {
            const attached = result.candidates.slice(0, this.config.unifiedRetrieval.maxItems);
            new RecallUsageRepository(graph.store.db).recordInjected({ scope: this.scope(), targetRefs: attached.map(candidate => candidate.contextRef) });
            graph.memoryLifecycle.recordAccessRefs(attached.flatMap(candidate => {
              if (candidate.kind !== "memory-document") return [];
              try { const reference = parseMnemoraContextRef(candidate.contextRef); return reference.kind === "memory-document" ? [{ id: reference.id, scope: reference.scope }] : []; } catch { return []; }
            }));
          } catch { /* usage telemetry never changes recall availability */ }
        }
      } catch { /* recall must remain fail-open: host messages are authoritative */ }
      finally { graph.close(); }
    }
    const currentAdditionTokens = () => additions.length ? estimateTextTokens(additions.join("\n\n")) : 0;
    const remaining = Math.max(0, budget - estimatedTokens - currentAdditionTokens());
    // Reasoning delivery shares the same public assembly boundary as unified
    // retrieval. It cannot create a second hook attachment, and an output that
    // cannot fit is withheld rather than truncated into an invalid envelope.
    if (!automaticWorkExcluded && remaining >= 64 && typeof params.prompt === "string" && params.prompt.trim()) {
      try {
        const reasoning = this.lifecycle.onAssemble?.({ sessionId: params.sessionId, query: params.prompt.trim(), tokenBudget: remaining, ...(agentId ? { agentId } : {}) });
        if (reasoning && estimateTextTokens(additions.length ? `${additions.join("\n\n")}\n\n${reasoning}` : reasoning) <= budget - estimatedTokens) additions.push(reasoning);
      } catch { /* optional governed reasoning must remain fail-open */ }
    }
    const addition = additions.length ? additions.join("\n\n") : undefined;
    const total = estimatedTokens + currentAdditionTokens();
    return { messages, estimatedTokens: total, promptAuthority: boundedMessages.overBudget || total > budget ? "preassembly_may_overflow" as const : "assembled" as const, ...(addition ? { systemPromptAddition: addition } : {}) };
  }

  async compact(params: CompactParams) {
    abort(params.abortSignal);
    const options = this.config.contextEngine?.compaction;
    if (!options?.enabled) return await this.delegate(params);
    const result = await this.runLocalCompaction(params.sessionId, params.runtimeContext, params.abortSignal);
    return { ok: true, compacted: result.compacted, reason: result.reason, result: { ...(result.summary ? { summary: result.summary } : {}), ...(result.firstKeptEntryId ? { firstKeptEntryId: result.firstKeptEntryId } : {}), tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, details: result.details } };
  }

  async maintain(params: MaintainParams) {
    const options = this.config.contextEngine?.compaction;
    if (!options?.enabled) return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "local_compaction_disabled" };
    const input = params.runtimeContext;
    const budget = this.runtimeBudget(input?.tokenBudget);
    if (this.activeJournalTokenEstimate(params.sessionId) < Math.floor(budget * options.contextThreshold!)) return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "below_context_threshold" };
    const result = await this.runLocalCompaction(params.sessionId, input, undefined);
    return { changed: result.compacted, bytesFreed: Number(result.details.bytesFreed ?? 0), rewrittenEntries: Number(result.details.rewrittenEntries ?? 0), reason: result.reason };
  }

  async dispose(): Promise<void> { /* SQLite handles are opened per operation and deterministically closed. */ }

  private async proactiveCompact(params: AfterTurnParams): Promise<void> {
    const options = this.config.contextEngine?.compaction, runtime = params.runtimeContext;
    if (!options?.enabled || !runtime?.rewriteTranscriptEntries) return;
    const budget = this.runtimeBudget(params.tokenBudget ?? runtime.tokenBudget);
    // afterTurn is background maintenance. It must never turn an already
    // committed host turn into an error; durable compaction runs retain any
    // failure/reconciliation state for the operator instead.
    try {
      if (this.activeJournalTokenEstimate(params.sessionId) < Math.floor(budget * options.contextThreshold!)) return;
      await this.runLocalCompaction(params.sessionId, runtime);
    } catch { /* maintenance remains fail-open */ }
  }

  private activeJournalTokenEstimate(sessionId: string): number {
    const graph = this.openGraph();
    try { return activeJournalTokenEstimate(graph.store.db, this.scope(), sessionId); } finally { graph.close(); }
  }

  private async runLocalCompaction(sessionId: string, runtimeContext: CompactParams["runtimeContext"] | undefined, signal?: AbortSignal) {
    const options = this.config.contextEngine!.compaction!, graph = this.openGraph();
    try {
      const model = runtimeContext?.llm ? new RuntimeCompactionSummarizer(runtimeContext.llm, options.timeoutMs!) : new ConfiguredCompactionSummarizer(this.config, options.timeoutMs!);
      const budget = this.runtimeBudget(runtimeContext?.tokenBudget);
      const service = new ContextCompactionService(graph.store.db, this.policy(), model);
      return await service.compact({
        scope: this.scope(), sessionId, protectedRecentEvents: this.config.contextEngine!.protectedRecentEvents!, runtimeContext, signal,
        targetTokens: Math.floor(budget * options.contextThreshold!), options: this.compactionOptions()
      });
    } finally { graph.close(); }
  }

  private compactionOptions(): CompactionOptions {
    const options = this.config.contextEngine!.compaction!;
    return {
      minEvents: options.minEvents!, maxInputChars: options.maxInputChars!, maxOutputChars: options.maxOutputChars!, timeoutMs: options.timeoutMs!, maxRunsPerHour: options.maxRunsPerHour!, maxDailyTokens: options.maxDailyTokens!, circuitCooldownMs: options.circuitCooldownMs!, summaryMaxCallsPerWindow: options.summaryMaxCallsPerWindow!, summaryCallWindowMs: options.summaryCallWindowMs!, summarySpendBackoffMs: options.summarySpendBackoffMs!, contextThreshold: options.contextThreshold!, freshTailCount: options.freshTailCount!, leafChunkTokens: options.leafChunkTokens!, maxChunksPerRun: options.maxChunksPerRun!, condensedMinFanout: options.condensedMinFanout!, deadlineMs: options.deadlineMs!
    };
  }

  private runtimeBudget(value: unknown): number {
    const requested = Number.isFinite(value) ? Math.max(1, Math.floor(Number(value))) : this.config.contextEngine!.maxContextTokens!;
    return Math.min(this.config.contextEngine!.maxContextTokens!, requested);
  }

  private compactionProjection(sessionId: string, messages: HostMessage[], budget: number): { messages: HostMessage[]; summary?: HostMessage; summaryTokens: number } {
    const options = this.config.contextEngine?.compaction;
    if (!options?.enabled || estimate(messages) < Math.floor(budget * options.contextThreshold!)) return { messages, summaryTokens: 0 };
    let graph: ReturnType<MnemoraContextEngine["openGraph"]> | undefined;
    try {
      graph = this.openGraph();
      const roots = new SummaryRepository(graph.store.db, this.policy()).roots(this.scope(), sessionId, "main", 1);
      const root = roots[0];
      if (!root) return { messages, summaryTokens: 0 };
      const compacted = messages.filter(message => !isCompactionEnvelope(message));
      const fresh = freshTail(compacted, options.freshTailCount!);
      const content = root.content.slice(0, this.config.contextEngine!.maxSummaryChars!);
      const summary: HostMessage = { role: "system", content: `<MNEMORA_COMPACTION summary_id="${root.id}" source_linked="true" authority="non_authoritative" priority="reference">\n${content}\n</MNEMORA_COMPACTION>` };
      const summaryTokens = estimateMessageTokens(summary), currentUser = [...fresh].reverse().find(message => contextDomain(message) === "user_chat" && String(message.role ?? "").toLowerCase() === "user");
      if (summaryTokens + (currentUser ? estimateMessageTokens(currentUser) : 0) > budget) return { messages, summaryTokens: 0 };
      return { messages: fresh, summary, summaryTokens };
    } catch { return { messages, summaryTokens: 0 }; }
    finally { try { graph?.close(); } catch { /* projection remains fail-open */ } }
  }

  private insertSummaryProjection(messages: HostMessage[], summary: HostMessage): HostMessage[] {
    const firstNonSystem = messages.findIndex(message => contextDomain(message) !== "system");
    const index = firstNonSystem < 0 ? messages.length : firstNonSystem;
    return [...messages.slice(0, index), summary, ...messages.slice(index)];
  }

  private capture(db: import("@photostructure/sqlite").DatabaseSyncInstance, sessionId: string, messages: readonly RuntimeMessage[], options: { isHeartbeat?: boolean; baseIndex: number; source: string }): JournalTurnReceipt | undefined {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 512) {
      this.reportCaptureFailure(options.source, Array.isArray(messages) ? messages.length : 0, new Error("invalid_journal_turn"));
      return undefined;
    }
    if (sessionWriteDisposition(sessionId, this.config.conversationJournal) !== "writable" || this.isExcludedAgent(this.activeAgentId(messages))) return undefined;
    // Host lifecycle input is untrusted. Invalid cardinality or identifiers
    // must fail open for the host turn, never turn a persistence boundary into
    // a ContextEngine exception.
    try {
      const repository = new ConversationEventRepository(db, this.policy());
      repository.enforceRetention(this.config.conversationJournal?.retentionDays ?? 0, Date.now(), this.scope());
      repository.cancelUnsupportedDerivedTasks(this.scope(), ["summary_l1", "summary_l2"]);
      const inputs = messages.map((message, index) => {
        const value = this.toJournalInput(sessionId, message, options.baseIndex + index, options), host = asHostMessage(message), hostEntryId = typeof host.id === "string" && host.id.trim() ? host.id.trim().slice(0, 512) : undefined;
        return hostEntryId ? { ...value, hostEntryId } : value;
      });
      const correlation = `context-turn:${digest(`${sessionId}\u0000${options.source}\u0000${inputs.map(input => input.hostCorrelation ?? "").join("\u0000")}`)}`;
      const receipt = repository.captureTurn({ scope: this.scope(), sessionId, hostCorrelation: correlation, events: inputs, derivedTaskKinds: this.lifecycle.derivedTaskKinds?.() ?? [] });
      if (receipt.inserted) new ToolPayloadArtifactService(this.config, db).archiveCaptured(this.scope(), receipt.events, messages.map(asHostMessage));
      return receipt;
    } catch (error) {
      this.reportCaptureFailure(options.source, messages.length, error);
      return undefined;
    }
  }

  private reportCaptureFailure(source: string, messageCount: number, error: unknown): void {
    const code = error instanceof Error ? error.message : "";
    const category = /^(?:invalid_journal_turn|invalid_session_id|invalid_journal_event|invalid_journal_parent)$/.test(code) ? "invalid_input" : "persistence_failed";
    try { this.lifecycle.onCaptureFailure?.({ source, category, messageCount: Math.max(0, Math.min(512, Number.isFinite(messageCount) ? Math.floor(messageCount) : 0)) }); } catch { /* observability must remain fail-open */ }
  }

  private completedTurn(sessionId: string, messages: readonly RuntimeMessage[], isHeartbeat: boolean, runtimeLlm?: import("./lifecycle.js").RuntimeCompletion, signal?: AbortSignal): CompletedTurn | undefined {
    if (isHeartbeat) return undefined;
    let userText: string | undefined, assistantText: string | undefined, agentId: string | undefined;
    for (const message of messages) {
      const host = asHostMessage(message);
      if (contextDomain(host) !== "user_chat") continue;
      const role = typeof host.role === "string" ? host.role.toLowerCase() : "";
      const text = messageText(host).trim();
      if (!text) continue;
      if (role === "user") { userText = text; assistantText = undefined; agentId = this.publicAgentId(host); }
      else if (role === "assistant") assistantText = text.replace(/<(?:mnemora_graph_context|mnemora_memory)\b[^>]*>[\s\S]*?<\/(?:mnemora_graph_context|mnemora_memory)>/gi, "").trim() || undefined;
    }
    return userText && assistantText ? { sessionId, userText, assistantText, ...(agentId ? { agentId } : {}), ...(runtimeLlm ? { runtimeLlm } : {}), ...(signal ? { signal } : {}) } : undefined;
  }

  /**
   * Agent identity is optional host metadata. It is never derived from a
   * session ID, role, prompt, or tool envelope; an unfamiliar host simply has
   * no identity for exclusion policy purposes.
   */
  private publicAgentId(message: HostMessage): string | undefined {
    const raw = message.agentId ?? message.agent_id;
    if (typeof raw !== "string") return undefined;
    const value = raw.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value) ? value : undefined;
  }

  private activeAgentId(messages: readonly RuntimeMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
      const host = asHostMessage(messages[index]);
      if (contextDomain(host) === "user_chat" && String(host.role ?? "").toLowerCase() === "user") return this.publicAgentId(host);
    }
    return undefined;
  }

  private isExcludedAgent(agentId: string | undefined): boolean {
    return Boolean(agentId && this.config.recall?.excludedAgentIds?.includes(agentId));
  }

  private toJournalInput(sessionId: string, message: RuntimeMessage, ordinal: number, options: { isHeartbeat?: boolean; source: string }): JournalEventInput {
    const host = asHostMessage(message);
    const domain = options.isHeartbeat ? "background" : contextDomain(host);
    const rawRole = typeof host.role === "string" ? host.role.toLowerCase() : "";
    const role: JournalRole | undefined = domain === "user_chat" && rawRole === "user" ? "user" : domain === "user_chat" && rawRole === "assistant" ? "assistant" : domain === "tool" && rawRole === "tool" ? "tool" : domain === "system" ? "system" : undefined;
    const kind: JournalEventKind = role === "assistant" ? "assistant_message" : role === "tool" ? "tool_result" : role === "user" ? "user_message" : "system_marker";
    return {
      scope: this.scope(),
      sessionId,
      kind,
      role,
      contextDomain: domain,
      parts: [{ type: "text", text: messageText(host) }],
      hostCorrelation: this.correlation(sessionId, host, ordinal, options.source),
      identityOrigin: "host"
    };
  }

  private correlation(sessionId: string, message: HostMessage, ordinal: number, source: string): string {
    const explicitId = typeof message.id === "string" && message.id.trim() ? message.id.trim().slice(0, 256) : undefined;
    const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? String(Math.floor(message.timestamp)) : "";
    const identity = explicitId ? `id:${explicitId}` : `position:${source}:${ordinal}:timestamp:${timestamp}:role:${String(message.role ?? "")}:text:${messageText(message, 4096)}`;
    return `context:${digest(`${sessionId}\u0000${identity}`)}`;
  }
}

function isCompactionEnvelope(message: HostMessage): boolean {
  const text = messageText(message, 256);
  return /<MNEMORA_COMPACTION\b|<MNEMORA_COMPACTED\b/i.test(text);
}

/** Keep host system/tool continuity intact while replacing only old ordinary
 * conversation turns with a source-linked projection. The active user turn is
 * still protected later by selectBoundHostMessages. */
function freshTail(messages: HostMessage[], count: number): HostMessage[] {
  const bounded = Math.max(2, Math.min(50, Math.floor(count)));
  const conversational = messages.flatMap((message, index) => contextDomain(message) === "user_chat" ? [index] : []);
  const keep = new Set(conversational.slice(-bounded));
  return messages.filter((message, index) => contextDomain(message) !== "user_chat" || keep.has(index));
}
