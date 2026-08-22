import type { MnemoraConfig } from "../index.js";
import type { CompletedTurn } from "../context-engine/lifecycle.js";
import { ConversationEventRepository } from "./repository.js";
import type { JournalCapturePolicy, JournalDerivedTaskKind, JournalDiagnostics, JournalTurnReceipt } from "./types.js";
import { EpisodeRepository } from "../episodes/repository.js";
import { createHash } from "node:crypto";
import { sessionWriteDisposition, type SessionWriteDisposition } from "./session-policy.js";
import { SmartEpisodeExtractor } from "../episodes/smart-extraction.js";
import type { RuntimeCompletion } from "../context-engine/lifecycle.js";

/** A bounded, deterministic significance estimate for the one automatic
 * interaction candidate produced per completed turn.  It is deliberately a
 * filter signal rather than a claim of semantic understanding. */
export function automaticEpisodeImportance(events: readonly Pick<import("./types.js").JournalEvent, "role" | "normalizedText">[]): number {
  const user = events.find(event => event.role === "user")?.normalizedText?.trim() ?? "";
  const assistant = events.find(event => event.role === "assistant")?.normalizedText?.trim() ?? "";
  const length = user.length + assistant.length;
  const twoSided = user && assistant ? .15 : 0;
  const detail = Math.min(.45, Math.log2(1 + length) / 18);
  return Math.round(Math.min(.95, .15 + twoSided + detail) * 1_000_000) / 1_000_000;
}

export interface AutomaticEpisodeProposal {
  kind: import("../episodes/repository.js").EpisodeKind;
  title: string;
  importance: number;
  signals: readonly string[];
}

/**
 * Signal mode is deliberately local and evidence-preserving: it recognizes
 * explicit task language but never asks a model to infer a user trait, fact,
 * or preference. The output remains a proposal for a source-linked episode.
 */
export function automaticEpisodeProposal(events: readonly Pick<import("./types.js").JournalEvent, "role" | "normalizedText">[]): AutomaticEpisodeProposal {
  const user = events.filter(event => event.role === "user").map(event => event.normalizedText ?? "").join("\n").slice(0, 16_000);
  const all = events.map(event => event.normalizedText ?? "").join("\n").slice(0, 24_000);
  const matches = {
    correction: /\b(?:actually|correction|i was wrong|instead)\b|纠正|更正|改成|不是.{0,32}而是/u.test(user),
    incident: /\b(?:error|bug|incident|outage|rollback|failed|failure|regression)\b|报错|错误|故障|失败|回滚|事故/u.test(all),
    decision: /\b(?:decided|decision|choose|chosen|approved|we will|i will)\b|决定|确定|选择|采用|批准|同意/u.test(user),
    milestone: /\b(?:released|deployed|published|completed|shipped|merged)\b|发布|部署|完成|上线|合并/u.test(all)
  };
  const signals = Object.entries(matches).filter(([, matched]) => matched).map(([name]) => name);
  const base = automaticEpisodeImportance(events);
  if (matches.incident) return { kind: "incident", title: "explicit incident signal", importance: boundedImportance(base + .25), signals };
  if (matches.correction) return { kind: "experience", title: "explicit correction signal", importance: boundedImportance(base + .22), signals };
  if (matches.decision) return { kind: "decision", title: "explicit decision signal", importance: boundedImportance(base + .18), signals };
  if (matches.milestone) return { kind: "milestone", title: "explicit milestone signal", importance: boundedImportance(base + .15), signals };
  return { kind: "interaction", title: "interaction", importance: base, signals };
}

function boundedImportance(value: number): number { return Math.round(Math.min(.98, Math.max(0, value)) * 1_000_000) / 1_000_000; }

