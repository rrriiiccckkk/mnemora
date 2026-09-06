import type { JournalScopeActivity } from "../journal/types.js";

export type FirstUseCheckId = "context_engine" | "capture" | "cross_session" | "recall";
export type FirstUseCheckState = "passed" | "pending" | "blocked";

export interface FirstUseCheck { id: FirstUseCheckId; state: FirstUseCheckState; detail: string; }
export interface FirstUseVerification {
  complete: boolean;
  passed: number;
  total: 4;
  checks: FirstUseCheck[];
  nextStep: string;
}

/**
 * Converts bounded, already-persisted runtime signals into one first-use
 * acceptance result. The caller supplies only aggregates: this module never
 * accepts or returns messages, sources, event IDs, or query text.
 */
export function firstUseVerification(input: {
  contextEngineActive: boolean;
  unifiedRetrievalEnabled: boolean;
  recallTelemetryEnabled: boolean;
  activity: JournalScopeActivity;
  recall: { totalRuns: number; attachedRuns: number };
}): FirstUseVerification {
  const checks: FirstUseCheck[] = [
    input.contextEngineActive
      ? { id: "context_engine", state: "passed", detail: "Mnemora is the active ContextEngine." }
      : { id: "context_engine", state: "blocked", detail: "Mnemora has not confirmed its ContextEngine slot." },
    input.activity.events > 0 && input.activity.lastCommittedAt != null
      ? { id: "capture", state: "passed", detail: `${input.activity.events} events have been saved locally.` }
      : { id: "capture", state: "pending", detail: "No completed conversation has been saved yet." },
    input.activity.sessions >= 2
      ? { id: "cross_session", state: "passed", detail: "Saved memory is present across at least two conversations." }
      : { id: "cross_session", state: "pending", detail: "A second conversation has not been observed yet." },
    recallCheck(input)
  ];
  const passed = checks.filter(check => check.state === "passed").length;
  return { complete: passed === checks.length, passed, total: 4, checks, nextStep: nextStep(checks, input) };
}

function recallCheck(input: Parameters<typeof firstUseVerification>[0]): FirstUseCheck {
  if (!input.unifiedRetrievalEnabled) return { id: "recall", state: "blocked", detail: "Automatic recall is not enabled." };
  if (!input.recallTelemetryEnabled) return { id: "recall", state: "blocked", detail: "Redacted recall telemetry is not enabled, so an attachment cannot be verified." };
  if (input.recall.totalRuns === 0) return { id: "recall", state: "pending", detail: "No test question has reached automatic recall yet." };
  if (input.recall.attachedRuns === 0) return { id: "recall", state: "pending", detail: "Mnemora checked a question but safely attached no memory." };
  return { id: "recall", state: "passed", detail: `${input.recall.attachedRuns} automatic attachment${input.recall.attachedRuns === 1 ? "" : "s"} observed.` };
}

function nextStep(checks: readonly FirstUseCheck[], input: Parameters<typeof firstUseVerification>[0]): string {
  if (checks[0].state !== "passed") return "Select Mnemora as the ContextEngine, then run /mnemora verify again.";
  if (checks[1].state !== "passed") return "In this conversation, share one short fact you want to remember, then run /mnemora verify again.";
  if (checks[2].state !== "passed") return "Open a new conversation and ask a specific question about that fact, then run /mnemora verify there.";
  if (!input.unifiedRetrievalEnabled) return "Enable unifiedRetrieval in the Mnemora plugin configuration, then repeat the question in the new conversation.";
  if (!input.recallTelemetryEnabled) return "Temporarily enable unifiedRetrieval.shadowMode to verify the first attachment; it stores only redacted counts and query hashes.";
  if (checks[3].state !== "passed") return "Ask a more specific question that includes a distinctive word from the saved fact, then run /mnemora verify again.";
  return "First-use verification is complete. Mnemora will continue to apply its scope, freshness, and evidence safeguards.";
}
