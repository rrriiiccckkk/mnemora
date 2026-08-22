/**
 * Memory is untrusted reference material even when it was stored locally.
 * This projection-only guard preserves readable content while neutralising
 * wrapper delimiters, hidden controls, and common speaker-role impersonation.
 */
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const WRAPPER = /<\/?\s*mnemora_memory\b[^>]*>/giu;
const ROLE = /^(?:>?\s*)?(?:user|assistant|system|developer|tool|model|用户|助手|系统|开发者|工具)\s*[:：]/iu;
const CONFUSABLES: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y",
  "Α": "a", "Ε": "e", "Ο": "o", "Ρ": "p", "С": "c", "Χ": "x", "Υ": "y"
};

const roleLike = (line: string): boolean => {
  const folded = [...line.normalize("NFKC").replace(INVISIBLE, "")].map(char => CONFUSABLES[char] ?? char).join("");
  return ROLE.test(folded);
};

export function sanitizeMemoryForContext(value: unknown, maximum = 1200): string {
  if (typeof value !== "string") return "";
  const safe = value.normalize("NFKC").replace(INVISIBLE, "").replace(WRAPPER, "[memory-delimiter removed]");
  const quoted = safe.replace(/\r\n?/gu, "\n").split("\n")
    .map(line => roleLike(line) ? `[quoted-memory] ${line}` : line)
    .join("\n").trim();
  return quoted.slice(0, Math.max(0, Math.trunc(maximum)));
}
