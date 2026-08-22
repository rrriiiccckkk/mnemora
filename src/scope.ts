const scopePattern = /^[a-z0-9][a-z0-9._:-]{0,79}$/;

/**
 * Scopes are stable, non-secret identifiers used to keep evidence and memory
 * retrieval within one project or collection.  They deliberately are not file
 * paths, labels, or free-form user text.
 */
export function normalizeScope(value: unknown, fallback = "default"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const scope = value.trim().toLowerCase();
  if (!scopePattern.test(scope)) throw new Error("invalid_scope");
  return scope;
}

export function configuredScope(value: unknown, fallback = "default"): string {
  try { return normalizeScope(value, fallback); }
  catch { return fallback; }
}
