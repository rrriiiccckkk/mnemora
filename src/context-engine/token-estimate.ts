/**
 * Conservative local token estimate used by every ContextEngine budget.
 *
 * JavaScript's `String.length` counts UTF-16 code units, not Unicode code
 * points. That makes astral characters appear larger than the text passed to
 * the host tokenizer. Conversely, treating CJK code points as four Latin
 * characters systematically underestimates Chinese, Japanese, and Korean
 * context. Use one code-point walk for selection, attachments, and compaction
 * accounting so those paths cannot disagree about a budget.
 */
const isDenseCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
  (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
  // CJK Unified Ideographs extensions are astral code points. Keep them in
  // the dense bucket instead of accidentally treating them as four Latin
  // characters merely because JavaScript represents them as surrogate pairs.
  (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
  (codePoint >= 0x2a700 && codePoint <= 0x2b81f) ||
  (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
  (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef) ||
  (codePoint >= 0x30000 && codePoint <= 0x323af) ||
  (codePoint >= 0x2f800 && codePoint <= 0x2fa1f);

export function estimateTextTokens(value: string): number {
  const text = typeof value === "string" ? value : "";
  let dense = 0;
  let ordinary = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isDenseCodePoint(codePoint)) dense++;
    else ordinary++;
  }
  return Math.max(1, dense + Math.ceil(ordinary / 4));
}

/** Backward-compatible name used by compaction and summary repositories. */
export const estimateCompactionTokens = estimateTextTokens;
