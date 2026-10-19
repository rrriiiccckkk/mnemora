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
  // OpenClaw's runtime emits tool completions as `toolResult`; accept the
  // older `tool` spelling too for historical transcripts and compatible hosts.
  if (role === "tool" || role === "toolresult") return "tool";
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

const RECALL_PACKET = /<(?:mnemora_graph_context|mnemora_memory)\b[^>]*>[\s\S]*?<\/(?:mnemora_graph_context|mnemora_memory)>\s*/gi;

/** Remove recall packets that Mnemora itself attached, so a turn that carries
 * one is never captured, fingerprinted or queried as the user's own words.
 * Packet content cannot close the envelope early: rendering neutralizes
 * reserved Mnemora tags inside records. */
export function stripRecallPackets(text: string): string {
  return text.includes("<") ? text.replace(RECALL_PACKET, "") : text;
}

/** Place the recall packet just before the active (newest) user message.
 * Returns undefined when there is no user message or its content shape is
 * unknown; the caller then falls back to the system prompt addition. Host
 * message objects are copied, never mutated. */
export function placeRecallBeforeUserMessage<T extends HostMessage>(messages: readonly T[], packet: string): T[] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (contextDomain(message) !== "user_chat" || String(message.role ?? "").toLowerCase() !== "user") continue;
    const content = message.content;
    let placed: unknown;
    if (typeof content === "string") placed = `${packet}\n\n${content}`;
    else if (Array.isArray(content)) placed = [{ type: "text", text: packet }, ...content];
    else return undefined;
    const copy = messages.slice();
    copy[index] = { ...message, content: placed };
    return copy;
  }
  return undefined;
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
 * The newest user message and every following eligible message are preserved
 * verbatim, including an assistant tool call and its `toolResult`. Earlier
 * messages are retained newest-first only while they fit. An over-budget
 * current turn is deliberately surfaced to the host rather than broken by
 * dropping a required tool result.
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
  const freshStart = currentUser >= 0 ? currentUser : eligible.length;
  // This is a transaction boundary, not merely a recency preference. The
  // embedded host reassembles after tool execution; emitting the user prompt
  // without its following tool-result message makes the provider continue a
  // tool call with no result. Preserve the entire current-turn suffix even
  // when it exceeds the advisory budget, matching the host-visible behavior
  // expected by context engines such as Lossless Claw.
  for (let index = freshStart; index < eligible.length; index++) {
    selected.add(index);
    used += estimateMessageTokens(eligible[index]);
  }
  for (let index = freshStart - 1; index >= 0; index--) {
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
