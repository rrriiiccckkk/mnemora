import type { JournalScopeActivity } from "../journal/types.js";
import type { FirstUseAcceptance } from "./first-use-repository.js";

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
  acceptance?: FirstUseAcceptance;
}): FirstUseVerification {
  const acceptance = input.acceptance ?? { state: "not_started" as const };
  const checks: FirstUseCheck[] = [
    input.contextEngineActive
      ? { id: "context_engine", state: "passed", detail: "Mnemora is the active ContextEngine." }
      : { id: "context_engine", state: "blocked", detail: "Mnemora has not confirmed its ContextEngine slot." },
    captureCheck(acceptance, input.activity),
    crossSessionCheck(acceptance),
    recallCheck(input, acceptance)
  ];
  const passed = checks.filter(check => check.state === "passed").length;
  return { complete: passed === checks.length, passed, total: 4, checks, nextStep: nextStep(checks, input, acceptance) };
}

function captureCheck(acceptance: FirstUseAcceptance, activity: JournalScopeActivity): FirstUseCheck {
  if (acceptance.state === "awaiting_cross_session_attachment" || acceptance.state === "verified") return { id: "capture", state: "passed", detail: "The current acceptance marker was durably captured." };
  if (acceptance.state === "expired") return { id: "capture", state: "pending", detail: "The latest acceptance marker expired before capture." };
  const baseline = activity.events > 0 && activity.lastCommittedAt != null ? " Existing Journal activity is only a baseline." : "";
  return { id: "capture", state: "pending", detail: `No current acceptance marker has been captured.${baseline}` };
}

function crossSessionCheck(acceptance: FirstUseAcceptance): FirstUseCheck {
  if (acceptance.state === "verified") return { id: "cross_session", state: "passed", detail: "The linked attachment occurred in a different conversation." };
  if (acceptance.state === "awaiting_cross_session_attachment") return { id: "cross_session", state: "pending", detail: "Open a new conversation and ask about the exact acceptance marker." };
  if (acceptance.state === "expired") return { id: "cross_session", state: "pending", detail: "Start a fresh acceptance; the previous one expired." };
  return { id: "cross_session", state: "pending", detail: "No current acceptance has linked a source and a later conversation." };
}

function recallCheck(input: Parameters<typeof firstUseVerification>[0], acceptance: FirstUseAcceptance): FirstUseCheck {
  if (!input.unifiedRetrievalEnabled) return { id: "recall", state: "blocked", detail: "Automatic recall is not enabled." };
  if (!input.recallTelemetryEnabled) return { id: "recall", state: "blocked", detail: "Redacted recall telemetry is not enabled, so an attachment cannot be verified." };
  if (acceptance.state === "verified") return { id: "recall", state: "passed", detail: "One linked automatic attachment included the acceptance marker." };
  if (acceptance.state === "awaiting_cross_session_attachment") return { id: "recall", state: "pending", detail: "No linked automatic attachment has been observed in a different conversation." };
  if (acceptance.state === "expired") return { id: "recall", state: "pending", detail: "The previous acceptance expired before an actual attachment." };
  const prior = input.recall.totalRuns > 0 || input.recall.attachedRuns > 0 ? " Historic recall telemetry cannot prove this acceptance." : "";
  return { id: "recall", state: "pending", detail: `No current acceptance attachment has been observed.${prior}` };
}

function nextStep(checks: readonly FirstUseCheck[], input: Parameters<typeof firstUseVerification>[0], acceptance: FirstUseAcceptance): string {
  if (checks[0].state !== "passed") return "Select Mnemora as the ContextEngine, then run /mnemora verify again.";
  if (!input.unifiedRetrievalEnabled) return "Enable unifiedRetrieval in the Mnemora plugin configuration, then repeat the question in the new conversation.";
  if (!input.recallTelemetryEnabled) return "Temporarily enable unifiedRetrieval.shadowMode to verify the first attachment; it stores only redacted counts and query hashes.";
  if (acceptance.state === "not_started" || acceptance.state === "expired") return "Run /mnemora verify start, include its exact marker in one fact, then ask about that marker in a new conversation.";
  if (checks[1].state !== "passed") return "In one conversation, share a fact that includes the exact acceptance marker, then run /mnemora verify again.";
  if (checks[2].state !== "passed" || checks[3].state !== "passed") return "Open a new conversation and ask a specific question containing the exact acceptance marker, then run /mnemora verify there.";
  return "First-use verification is complete. Mnemora will continue to apply its scope, freshness, and evidence safeguards.";
}
