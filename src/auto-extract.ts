import { createHash } from "node:crypto";
import type { MnemoraConfig } from "./index.js";
import type { CompletedTurn } from "./context-engine/lifecycle.js";
import type { ExtractOptions } from "./extractor.js";
import type { ExtractionResult } from "./types.js";
import type { Mnemora } from "./tools.js";
import { applySensitiveContentPolicy } from "./journal/capture-policy.js";
import { isLowInformationAutomaticInput } from "./cognition/pre-admission.js";
import { planAutomaticExtractionInput } from "./extraction-input-quality.js";

export interface SafeLogger {
  debug?(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface AutoExtractDeps {
  config: MnemoraConfig;
  openGraph(): Mnemora;
  openGraphForAdmitted?(): Mnemora;
  logger: SafeLogger;
  now?: () => number;
}

export type AutoExtractOutcome =
  | { status: "busy" | "succeeded" | "failed"; extracted?: number };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

type FailureCategory = "timeout" | "aborted" | "http" | "invalid_response" | "ingestion" | "sqlite" | "shutdown" | "unknown";

/** A bounded internal signal: ingestion failed after extraction completed. */
class AutomaticIngestionError extends Error {
  readonly failureCode: string;

  constructor(category?: string) {
    super("automatic ingestion failed");
    this.name = "AutomaticIngestionError";
    this.failureCode = category && /^(invalid_input|unsupported_file|file_too_large|workspace_boundary|extraction_disabled|extraction_failed|persistence_failed|invalid_url|blocked_url|redirect_limit|content_too_large|fetch_failed)$/.test(category)
      ? `ingestion_${category}`
      : "automatic_ingestion_failed";
  }
}

function classifyFailure(error: unknown): FailureCategory {
  if (!(error instanceof Error)) return "unknown";
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (error.message === "automatic extraction timeout") return "timeout";
  if (error.name === "AbortError") return "aborted";
  if (/^LLM extraction failed:\s*\d{3}\b/.test(error.message)) return "http";
  if (/^LLM extraction (returned no content|returned invalid JSON|response was invalid)/i.test(error.message)) return "invalid_response";
  if (error instanceof AutomaticIngestionError) return "ingestion";
  if (code.startsWith("SQLITE_") || /sqlite/i.test(error.name)) return "sqlite";
  if (error.name === "RuntimeStoppedError" || /runtime stopped/i.test(error.message)) return "shutdown";
  return "unknown";
}

/** Never expose an arbitrary Error message: hook inputs and provider bodies are sensitive. */
function failureCode(error: unknown): string | undefined {
  return error instanceof AutomaticIngestionError ? error.failureCode : undefined;
}

function safeLog(logger: SafeLogger, level: "debug" | "warn", message: string, fields: Record<string, unknown>): void {
  try {
    logger[level]?.(message, fields);
  } catch { /* logging must never affect hook orchestration */ }
}

export function buildTurnKey(turn: CompletedTurn): { turnKey: string; source: string } {
  const identifier = turn.runId?.trim() || digest(`${turn.sessionId}\0${turn.userText}\0${turn.assistantText}`).slice(0, 24);
  return {
    turnKey: `extract:${turn.sessionId}:${identifier}`,
    source: `session:${turn.sessionId}:turn:${identifier}`
  };
}

const shorten = (text: string, size: number): string =>
  text.length <= size ? text : size <= 1 ? "…".slice(0, size) : `${text.slice(0, size - 1)}…`;

/** Only user-authored content is eligible to become automatic graph evidence. */
export function formatUserExtractionInput(turn: CompletedTurn, maxChars: number): { text: string; truncated: boolean } {
  const user = turn.userText.trim();
  const budget = Math.max(0, Math.floor(maxChars));
  return { text: shorten(user, budget), truncated: user.length > budget };
}

function safeAutomaticTurn(turn: CompletedTurn, config: MnemoraConfig): CompletedTurn | undefined {
  const policy = { sensitiveContentPolicy: config.conversationJournal?.sensitiveContentPolicy ?? "redact" } as const;
  const user = applySensitiveContentPolicy(turn.userText, policy);
  // A non-redactable policy deliberately prohibits all later automatic writes
  // and model calls for this turn. The user can still use an explicit manual
  // ingestion workflow after reviewing their input.
  if (!user.text) return undefined;
  const assistant = applySensitiveContentPolicy(turn.assistantText, policy);
  return { ...turn, userText: user.text, assistantText: assistant.text ?? "[REDACTED_ASSISTANT_CONTENT]" };
}

export class AutoExtractService {
  private readonly now: () => number;

  constructor(private readonly deps: AutoExtractDeps) {
    this.now = deps.now ?? Date.now;
  }

  async handle(turn: CompletedTurn): Promise<AutoExtractOutcome> {
    const safeTurn = safeAutomaticTurn(turn, this.deps.config);
    if (!safeTurn) return { status: "succeeded", extracted: 0 };
    // This is intentionally an explicit Formation-policy gate. Historical
    // autoExtract callers retain their input/provider behavior unless they
    // enable both Formation and pre-admission enforcement.
    if (this.deps.config.cognition?.formationShadow === true && this.deps.config.cognition.admission?.preAdmission?.mode === "enforce" && isLowInformationAutomaticInput(safeTurn.userText)) return { status: "succeeded", extracted: 0 };
    const inputQuality = this.deps.config.extraction?.autoInputQuality ?? { mode: "off", maxSegments: 16 };
    const planFor = (maxChars: number) => planAutomaticExtractionInput(safeTurn.userText, { maxChars, maxSegments: inputQuality.maxSegments ?? 16 });
    const extractionPlan = inputQuality.mode === "off" ? undefined : planFor(this.deps.config.extraction?.maxInputChars ?? 16000);
    if (inputQuality.mode === "enforce" && extractionPlan?.action === "skip") {
      safeLog(this.deps.logger, "debug", "automatic extraction input quality skipped", {
        sourceSegments: extractionPlan.sourceSegments,
        droppedSegments: extractionPlan.droppedSegments,
        highSignalSegments: extractionPlan.highSignalSegments,
        reasonCodes: extractionPlan.reasonCodes
      });
      return { status: "succeeded", extracted: 0 };
    }
    const { turnKey, source } = buildTurnKey(safeTurn);
    const turnHash = digest(turnKey).slice(0, 16);
    const timeoutMs = this.deps.config.extraction?.timeoutMs ?? 15000;
    const formatted = inputQuality.mode === "enforce" && extractionPlan
      ? { text: extractionPlan.text, truncated: extractionPlan.truncated }
      : formatUserExtractionInput(safeTurn, this.deps.config.extraction?.maxInputChars ?? 16000);
    if (inputQuality.mode === "shadow" && extractionPlan) {
      safeLog(this.deps.logger, "debug", "automatic extraction input quality observed", {
        turnHash,
        action: extractionPlan.action,
        sourceSegments: extractionPlan.sourceSegments,
        selectedSegments: extractionPlan.selectedSegments,
        droppedSegments: extractionPlan.droppedSegments,
        highSignalSegments: extractionPlan.highSignalSegments,
        reasonCodes: extractionPlan.reasonCodes
      });
    }
    const memoryFormatted = this.deps.config.memory?.captureOnAutoExtract === true
      ? inputQuality.mode === "enforce"
        ? (() => {
            const memoryPlan = planFor(this.deps.config.memory?.maxDocumentChars ?? 12000);
            return memoryPlan.action === "extract" ? { text: memoryPlan.text, truncated: memoryPlan.truncated } : undefined;
          })()
        : formatUserExtractionInput(safeTurn, this.deps.config.memory?.maxDocumentChars ?? 12000)
      : undefined;
    let attempt: number | undefined;
    let extract!: (text: string, source?: string, options?: ExtractOptions) => Promise<ExtractionResult>;
    try {
      const graph = this.deps.openGraph();
      try {
        const claim = graph.store.claimAutoRun(turnKey, this.now(), Math.max(timeoutMs * 2, 60000));
        if (claim.status !== "claimed") return { status: claim.status };
        attempt = claim.attempt;
        if (memoryFormatted) {
          try {
            graph.store.upsertMemoryDocument({
              content: memoryFormatted.text,
              title: `Conversation ${turnHash}`,
              source,
              scope: this.deps.config.scope?.default,
              metadata: { kind: "conversation_turn", truncated: memoryFormatted.truncated }
            });
          } catch { /* Optional local memory capture must not block extraction. */ }
        }
        extract = graph.extract.bind(graph);
      } finally {
        graph.close();
      }

      safeLog(this.deps.logger, "debug", "automatic extraction started", { turnHash, inputChars: formatted.text.length, truncated: formatted.truncated });
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let extraction: ExtractionResult;
      try {
        extraction = await Promise.race([
          extract(formatted.text, source, { signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("automatic extraction timeout"));
            }, timeoutMs);
          })
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      const count = extraction.entities.length + extraction.relations.length;
      const resultGraph = (this.deps.openGraphForAdmitted ?? this.deps.openGraph)();
      try {
        if (count > 0) {
          const committed = await resultGraph.ingestAutomaticExtraction({ text: formatted.text, source, scope: this.deps.config.scope?.default, extraction });
          if (committed.status === "failed") throw new AutomaticIngestionError(committed.error?.category);
        }
        resultGraph.store.finishAutoRun(turnKey, attempt, "succeeded", this.now());
        try { resultGraph.store.recordAutoMetric?.("extract", "succeeded", this.now()); } catch { /* telemetry must fail open */ }
      } finally {
        resultGraph.close();
      }
      safeLog(this.deps.logger, "debug", "automatic extraction succeeded", { turnHash, inputChars: formatted.text.length, extracted: count });
      return { status: "succeeded", extracted: count };
    } catch (error) {
      const errorCategory = classifyFailure(error);
      const errorCode = failureCode(error);
      if (attempt !== undefined) {
        try {
          const graph = (this.deps.openGraphForAdmitted ?? this.deps.openGraph)();
          try {
            graph.store.finishAutoRun(turnKey, attempt, "failed", this.now(), errorCode ?? errorCategory);
            try { graph.store.recordAutoMetric?.("extract", "failed", this.now()); } catch { /* telemetry must fail open */ }
          } finally {
            graph.close();
          }
        } catch { /* fail open */ }
      }
      safeLog(this.deps.logger, "warn", "automatic extraction failed", { turnHash, inputChars: formatted.text.length, errorCategory, errorCode });
      return { status: "failed" };
    }
  }
}
