import { isCanonicalId } from "../query/canonical-id.js";

/**
 * Inspector projections never carry observation bodies. These helpers retain
 * only stable source identity and relationship context for public summaries.
 */
export function redactedSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const source = value.replace(/[\u0000-\u001f]/g, " ").trim().replace(/\s+/g, " ");
  if (!source || source.length > 200) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.protocol}//${url.hostname}`;
  } catch { /* non-URL source identities are allowed below */ }
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(source)) return "local";
  if (/[\\/]/.test(source) || /(?:password|token|secret|api[_-]?key)/i.test(source)) return "redacted";
  return source;
}

export function redactedSummary(relationshipType: unknown): string {
  const type = typeof relationshipType === "string" && /^[a-z_]{1,100}$/.test(relationshipType)
    ? relationshipType.replace(/_/g, " ")
    : "related";
  return `Evidence summary for ${type} relationship.`;
}

export function safeInspectorText(value: unknown, maximum = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, " ").trim().replace(/\s+/g, " ");
  if (!text || text.length > maximum) return undefined;
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(text)) return "[redacted]";
  if (text.includes("://")) try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.toString();
    }
  } catch { /* malformed URL-like labels remain ordinary display text */ }
  return text;
}

export function safeInspectorId(value: unknown): string | undefined {
  return isCanonicalId(value) ? value : undefined;
}

export function safeInspectorCursorKey(value: unknown, maximum = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximum && !/[\u0000-\u001f]/.test(text) ? text : undefined;
}
