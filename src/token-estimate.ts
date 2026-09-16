/**
 * Conservative local token estimate shared by selection, rendering, and
 * ContextEngine accounting. JavaScript string length is not a safe proxy for
 * CJK or astral text, so count Unicode code points and charge dense scripts
 * independently.
 */
const isDenseCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
  (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
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
    if (isDenseCodePoint(character.codePointAt(0) ?? 0)) dense++;
    else ordinary++;
  }
  return Math.max(1, dense + Math.ceil(ordinary / 4));
}

export const estimateCompactionTokens = estimateTextTokens;
