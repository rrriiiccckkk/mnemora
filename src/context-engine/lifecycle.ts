/**
 * Public-lifecycle values passed between the ContextEngine and optional local
 * services. They deliberately contain no hook envelope or host-private state.
 */
import type { ContextEngine } from "openclaw/plugin-sdk";

/** Public, host-owned model completion exposed by the ContextEngine runtime.
 * Mnemora never receives provider credentials or private host state through this
 * boundary. */
export type RuntimeCompletion = NonNullable<NonNullable<Parameters<NonNullable<ContextEngine["compact"]>>[0]["runtimeContext"]>["llm"]>;

export interface CompletedTurn {
  sessionId: string;
  runId?: string;
  userText: string;
  assistantText: string;
  /** A public host identity, when the ContextEngine exposes one. It is never inferred. */
  agentId?: string;
  /** Present only when the public afterTurn lifecycle provided a host model. */
  runtimeLlm?: RuntimeCompletion;
  /** Host cancellation is propagated into every optional model call. */
  signal?: AbortSignal;
}

export interface ContextAssemblyInput {
  sessionId: string;
  query: string;
  tokenBudget: number;
  /** An explicit, validated host identity when the active user envelope has one. */
  agentId?: string;
  signal?: AbortSignal;
}
