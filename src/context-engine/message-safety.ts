/**
 * Safety boundary for host conversation messages.  This module deliberately
 * deals only with runtime-message authority; it does not interpret or store
 * beliefs, claims, or recall candidates.
 */
import { estimateTextTokens } from "./token-estimate.js";

export type ContextDomain = "user_chat" | "system" | "tool" | "background" | "unknown";

export type HostMessage = { role?: string; content?: unknown; summary?: unknown; [key: string]: unknown };

export function contextDomain(message: HostMessage): ContextDomain {
  if (backgroundMarker(message)) return "background";
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role === "user" || role === "assistant") return "user_chat";
  if (role === "system" || role === "developer" || role === "compactionsummary" || role === "branchsummary") return "system";
  if (role === "tool") return "tool";
  return "unknown";
}

/**
 * Host envelopes are intentionally treated as untrusted.  A background marker
 * wins over a conversational role so a scheduler event cannot masquerade as a
 * user or system message merely by carrying a familiar role field.
 */
function backgroundMarker(message: HostMessage): boolean {
  const values = [message.kind, message.type, message.eventType, message.event_type, message.source, message.channel];
  return values.some(value => typeof value === "string" && /(cron|heartbeat|background|job|scheduler)/i.test(value));
}

/** Text is only for accounting or a lossy, bounded journal derivative. */
export function messageText(message: HostMessage, maxChars = 16000): string {
  const content = typeof message.content === "undefined" && typeof message.summary === "string" ? message.summary : message.content;
  let value = "";
  if (typeof content === "string") value = content;
  else try { value = JSON.stringify(content ?? ""); } catch { value = "[unserializable host message]"; }
  return value.slice(0, Math.max(0, maxChars));
}

export function estimateMessageTokens(message: HostMessage): number {
  // `messageText` is intentionally capped for journal derivatives. Prompt
  // accounting, however, must measure the original host message: returning
  // an untruncated message after accounting for only its first 16K characters
  // can silently exceed ContextEngine's declared budget.
  return estimateTextTokens(messageText(message, Number.MAX_SAFE_INTEGER));
}

/**
 * This safety filter preserves all ordinary conversation history verbatim.
 * It excludes only unknown and background envelopes, which must never acquire
 * user or system authority through a future host role change.
 */
export function promptEligibleMessages(messages: HostMessage[]): HostMessage[] {
  return messages.filter(message => {
    const domain = contextDomain(message);
    return domain === "user_chat" || domain === "system" || (domain === "tool" && hasToolResultContent(message));
  });
}

function hasToolResultContent(message: HostMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return Array.isArray(message.content) ? message.content.length > 0 : message.content != null;
}

export interface BoundedHostMessageSelection {
  messages: HostMessage[];
  estimatedTokens: number;
  droppedMessages: number;
  /** The active user message alone exceeded the available host budget. */
  overBudget: boolean;
}

/**
 * Assemble a safe, fresh tail without rewriting or truncating host messages.
 * The current user message is always preserved verbatim.  Earlier messages
 * are retained newest-first only while they fit, so an advisory configuration
 * cannot quietly turn into an unbounded prompt.
 */
export function selectBoundHostMessages(messages: HostMessage[], budget: number): BoundedHostMessageSelection {
  const eligible = promptEligibleMessages(messages);
  const maximum = Number.isFinite(budget) ? Math.max(1, Math.floor(budget)) : 1;
  let currentUser = -1;
  for (let index = eligible.length - 1; index >= 0; index--) {
    if (contextDomain(eligible[index]) === "user_chat" && String(eligible[index].role ?? "").toLowerCase() === "user") { currentUser = index; break; }
  }
  const selected = new Set<number>();
  let used = 0;
  if (currentUser >= 0) {
    selected.add(currentUser);
    used = estimateMessageTokens(eligible[currentUser]);
  }
  for (let index = eligible.length - 1; index >= 0; index--) {
    if (index === currentUser) continue;
    const tokens = estimateMessageTokens(eligible[index]);
    if (used + tokens > maximum) break;
    selected.add(index);
    used += tokens;
  }
  const bounded = eligible.filter((_message, index) => selected.has(index));
  return { messages: bounded, estimatedTokens: used, droppedMessages: eligible.length - bounded.length, overBudget: used > maximum };
}

/** Backward-compatible message-only projection for existing callers. */
export function boundHostMessages(messages: HostMessage[], budget: number): HostMessage[] {
  return selectBoundHostMessages(messages, budget).messages;
}