export class ConversationJournalService {
  constructor(private readonly config: MnemoraConfig, private readonly openGraph: () => import("../tools.js").Mnemora, private readonly runtimeTaskKinds?: () => readonly JournalDerivedTaskKind[]) {}
  private policy(): JournalCapturePolicy { const value = this.config.conversationJournal; return { maxInlineChars: value?.maxInlineChars ?? 16000, maxEventBytes: value?.maxEventBytes ?? 262144, sensitiveContentPolicy: value?.sensitiveContentPolicy ?? "redact", replayFloodThresholdExternal: value?.replayFloodThresholdExternal ?? 24, replayFloodThresholdInternal: value?.replayFloodThresholdInternal ?? 8 }; }
  derivedTaskKinds(): JournalDerivedTaskKind[] {
    const configured = this.runtimeTaskKinds?.();
    if (configured) return [...new Set(configured)].slice(0, 16);
    return [
      ...(this.config.extraction?.autoExtract ? ["auto_extract" as const] : []),
      ...(this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract
        ? this.config.episodicMemory.smartExtraction?.enabled ? ["smart_episode" as const] : ["episode" as const]
        : [])
    ];
  }
  sessionWriteDisposition(sessionId: string): SessionWriteDisposition { return sessionWriteDisposition(sessionId, this.config.conversationJournal); }
  shouldCaptureSession(sessionId: string): boolean { return this.sessionWriteDisposition(sessionId) === "writable"; }
  captureCompletedTurn(turn: CompletedTurn): JournalTurnReceipt | undefined {
    if (!this.shouldCaptureSession(turn.sessionId)) return undefined;
    const graph = this.openGraph();
    try {
      const repository = new ConversationEventRepository(graph.store.db, this.policy());
      const base = turn.runId?.trim() || createHash("sha256").update(`${turn.sessionId}\u0000${turn.userText}\u0000${turn.assistantText}`).digest("hex").slice(0, 32);
      const scope = this.config.scope!.default!;
      repository.enforceRetention(this.config.conversationJournal?.retentionDays ?? 0, Date.now(), scope);
      repository.cancelUnsupportedDerivedTasks(scope, ["summary_l1", "summary_l2"]);
      const receipt = repository.captureTurn({ scope, sessionId: turn.sessionId, hostCorrelation: `completed_turn:${base}`, derivedTaskKinds: this.derivedTaskKinds(), events: [
        { scope, sessionId: turn.sessionId, kind: "user_message", role: "user", parts: [{ type: "text", text: turn.userText }], hostCorrelation: `${base}:user`, identityOrigin: "host" },
        { scope, sessionId: turn.sessionId, kind: "assistant_message", role: "assistant", parentEventOrdinal: 0, parts: [{ type: "text", text: turn.assistantText }], hostCorrelation: `${base}:assistant`, identityOrigin: "host" }
      ] });
      if (receipt.inserted) this.runEpisodeTask(graph.store.db, receipt);
      return receipt;
    } finally { graph.close(); }
  }
  async processCapturedTurn(receipt: JournalTurnReceipt, runtime?: RuntimeCompletion, signal?: AbortSignal): Promise<void> {
    if (!receipt.inserted) return;
    const graph = this.openGraph();
    try {
      this.runEpisodeTask(graph.store.db, receipt);
      await this.runSmartEpisodeTask(graph.store.db, receipt, runtime, signal);
    }
    finally { graph.close(); }
  }
  claimDerivedTask(receipt: JournalTurnReceipt, kind: string, owner: string) {
    const graph = this.openGraph();
    try { return new ConversationEventRepository(graph.store.db, this.policy()).claimDerivedTasks({ scope: receipt.scope, owner, kinds: [kind], maxTasks: 1 }); }
    finally { graph.close(); }
  }
  finishDerivedTask(receipt: JournalTurnReceipt, id: string, owner: string, status: "succeeded" | "failed", errorCategory?: string): boolean {
    const graph = this.openGraph();
    try { return new ConversationEventRepository(graph.store.db, this.policy()).finishDerivedTask({ id, scope: receipt.scope, owner, status, errorCategory }); }
    finally { graph.close(); }
  }
  private runEpisodeTask(db: import("@photostructure/sqlite").DatabaseSyncInstance, receipt: JournalTurnReceipt): void {
    if (!(this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract) || this.config.episodicMemory.smartExtraction?.enabled) return;
    const repository = new ConversationEventRepository(db, this.policy()), owner = `episode:${receipt.commitId}`;
    const [task] = repository.claimDerivedTasks({ scope: receipt.scope, owner, kinds: ["episode"], maxTasks: 1 });
    if (!task) return;
    try {
      const assistant = receipt.events.find(event => event.role === "assistant")?.normalizedText?.trim();
      if (!assistant) throw new Error("episode_source_missing");
      const proposal = this.config.episodicMemory?.extractionMode === "signal"
        ? automaticEpisodeProposal(receipt.events)
        : { kind: "interaction" as const, title: undefined, importance: automaticEpisodeImportance(receipt.events) };
      // `minImportance` is a real admission floor. The automatic producer has
      // exactly one interaction candidate, so it can never exceed the
      // configured per-turn cap and low-signal chatter produces no episode.
      if (proposal.importance >= this.config.episodicMemory.minImportance!) {
        new EpisodeRepository(db).create({ scope: receipt.scope, kind: proposal.kind, ...(proposal.title ? { title: proposal.title } : {}), summary: assistant.slice(0, 16000), sourceEventIds: receipt.events.map(event => event.id), importance: proposal.importance, confidence: 1 });
      }
      repository.finishDerivedTask({ id: task.id, scope: receipt.scope, owner, status: "succeeded" });
    } catch { repository.finishDerivedTask({ id: task.id, scope: receipt.scope, owner, status: "failed", errorCategory: "episode_failed" }); }
  }
  private async runSmartEpisodeTask(db: import("@photostructure/sqlite").DatabaseSyncInstance, receipt: JournalTurnReceipt, runtime?: RuntimeCompletion, signal?: AbortSignal): Promise<void> {
    const smart = this.config.episodicMemory?.smartExtraction;
    if (!(this.config.episodicMemory?.enabled && this.config.episodicMemory.autoExtract && smart?.enabled)) return;
    const repository = new ConversationEventRepository(db, this.policy()), owner = `smart-episode:${receipt.commitId}`;
    const [task] = repository.claimDerivedTasks({ scope: receipt.scope, owner, kinds: ["smart_episode"], maxTasks: 1 });
    if (!task) return;
    try {
      const result = await new SmartEpisodeExtractor(smart).extract({ events: receipt.events, runtime, signal });
      if (result.status === "failed") { repository.finishDerivedTask({ id: task.id, scope: receipt.scope, owner, status: "failed", errorCategory: result.category }); return; }
      const episodes = new EpisodeRepository(db);
      for (const projection of result.episodes) episodes.create({
        scope: receipt.scope,
        kind: projection.kind,
        ...(projection.title ? { title: projection.title } : {}),
        summary: projection.summary,
        sourceEventIds: receipt.events.filter(event => event.role === "user" || event.role === "assistant").map(event => event.id),
        importance: projection.importance,
        confidence: 1
      });
      repository.finishDerivedTask({ id: task.id, scope: receipt.scope, owner, status: "succeeded" });
    } catch { repository.finishDerivedTask({ id: task.id, scope: receipt.scope, owner, status: "failed", errorCategory: "smart_episode_failed" }); }
  }
  diagnostics(): JournalDiagnostics { const graph = this.openGraph(); try { return new ConversationEventRepository(graph.store.db, this.policy()).diagnostics(this.config.conversationJournal?.enabled === true); } finally { graph.close(); } }
}
