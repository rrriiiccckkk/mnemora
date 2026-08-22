import { createHash } from "node:crypto";

export function normalizeSlug(name: string, type: string): string {
  const normalizedType = type.normalize("NFKC").trim().toLowerCase().replace(/[^\w-]/g, "");
  const normalizedName = name.normalize("NFKC").trim().toLowerCase();
  const base = normalizedName.replace(/[\s_]+/g, "-");
  const completeAscii = base.replace(/[^\w-]/g, "");
  const readable = completeAscii.replace(/-+/g, "-").slice(0, 48);

  // Preserve legacy readable ids only when they represent the complete name.
  // Mixed-script names must retain a strong digest of the characters omitted
  // from the ASCII prefix, otherwise e.g. two different Chinese names ending
  // in "API" collapse to the same entity id.
  if (/[a-z0-9]{3,}/.test(base) && completeAscii === base && base.length <= 128) return `${normalizedType}:${base}`;

  const digest = identityHash(normalizedName, normalizedType);
  return `${normalizedType}:${readable || "entity"}-${digest.slice(0, 32)}`;
}

export function simpleHash(input: string): string {
  return createHash("sha256").update(input.normalize("NFKC")).digest("hex").slice(0, 32);
}

export function identityHash(name: string, type: string): string {
  return createHash("sha256")
    .update(type.normalize("NFKC").trim().toLowerCase())
    .update("\0")
    .update(name.normalize("NFKC").trim().toLowerCase())
    .digest("hex");
}

/**
 * Compatibility-only reproduction of the pre-v1.0.1 identifier algorithm.
 * It is deliberately exported for read-only integrity auditing, never for new
 * entity writes: mixed-script names can lose their distinguishing characters.
 */
export function legacyNormalizeSlug(name: string, type: string): string {
  const normalizedType = type.trim().toLowerCase().replace(/[^\w-]/g, "");
  const base = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (/[a-z0-9]{3,}/.test(base)) return `${normalizedType}:${base.replace(/[^\w-]/g, "")}`;
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${normalizedType}:${(hash >>> 0).toString(36)}`;
}
