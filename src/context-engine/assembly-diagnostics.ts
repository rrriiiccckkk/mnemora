import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { authorizeMnemoraContextRef } from "../context/context-ref.js";
import { fileURLToPath } from "node:url";
import type { RetrievalCandidate } from "../retrieval/types.js";
import { mnemoraVersion } from "../version.js";

export interface AssemblyDiagnosticOptions {
  enabled?: boolean;
  directory?: string;
  scopes?: string[];
  expiresAt?: number;
}
export interface DiagnosticSegment { kind: "unified_retrieval" | "reasoning" | "compaction"; text: string; candidates?: readonly RetrievalCandidate[]; summaryId?: string; origin?: "plugin_projection" | "host_message"; graphAttached?: boolean; sourceRefs?: string[]; sourceWindow?: string; windowTruncated?: boolean; contentTruncated?: boolean; }
const MAX_RECORDS = 20, MAX_BYTES = 65536;

/** Optional plugin-handoff metadata. Never stores prompt/query/record text;
 * a handoff is not evidence of host/provider delivery or semantic truth. */
export function recordAssemblyDiagnostic(options: AssemblyDiagnosticOptions | undefined, input: { scope: string; sessionId: string; estimatedTokens: number; segments: readonly DiagnosticSegment[] }, now = Date.now()): "disabled" | "recorded" | "unavailable" {
  if (options?.enabled !== true) return "disabled";
  // POSIX mode bits cannot establish a private Windows ACL. Never weaken
  // the privacy gate to make a diagnostic write succeed on that platform.
  if (process.platform === "win32") return "unavailable";
  let lockPath: string | undefined;
  try {
    if (!options.scopes?.includes(input.scope) || !Number.isSafeInteger(options.expiresAt) || options.expiresAt! <= now || options.expiresAt! > now + 86400000 || !options.directory || !isAbsolute(options.directory)) return "unavailable";
    const directory = resolve(options.directory), repository = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, ""), stat = lstatSync(directory);
    if (directory === repository || directory.startsWith(repository + sep)) return "unavailable";
    // Require an already-created private, owned, canonical directory. No
    // default paths, recursive mkdir, symlink traversal or broad cleanup.
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return "unavailable";
    const lock = join(directory, ".assembly-diagnostic-lock");
    const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(lockFd); lockPath = lock;
    if (readdirSync(directory).filter(name => /^assembly-[a-f0-9-]+\.json$/.test(name)).length >= MAX_RECORDS || input.segments.length > 20) return "unavailable";
    const keyPath = join(directory, ".assembly-diagnostic-key");
    try {
      const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, randomBytes(32)); } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let key: Buffer;
    try { const info = fstatSync(fd); if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe_diagnostic_key"); key = readFileSync(fd); } finally { closeSync(fd); }
    const fingerprint = (value: string) => createHmac("sha256", key).update(value).digest("hex");
    const ref = (value: string) => authorizeMnemoraContextRef(value, { scope: input.scope }).canonical;
    const segments = input.segments.map((segment, ordinal) => {
      const candidates = (segment.candidates ?? []).slice(0, 20).map((candidate, index) => {
        authorizeMnemoraContextRef(candidate.contextRef, { scope: input.scope, kinds: [candidate.kind] });
        const sourceRefs: string[] = []; let unavailableSources = 0;
        for (const source of candidate.sourceRefs.slice(0, 20)) { try { sourceRefs.push(ref(source)); } catch { unavailableSources++; } }
        const evidence = candidate.projectionEvidence;
        return { ordinal: index, kind: candidate.kind, contextRef: ref(candidate.contextRef), sourceRefs, unavailableSources,
          sourcesTruncated: candidate.sourceRefs.length > 20, projectionFingerprint: fingerprint(candidate.excerpt),
          ...(evidence ? { claimVerification: evidence.claim_verification, sourceWindow: evidence.source_window, windowTruncated: evidence.truncated, windowMetadataTruncated: evidence.sources.length > 3,
            windowSources: evidence.sources.slice(0, 3).map(source => ({ ref: ref(source.source_ref), role: source.role, createdAt: source.created_at, truncated: source.truncated })) } : {}) };
      });
      return { ordinal, kind: segment.kind, ...(segment.kind === "unified_retrieval" ? { graphAttached: segment.graphAttached ?? false } : {}), ...(segment.origin ? { origin: segment.origin } : {}), ...(segment.summaryId ? { summaryRef: ref(`mnemora://v1/scope/${encodeURIComponent(input.scope)}/summary/${encodeURIComponent(segment.summaryId)}`) } : {}),
        ...(segment.kind === "compaction" ? { sourceRefs: segment.sourceRefs?.slice(0, 20).map(ref) ?? [], sourceWindow: segment.sourceWindow ?? "unknown", windowTruncated: segment.windowTruncated ?? null, contentTruncated: segment.contentTruncated ?? null } : {}),
        renderedBytes: Buffer.byteLength(segment.text), renderedFingerprint: fingerprint(segment.text), candidates,
        candidatesTruncated: (segment.candidates?.length ?? 0) > 20,
        candidateCoverage: segment.kind === "unified_retrieval" ? "local_candidates_only_graph_untracked" : "unavailable" };
    });
    const record = { version: "assembly-diagnostic-v1", implementationVersion: mnemoraVersion, id: `assembly:${randomUUID()}`, createdAt: now, expiresAt: options.expiresAt,
      stage: "plugin_handoff", hostDelivery: "unknown", hostTurnId: null, sessionFingerprint: fingerprint(input.sessionId), scope: input.scope,
      estimatedTokens: input.estimatedTokens, fingerprintAlgorithm: "HMAC-SHA256", contentCapture: "none", segments, hostTruncation: "unknown", captureTruncated: segments.some(segment => segment.candidatesTruncated || segment.candidates.some(candidate => candidate.sourcesTruncated || ("windowMetadataTruncated" in candidate && candidate.windowMetadataTruncated))) };
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > MAX_BYTES) return "unavailable";
    const name = `assembly-${randomUUID()}`, temporary = join(directory, `.${name}.tmp`), target = join(directory, `${name}.json`);
    try { writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 }); renameSync(temporary, target); }
    catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    return "recorded";
  } catch { return "unavailable"; }
  finally { if (lockPath) try { unlinkSync(lockPath); } catch {} }
}
