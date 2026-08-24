import { normalizeScope } from "../scope.js";

export const MNEMORA_CONTEXT_REF_VERSION = "v1" as const;
/** Append-only kind registry revision for the unchanged v1 URI grammar. */
export const MNEMORA_CONTEXT_REF_KIND_REGISTRY_REVISION = 6 as const;
export const MNEMORA_CONTEXT_REF_KINDS = [
  "conversation-event",
  "artifact",
  "summary",
  "episode",
  "claim",
  "memory-candidate",
  "memory-document",
  "corpus-chunk",
  "belief",
  "decision",
  "task-outcome",
  "reasoning-memory",
  "reasoning-delivery-item",
  "profile",
  "retrieval-trace"
] as const;

export type MnemoraContextRefKind = typeof MNEMORA_CONTEXT_REF_KINDS[number];
export type MnemoraContextRefErrorCode =
  | "invalid_scheme"
  | "unsupported_version"
  | "invalid_shape"
  | "invalid_encoding"
  | "invalid_scope"
  | "invalid_kind"
  | "invalid_id"
  | "non_canonical"
  | "scope_mismatch"
  | "resolution_failed"
  | "aborted";

export interface MnemoraContextRef {
  version: typeof MNEMORA_CONTEXT_REF_VERSION;
  scope: string;
  kind: MnemoraContextRefKind;
  id: string;
  canonical: string;
}

export class MnemoraContextRefError extends Error {
  constructor(readonly code: MnemoraContextRefErrorCode) {
    super(code);
    this.name = "MnemoraContextRefError";
  }
}

const kindSet = new Set<string>(MNEMORA_CONTEXT_REF_KINDS);
const MAX_REFERENCE_BYTES = 1_024;
const MAX_ID_BYTES = 512;

/**
 * Build the only canonical v1 logical reference. References identify local
 * objects; they are not paths, URLs to fetch, or proof of source identity.
 */
export function createMnemoraContextRef(input: { scope: string; kind: MnemoraContextRefKind; id: string }): string {
  const scope = canonicalScope(input.scope);
  if (!kindSet.has(input.kind)) fail("invalid_kind");
  const id = canonicalId(input.id);
  return `mnemora://${MNEMORA_CONTEXT_REF_VERSION}/scope/${encodeSegment(scope)}/${input.kind}/${encodeSegment(id)}`;
}

/** Parse and fully canonicalize a v1 reference without resolving any object. */
export function parseMnemoraContextRef(value: unknown): MnemoraContextRef {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REFERENCE_BYTES) fail("invalid_shape");
  if (!value.startsWith("mnemora://")) fail("invalid_scheme");
  const match = /^mnemora:\/\/([^/]+)\/scope\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (!match) fail("invalid_shape");
  const [, version, encodedScope, kind, encodedId] = match;
  if (version !== MNEMORA_CONTEXT_REF_VERSION) fail("unsupported_version");
  if (!kindSet.has(kind)) fail("invalid_kind");
  const scope = canonicalScope(decodeSegment(encodedScope));
  const id = canonicalId(decodeSegment(encodedId));
  const canonical = createMnemoraContextRef({ scope, kind: kind as MnemoraContextRefKind, id });
  if (canonical !== value) fail("non_canonical");
  return { version: MNEMORA_CONTEXT_REF_VERSION, scope, kind: kind as MnemoraContextRefKind, id, canonical };
}

/**
 * Authorize scope and object kind before a repository ever sees the stable ID.
 * An empty kind list intentionally grants no access.
 */
export function authorizeMnemoraContextRef(value: unknown, access: { scope: string; kinds?: readonly MnemoraContextRefKind[] }): MnemoraContextRef {
  const parsed = parseMnemoraContextRef(value);
  if (parsed.scope !== canonicalScope(access.scope)) fail("scope_mismatch");
  if (access.kinds && !access.kinds.includes(parsed.kind)) fail("invalid_kind");
  return parsed;
}

/**
 * Resolver compatibility boundary. It never interprets a reference as a file
 * or network location and invokes the resolver only after scope authorization.
 */
export async function resolveMnemoraContextRef<T>(
  value: unknown,
  access: { scope: string; kinds?: readonly MnemoraContextRefKind[]; signal?: AbortSignal },
  resolver: (reference: MnemoraContextRef, signal?: AbortSignal) => T | Promise<T>
): Promise<T> {
  if (access.signal?.aborted) fail("aborted");
  const parsed = authorizeMnemoraContextRef(value, access);
  let result: T;
  try { result = await resolver(parsed, access.signal); }
  catch {
    if (access.signal?.aborted) fail("aborted");
    fail("resolution_failed");
  }
  if (access.signal?.aborted) fail("aborted");
  return result;
}

function canonicalScope(value: unknown): string {
  try {
    if (typeof value !== "string" || !value.trim()) fail("invalid_scope");
    const scope = normalizeScope(value, "default");
    if (scope !== value) fail("invalid_scope");
    return scope;
  } catch (error) {
    if (error instanceof MnemoraContextRefError) throw error;
    fail("invalid_scope");
  }
}

function canonicalId(value: unknown): string {
  if (typeof value !== "string" || !value || value === "." || value === ".." || Buffer.byteLength(value, "utf8") > MAX_ID_BYTES) fail("invalid_id");
  if (/[\u0000-\u001f\u007f\\/%?#]/u.test(value)) fail("invalid_id");
  return value;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { fail("invalid_encoding"); }
}

function fail(code: MnemoraContextRefErrorCode): never { throw new MnemoraContextRefError(code); }
