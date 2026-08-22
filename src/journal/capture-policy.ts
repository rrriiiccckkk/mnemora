import { createHash } from "node:crypto";
import type { JournalCapturePolicy } from "./types.js";

const labelledSecret = /(?:\b(?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie|credential|private[_-]?key)\b\s*[:=]\s*(?:Bearer\s+)?|\bBearer\s+)[^\s,;]+/gi;
// Common standalone credential forms must be removed even when a user pastes
// only the value, with no surrounding `token=` or `Authorization:` label.
const standaloneSecret = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,})\b/g;
const pem = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g;
export interface CapturedText { outcome: "store_full" | "store_redacted" | "store_hash_only" | "store_metadata_only" | "drop"; text?: string; contentHash: string; }
export type SensitiveTextDisposition = Omit<CapturedText, "contentHash">;

/** Keep the serialized journal part below SQLite's payload ceiling as well as
 * the operator's configured event limit.  The small reserve covers the JSON
 * envelope (`{type,text}`) without relying on an accidental SQLite abort. */
function boundUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let end = Math.max(0, Math.floor(value.length * maximum / Math.max(1, Buffer.byteLength(value, "utf8"))));
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximum) end--;
  return value.slice(0, end);
}

export function applySensitiveContentPolicy(input: string, policy: Pick<JournalCapturePolicy, "sensitiveContentPolicy">): SensitiveTextDisposition {
  const redacted = input.replace(pem, "[REDACTED_PRIVATE_KEY]").replace(labelledSecret, "[REDACTED_SECRET]").replace(standaloneSecret, "[REDACTED_SECRET]");
  if (redacted === input) return { outcome: "store_full", text: input };
  if (policy.sensitiveContentPolicy === "drop") return { outcome: "drop" };
  if (policy.sensitiveContentPolicy === "hash_only") return { outcome: "store_hash_only" };
  if (policy.sensitiveContentPolicy === "metadata_only") return { outcome: "store_metadata_only" };
  return { outcome: "store_redacted", text: redacted };
}

export function captureText(input: string, policy: JournalCapturePolicy): CapturedText {
  const bounded = boundUtf8(input.slice(0, policy.maxInlineChars), Math.max(0, policy.maxEventBytes - 256));
  return { ...applySensitiveContentPolicy(bounded, policy), contentHash: createHash("sha256").update(input).digest("hex") };
}
