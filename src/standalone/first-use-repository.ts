import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";

export type FirstUseAcceptanceState = "not_started" | "awaiting_capture" | "awaiting_cross_session_attachment" | "verified" | "expired";
export interface FirstUseAcceptance { state: FirstUseAcceptanceState; }

const VERIFICATION_TTL_MS = 60 * 60 * 1000;
const MARKER = /\bmnemora-verify-([a-f0-9]{32})\b/giu;

/** Stores only hashes of a human-visible, high-entropy acceptance marker and
 * the two participating host-session identities. It is deliberately separate
 * from automatic recall telemetry, which is aggregate-only. */
export class FirstUseVerificationRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {}

  start(scope: string): { marker: string; expiresAt: number } {
    const safeScope = normalizeScope(scope), now = this.now(), marker = `mnemora-verify-${randomBytes(16).toString("hex")}`, expiresAt = now + VERIFICATION_TTL_MS;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(safeScope, now, now);
      this.db.prepare("UPDATE mnemora_first_use_verifications SET status='expired',updated_at=? WHERE scope=? AND status IN ('started','captured')").run(now, safeScope);
      this.db.prepare(`INSERT INTO mnemora_first_use_verifications(
        id,scope,marker_hash,status,started_at,expires_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`).run(`first-use:${randomUUID()}`, safeScope, digest(marker), "started", now, expiresAt, now);
      this.db.exec(`DELETE FROM mnemora_first_use_verifications WHERE id NOT IN (
        SELECT id FROM mnemora_first_use_verifications ORDER BY started_at DESC,rowid DESC LIMIT 1000
      )`);
      this.db.exec("COMMIT");
      return { marker, expiresAt };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  recordCapture(input: { scope: string; sessionId: string; texts: readonly string[] }): void {
    const sessionHash = safeSessionHash(input.sessionId), markerHashes = markers(input.texts);
    if (!sessionHash || !markerHashes.length) return;
    const scope = normalizeScope(input.scope), now = this.now();
    for (const markerHash of markerHashes) this.db.prepare(`UPDATE mnemora_first_use_verifications
      SET status='captured',source_session_hash=?,captured_at=?,updated_at=?
      WHERE scope=? AND marker_hash=? AND status='started' AND expires_at>=?`).run(sessionHash, now, now, scope, markerHash, now);
  }

  recordActualAttachment(input: { scope: string; sessionId: string; query: string; attachment: string }): void {
    const sessionHash = safeSessionHash(input.sessionId), queryMarkers = new Set(markers([input.query]));
    if (!sessionHash || !queryMarkers.size) return;
    const matchingMarkers = markers([input.attachment]).filter(markerHash => queryMarkers.has(markerHash));
    if (!matchingMarkers.length) return;
    const scope = normalizeScope(input.scope), now = this.now();
    for (const markerHash of matchingMarkers) this.db.prepare(`UPDATE mnemora_first_use_verifications
      SET status='attached',attached_session_hash=?,attached_at=?,updated_at=?
      WHERE scope=? AND marker_hash=? AND status='captured' AND source_session_hash<>? AND expires_at>=?`).run(sessionHash, now, now, scope, markerHash, sessionHash, now);
  }

  status(scope: string): FirstUseAcceptance {
    const safeScope = normalizeScope(scope), now = this.now();
    this.db.prepare("UPDATE mnemora_first_use_verifications SET status='expired',updated_at=? WHERE scope=? AND status IN ('started','captured') AND expires_at<?").run(now, safeScope, now);
    const row = this.db.prepare("SELECT status FROM mnemora_first_use_verifications WHERE scope=? ORDER BY started_at DESC,rowid DESC LIMIT 1").get(safeScope) as { status?: unknown } | undefined;
    switch (row?.status) {
      case "started": return { state: "awaiting_capture" };
      case "captured": return { state: "awaiting_cross_session_attachment" };
      case "attached": return { state: "verified" };
      case "expired": return { state: "expired" };
      default: return { state: "not_started" };
    }
  }
}

function markers(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts.slice(0, 512)) {
    if (typeof text !== "string") continue;
    MARKER.lastIndex = 0;
    for (const match of text.slice(0, 16_384).matchAll(MARKER)) {
      found.add(digest(`mnemora-verify-${match[1]!.toLowerCase()}`));
      if (found.size >= 8) return [...found];
    }
  }
  return [...found];
}

function safeSessionHash(value: string): string | undefined {
  const sessionId = typeof value === "string" ? value.trim() : "";
  return sessionId && sessionId.length <= 512 && !/[\u0000-\u001f]/.test(sessionId) ? digest(sessionId) : undefined;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
