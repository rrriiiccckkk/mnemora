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

export type ScopeIsolation = "agent" | "shared";

/** Agent id embedded in an OpenClaw session key such as `agent:<id>:main`. */
export function agentIdFromSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^agent:([^:\s]{1,64}):/u.exec(value.trim());
  return match?.[1];
}

/**
 * The scope automatic memory is read from and written to for one agent.
 *
 * `shared` keeps the pre-1.33 behaviour (every agent uses `scope.default`).
 * `agent` (default) gives each agent its own scope `agent:<id>`, except the
 * host's default agent which keeps `scope.default` so single-agent installs
 * see their existing memory unchanged. Unknown agents fall back to the default.
 */
export function agentScope(config: { scope?: { default?: string; isolation?: ScopeIsolation; defaultAgentId?: string } }, agentId: string | undefined): string {
  const fallback = configuredScope(config.scope?.default, "default");
  if (config.scope?.isolation === "shared" || !agentId) return fallback;
  const slug = agentId.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  if (!slug || slug === (config.scope?.defaultAgentId ?? "main").trim().toLowerCase()) return fallback;
  return `agent:${slug}`;
}
