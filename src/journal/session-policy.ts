/**
 * Session policy is intentionally a write policy, not a retrieval policy.
 * A stateless session may still receive ordinary host history and scoped
 * retrieval, but it never adds new Journal, episode, extraction, or derived
 * memory state. Globs are small, anchored, and converted without accepting
 * arbitrary regular expressions.
 */
export type SessionWriteDisposition = "writable" | "ignored" | "stateless";

export interface SessionWritePolicy {
  ignoreSessionPatterns?: readonly string[];
  statelessSessionPatterns?: readonly string[];
}

const MAX_PATTERNS = 32;
const MAX_PATTERN_CHARS = 160;
const MAX_SESSION_CHARS = 512;

export function normalizeSessionPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const patterns: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const pattern = candidate.trim();
    if (!pattern || pattern.length > MAX_PATTERN_CHARS || /[\u0000-\u001f]/.test(pattern) || patterns.includes(pattern)) continue;
    patterns.push(pattern);
    if (patterns.length >= MAX_PATTERNS) break;
  }
  return patterns;
}

export function sessionPatternsFromEnvironment(value: string | undefined): string[] {
  return normalizeSessionPatterns(typeof value === "string" ? value.split(/[\r\n,;]+/u) : []);
}

export function sessionWriteDisposition(sessionId: string, policy: SessionWritePolicy | undefined): SessionWriteDisposition {
  const value = typeof sessionId === "string" ? sessionId.trim().slice(0, MAX_SESSION_CHARS) : "";
  if (!value) return "ignored";
  if (matchesAny(value, policy?.ignoreSessionPatterns)) return "ignored";
  return matchesAny(value, policy?.statelessSessionPatterns) ? "stateless" : "writable";
}

function matchesAny(sessionId: string, patterns: readonly string[] | undefined): boolean {
  return normalizeSessionPatterns(patterns).some(pattern => globMatches(sessionId, pattern));
}

function globMatches(value: string, pattern: string): boolean {
  const text = [...value], glob = [...pattern];
  let textIndex = 0, globIndex = 0, star = -1, retry = 0;
  while (textIndex < text.length) {
    if (glob[globIndex] === "?" || glob[globIndex] === text[textIndex]) { textIndex++; globIndex++; continue; }
    if (glob[globIndex] === "*") { star = globIndex++; retry = textIndex; continue; }
    if (star < 0) return false;
    globIndex = star + 1; textIndex = ++retry;
  }
  while (glob[globIndex] === "*") globIndex++;
  return globIndex === glob.length;
}
