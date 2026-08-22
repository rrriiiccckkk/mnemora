import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { captureText } from "./capture-policy.js";
import type { JournalCapturePolicy, JournalDerivedTask, JournalDiagnostics, JournalEvent, JournalEventInput, JournalPart, JournalTurnCaptureInput, JournalTurnReceipt } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const safeId = (value: string, fallback: string) => value.trim() && value.length <= 512 && !/[\u0000-\u001f]/.test(value) ? value : fallback;
const parseParts = (rows: Array<{ payload: string }>): JournalPart[] => rows.map(row => JSON.parse(row.payload) as JournalPart);
const RETENTION_BATCH_SIZE = 256;
const REPLAY_GUARD_RETENTION_MS = 30 * 86_400_000;
const REPLAY_GUARD_MAX_PER_SCOPE = 10_000;

export class ConversationEventRepository {
  constructor(private readonly db: DatabaseSyncInstance, private readonly policy: JournalCapturePolicy) {}

  append(input: JournalEventInput): JournalEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { event } = this.appendInTransaction(input);
      this.db.exec("COMMIT");
      return event;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /**
   * Commits a host-provided message batch in one SQLite transaction. A retry
   * may return existing correlated events, but it can never leave only part of
   * a new completed turn committed.
   */
  appendBatch(inputs: readonly JournalEventInput[]): JournalEvent[] {
    if (!inputs.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const events = inputs.map(input => this.appendInTransaction(input).event);
      this.db.exec("COMMIT");
      return events;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  appendBatchWithStatus(inputs: readonly JournalEventInput[]): Array<{ event: JournalEvent; inserted: boolean }> {
    if (!inputs.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const events = inputs.map(input => this.appendInTransaction(input));
      this.db.exec("COMMIT");
      return events;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  /**
   * The only durable completed-turn write path. The receipt, every accepted
   * event, and every deferred derivation are committed together. A retry uses
   * the host correlation as an idempotency key and returns the original turn.
   */
  captureTurn(input: JournalTurnCaptureInput): JournalTurnReceipt {
    const scope = normalizeScope(input.scope), sessionId = safeId(input.sessionId, ""), branchId = safeId(input.branchId ?? "main", ""), correlation = safeId(input.hostCorrelation, "");
    if (!sessionId || !branchId || !correlation || input.events.length < 1 || input.events.length > 512) throw new Error("invalid_journal_turn");
    const now = input.createdAt ?? Date.now(), receiptId = `turn-receipt:${hash(`${scope}\u0000${correlation}`).slice(0, 48)}`, commitId = `turn-commit:${hash(`${scope}\u0000${correlation}`).slice(0, 48)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now);
      this.pruneReplayFloodGuardsInTransaction(scope, now);
      const existing = this.db.prepare("SELECT status FROM mnemora_capture_receipts WHERE id=? AND scope=?").get(receiptId, scope) as { status?: string } | undefined;
      if (existing?.status === "committed") {
        const replaySuppressed = this.recordReplay({ scope, sessionId, correlation: `turn:${correlation}`, external: input.events.some(event => event.identityOrigin === "host"), now });
        const receipt = this.readTurn(receiptId, commitId, scope, sessionId, branchId);
        this.db.exec("COMMIT");
        return { ...receipt, inserted: false, ...(replaySuppressed ? { replaySuppressed: true } : {}) };
      }
      if (existing) {
        // An interrupted pre-v5.1/manual receipt is safe to reconstruct: the
        // enclosing transaction means linked rows were never half-committed.
        this.db.prepare("DELETE FROM mnemora_derived_tasks WHERE commit_id=? AND scope=?").run(commitId, scope);
        this.db.prepare("DELETE FROM mnemora_turn_receipt_events WHERE receipt_id=? AND scope=?").run(receiptId, scope);
        this.db.prepare("DELETE FROM mnemora_commits WHERE id=? AND scope=?").run(commitId, scope);
        this.db.prepare("UPDATE mnemora_capture_receipts SET status='accepted',event_id=NULL,committed_at=NULL WHERE id=? AND scope=?").run(receiptId, scope);
      } else this.db.prepare("INSERT INTO mnemora_capture_receipts(id,scope,correlation_key,event_id,status,created_at) VALUES(?,?,?,?,?,?)").run(receiptId, scope, `turn:${correlation}`, null, "accepted", now);
      const captured: JournalEvent[] = [];
      input.events.forEach((value, ordinal) => {
        const parentId = value.parentId ?? (value.parentEventOrdinal == null ? undefined : captured[value.parentEventOrdinal]?.id);
        if (value.parentEventOrdinal != null && !parentId) throw new Error("invalid_journal_parent");
        const result = this.appendInTransaction({ ...value, scope, sessionId, branchId, ...(parentId ? { parentId } : {}), createdAt: value.createdAt ?? now }, false);
        captured.push(result.event);
        this.db.prepare("INSERT INTO mnemora_turn_receipt_events(receipt_id,event_id,scope,ordinal) VALUES(?,?,?,?)").run(receiptId, result.event.id, scope, ordinal);
        const entryId = value.hostEntryId && safeId(value.hostEntryId, "");
        if (entryId) this.db.prepare("INSERT OR IGNORE INTO mnemora_host_message_links(event_id,scope,entry_id,created_at) VALUES(?,?,?,?)").run(result.event.id, scope, entryId, now);
      });
      const contentHash = hash(captured.map(event => event.contentHash).join("\n"));
      this.db.prepare("INSERT INTO mnemora_commits(id,scope,receipt_id,status,event_count,content_hash,created_at,committed_at) VALUES(?,?,?,?,?,?,?,?)").run(commitId, scope, receiptId, "committed", captured.length, contentHash, now, now);
      for (const kind of [...new Set(input.derivedTaskKinds ?? [])].slice(0, 16)) {
        const id = `turn-task:${hash(`${commitId}\u0000${kind}`).slice(0, 48)}`;
        this.db.prepare("INSERT OR IGNORE INTO mnemora_derived_tasks(id,scope,commit_id,kind,status,attempts,created_at,updated_at) VALUES(?,?,?,?, 'pending',0,?,?)").run(id, scope, commitId, kind, now, now);
      }
      this.db.prepare("UPDATE mnemora_capture_receipts SET status='committed',committed_at=? WHERE id=? AND scope=?").run(now, receiptId, scope);
      const receipt = this.readTurn(receiptId, commitId, scope, sessionId, branchId);
      this.db.exec("COMMIT");
      return { ...receipt, inserted: true };
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  reclaimStaleDerivedTasks(scope: string, now = Date.now()): number {
    const result = this.db.prepare("UPDATE mnemora_derived_tasks SET status='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE scope=? AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<?").run(now, normalizeScope(scope), now) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** Retire legacy work kinds that have no runtime consumer.  This is safe to
   * run repeatedly and makes an interrupted pre-v6.1 queue observable rather
   * than leaving it permanently pending or running. */
  cancelUnsupportedDerivedTasks(scope: string, kinds: readonly string[], now = Date.now()): number {
    const safeKinds = [...new Set(kinds)].filter(kind => typeof kind === "string" && kind.length > 0 && kind.length <= 80).slice(0, 16);
    if (!safeKinds.length) return 0;
    const result = this.db.prepare(`UPDATE mnemora_derived_tasks SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_category='unsupported_derived_task',updated_at=? WHERE scope=? AND status IN ('pending','running') AND kind IN (${safeKinds.map(() => "?").join(",")})`).run(now, normalizeScope(scope), ...safeKinds) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  /** Apply the configured journal retention window without breaking evidence
   * references: the event is tombstoned and its raw parts are removed, while
   * receipts, provenance, and dependent history remain valid. */
  enforceRetention(retentionDays: number, now = Date.now(), scope?: string): number {
    const days = Math.floor(Number(retentionDays));
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = now - Math.min(3650, days) * 86_400_000;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const safeScope = scope == null ? undefined : normalizeScope(scope);
      const rows = safeScope
        ? this.db.prepare("SELECT id FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL AND created_at<? ORDER BY created_at ASC,id ASC LIMIT ?").all(safeScope, cutoff, RETENTION_BATCH_SIZE) as Array<{ id: string }>
        : this.db.prepare("SELECT id,scope FROM mnemora_conversation_events WHERE deleted_at IS NULL AND created_at<? ORDER BY created_at ASC,id ASC LIMIT ?").all(cutoff, RETENTION_BATCH_SIZE) as Array<{ id: string; scope: string }>;
      if (safeScope && rows.length) {
        const ids = rows.map(row => row.id), slots = ids.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM mnemora_conversation_parts WHERE scope=? AND event_id IN (${slots})`).run(safeScope, ...ids);
        this.db.prepare(`UPDATE mnemora_conversation_events SET normalized_text=NULL,deleted_at=? WHERE scope=? AND deleted_at IS NULL AND id IN (${slots})`).run(now, safeScope, ...ids);
      } else {
        const deleteParts = this.db.prepare("DELETE FROM mnemora_conversation_parts WHERE event_id=? AND scope=?");
        const tombstone = this.db.prepare("UPDATE mnemora_conversation_events SET normalized_text=NULL,deleted_at=? WHERE id=? AND scope=? AND deleted_at IS NULL");
        for (const row of rows as Array<{ id: string; scope: string }>) { deleteParts.run(row.id, row.scope); tombstone.run(now, row.id, row.scope); }
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  claimDerivedTasks(input: { scope: string; owner: string; kinds?: readonly string[]; maxTasks?: number; leaseMs?: number; maxAttempts?: number; now?: number }): JournalDerivedTask[] {
    const scope = normalizeScope(input.scope), owner = safeId(input.owner, ""), now = input.now ?? Date.now(), take = Math.min(20, Math.max(1, input.maxTasks ?? 4)), leaseMs = Math.min(300_000, Math.max(5_000, input.leaseMs ?? 45_000)), maxAttempts = Math.min(10, Math.max(1, input.maxAttempts ?? 3));
    if (!owner) throw new Error("invalid_task_lease");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reclaimStaleDerivedTasks(scope, now);
      const kinds = [...new Set(input.kinds ?? [])].filter(kind => kind.length > 0 && kind.length <= 80).slice(0, 16);
      const where = kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const rows = this.db.prepare(`SELECT id FROM mnemora_derived_tasks WHERE scope=? AND status='pending' AND attempts<?${where} ORDER BY created_at,id LIMIT ?`).all(scope, maxAttempts, ...kinds, take) as Array<{ id: string }>;
      const claimed: JournalDerivedTask[] = [];
      for (const row of rows) {
        const update = this.db.prepare("UPDATE mnemora_derived_tasks SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND scope=? AND status='pending'").run(owner, now + leaseMs, now, row.id, scope) as { changes?: number };
        if (update.changes) { const task = this.getDerivedTask(row.id, scope); if (task) claimed.push(task); }
      }
      this.db.exec("COMMIT");
      return claimed;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  finishDerivedTask(input: { id: string; scope: string; owner: string; status: "succeeded" | "failed" | "cancelled"; errorCategory?: string; now?: number }): boolean {
    const now = input.now ?? Date.now(), result = this.db.prepare("UPDATE mnemora_derived_tasks SET status=?,lease_owner=NULL,lease_expires_at=NULL,error_category=?,updated_at=? WHERE id=? AND scope=? AND status='running' AND lease_owner=?").run(input.status, input.errorCategory?.slice(0, 80) ?? null, now, input.id, normalizeScope(input.scope), safeId(input.owner, "")) as { changes?: number };
    return Number(result.changes ?? 0) === 1;
  }

  getDerivedTask(id: string, scope: string): JournalDerivedTask | undefined {
    const row = this.db.prepare("SELECT * FROM mnemora_derived_tasks WHERE id=? AND scope=?").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined;
    return row ? this.readTask(row) : undefined;
  }

  private appendInTransaction(input: JournalEventInput, recordEventCommit = true): { event: JournalEvent; inserted: boolean } {
    const scope = normalizeScope(input.scope);
    const sessionId = safeId(input.sessionId, "");
    if (!sessionId) throw new Error("invalid_session_id");
    const branchId = safeId(input.branchId ?? "main", "");
    if (!branchId || input.parts.length > 64) throw new Error("invalid_journal_event");
    const now = input.createdAt ?? Date.now();
    const correlation = input.hostCorrelation && safeId(input.hostCorrelation, "");
    this.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES(?,?,?)").run(scope, now, now);
    if (correlation) {
      const existing = this.db.prepare("SELECT id FROM mnemora_conversation_events WHERE scope=? AND host_correlation=?").get(scope, correlation) as { id?: string } | undefined;
      if (existing?.id) return { event: this.get(String(existing.id), scope)!, inserted: false };
    }
    const sequence = input.sequence ?? Number((this.db.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS value FROM mnemora_conversation_events WHERE scope=? AND session_id=? AND branch_id=?").get(scope, sessionId, branchId) as { value: number }).value);
    const parentId = input.parentId ? safeId(input.parentId, "") : undefined;
    if (parentId && !this.db.prepare("SELECT 1 FROM mnemora_conversation_events WHERE id=? AND scope=? AND session_id=? AND branch_id=?").get(parentId, scope, sessionId, branchId)) throw new Error("invalid_journal_parent");
    const parts = input.parts.flatMap(part => this.capturePart(part));
    const normalizedText = parts.filter((part): part is Extract<JournalPart, { type: "text" }> => part.type === "text").map(part => part.text).join("\n") || undefined;
    const id = safeId(input.id ?? randomUUID(), randomUUID());
    const contentHash = hash(JSON.stringify(parts));
    const origin = input.identityOrigin ?? (correlation ? "host" : "local_receipt");
    const contextDomain = input.contextDomain ?? (input.role === "user" || input.role === "assistant" ? "user_chat" : input.role === "tool" ? "tool" : input.role === "system" ? "system" : "unknown");
    this.db.prepare(`INSERT INTO mnemora_conversation_events(id,scope,session_id,branch_id,parent_id,sequence,kind,role,context_domain,identity_origin,host_correlation,content_hash,normalized_text,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, sessionId, branchId, parentId ?? null, sequence, input.kind, input.role ?? null, contextDomain, origin, correlation ?? null, contentHash, normalizedText ?? null, now);
    const insertPart = this.db.prepare("INSERT INTO mnemora_conversation_parts(event_id,scope,ordinal,kind,payload,created_at) VALUES(?,?,?,?,?,?)");
    parts.forEach((part, ordinal) => insertPart.run(id, scope, ordinal, part.type, JSON.stringify(part), now));
    if (recordEventCommit) {
      const receiptId = randomUUID();
      const receiptKey = correlation ?? `local:${receiptId}`;
      this.db.prepare("INSERT INTO mnemora_capture_receipts(id,scope,correlation_key,event_id,status,created_at,committed_at) VALUES(?,?,?,?,?,?,?)").run(receiptId, scope, receiptKey, id, "committed", now, now);
      this.db.prepare("INSERT INTO mnemora_commits(id,scope,receipt_id,status,event_count,content_hash,created_at,committed_at) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), scope, receiptId, "committed", 1, contentHash, now, now);
    }
    return { event: { id, scope, sessionId, branchId, ...(parentId ? { parentId } : {}), sequence, kind: input.kind, ...(input.role ? { role: input.role } : {}), contextDomain, parts, contentHash, ...(normalizedText ? { normalizedText } : {}), identityOrigin: origin, ...(correlation ? { hostCorrelation: correlation } : {}), createdAt: now }, inserted: true };
  }

  private readTurn(receiptId: string, commitId: string, scope: string, sessionId: string, branchId: string): Omit<JournalTurnReceipt, "inserted"> {
    const eventRows = this.db.prepare("SELECT event_id FROM mnemora_turn_receipt_events WHERE receipt_id=? AND scope=? ORDER BY ordinal").all(receiptId, scope) as Array<{ event_id: string }>;
    const tasks = this.db.prepare("SELECT * FROM mnemora_derived_tasks WHERE commit_id=? AND scope=? ORDER BY created_at,id").all(commitId, scope) as Array<Record<string, unknown>>;
    return { receiptId, commitId, scope, sessionId, branchId, events: eventRows.flatMap(row => { const event = this.get(row.event_id, scope); return event ? [event] : []; }), tasks: tasks.map(row => this.readTask(row)) };
  }

  /** Correlation is already an idempotency key. This secondary, content-free
   * receipt makes abnormal repeated delivery observable and marks it after a
   * separately bounded host/local threshold without changing stored evidence. */
  private recordReplay(input: { scope: string; sessionId: string; correlation: string; external: boolean; now: number }): boolean {
    const origin = input.external ? "external" : "internal";
    const configured = input.external ? this.policy.replayFloodThresholdExternal : this.policy.replayFloodThresholdInternal;
    const threshold = Number.isFinite(configured) ? Math.min(512, Math.max(1, Math.floor(configured!))) : input.external ? 24 : 8;
    const existing = this.db.prepare("SELECT delivery_count FROM mnemora_replay_flood_guards WHERE scope=? AND session_id=? AND correlation_key=? AND origin=?").get(input.scope, input.sessionId, input.correlation, origin) as { delivery_count: number } | undefined;
    const count = Number(existing?.delivery_count ?? 0) + 1, suppressed = count > threshold;
    this.db.prepare(`INSERT INTO mnemora_replay_flood_guards(scope,session_id,correlation_key,origin,delivery_count,first_seen_at,last_seen_at,suppressed_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,session_id,correlation_key,origin) DO UPDATE SET delivery_count=excluded.delivery_count,last_seen_at=excluded.last_seen_at,suppressed_at=COALESCE(mnemora_replay_flood_guards.suppressed_at,excluded.suppressed_at)`)
      .run(input.scope, input.sessionId, input.correlation, origin, count, input.now, input.now, suppressed ? input.now : null);
    return suppressed;
  }

  private pruneReplayFloodGuardsInTransaction(scope: string, now: number): number {
    const safe = normalizeScope(scope), cutoff = now - REPLAY_GUARD_RETENTION_MS;
    const deleteOldest = (where: string, values: unknown[], limit = RETENTION_BATCH_SIZE) => Number((this.db.prepare(`DELETE FROM mnemora_replay_flood_guards WHERE rowid IN (SELECT rowid FROM mnemora_replay_flood_guards WHERE ${where} ORDER BY last_seen_at ASC,rowid ASC LIMIT ?)`)
      .run(...values, limit) as { changes?: number }).changes ?? 0);
    const expired = deleteOldest("scope=? AND last_seen_at<?", [safe, cutoff]);
    const count = Number((this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_replay_flood_guards WHERE scope=?").get(safe) as { value: number }).value);
    // Do not evict a full maintenance batch when only one current guard is
    // over the cap. Expiry remains independently batched, while cap trimming
    // is exact and still bounded by the same one-call ceiling.
    return expired + (count > REPLAY_GUARD_MAX_PER_SCOPE ? deleteOldest("scope=?", [safe], Math.min(RETENTION_BATCH_SIZE, count - REPLAY_GUARD_MAX_PER_SCOPE)) : 0);
  }

  private readTask(row: Record<string, unknown>): JournalDerivedTask {
    return { id: String(row.id), scope: String(row.scope), commitId: String(row.commit_id), kind: String(row.kind), status: row.status as JournalDerivedTask["status"], attempts: Number(row.attempts), ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: Number(row.lease_expires_at) } : {}), ...(row.deadline_at ? { deadlineAt: Number(row.deadline_at) } : {}), ...(row.error_category ? { errorCategory: String(row.error_category) } : {}), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  get(id: string, scope: string): JournalEvent | undefined { return this.read(id, scope, false); }

  /** Resolve a durable provenance anchor without reviving retained content.
   * Normal retrieval intentionally hides tombstones; summary expansion may
   * expose only this metadata-only anchor so an evidence chain cannot appear
   * to terminate after retention. */
  getEvidenceAnchor(id: string, scope: string): JournalEvent | undefined { return this.read(id, scope, true); }

  private read(id: string, scope: string, includeTombstoned: boolean): JournalEvent | undefined {
    const row = this.db.prepare(`SELECT * FROM mnemora_conversation_events WHERE id=? AND scope=?${includeTombstoned ? "" : " AND deleted_at IS NULL"}`).get(id, normalizeScope(scope)) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const tombstoned = row.deleted_at != null;
    const parts = tombstoned ? [] : parseParts(this.db.prepare("SELECT payload FROM mnemora_conversation_parts WHERE event_id=? AND scope=? ORDER BY ordinal").all(id, row.scope) as Array<{ payload: string }>);
    return { id: String(row.id), scope: String(row.scope), sessionId: String(row.session_id), branchId: String(row.branch_id), ...(row.parent_id ? { parentId: String(row.parent_id) } : {}), sequence: Number(row.sequence), kind: row.kind as JournalEvent["kind"], ...(row.role ? { role: row.role as JournalEvent["role"] } : {}), contextDomain: (typeof row.context_domain === "string" ? row.context_domain : "unknown") as JournalEvent["contextDomain"], parts, contentHash: String(row.content_hash), ...(tombstoned ? { tombstoned: true as const } : row.normalized_text ? { normalizedText: String(row.normalized_text) } : {}), identityOrigin: row.identity_origin as JournalEvent["identityOrigin"], ...(row.host_correlation ? { hostCorrelation: String(row.host_correlation) } : {}), createdAt: Number(row.created_at) };
  }

  search(scope: string, query: string, limit = 20): JournalEvent[] {
    const bounded = query.trim().slice(0, 512), take = Math.min(100, Math.max(1, limit));
    if (!bounded) return [];
    const rows = this.db.prepare("SELECT id FROM mnemora_conversation_events WHERE scope=? AND deleted_at IS NULL AND instr(COALESCE(normalized_text,''),?)>0 ORDER BY created_at DESC,id DESC LIMIT ?").all(normalizeScope(scope), bounded, take) as Array<{ id: string }>;
    return rows.flatMap(row => { const event = this.get(row.id, scope); return event ? [event] : []; });
  }

  diagnostics(enabled: boolean): JournalDiagnostics {
    const counts = this.db.prepare("SELECT COUNT(*) AS events,COUNT(DISTINCT scope || ':' || session_id) AS sessions FROM mnemora_conversation_events WHERE deleted_at IS NULL").get() as { events: number; sessions: number };
    const pending = this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_derived_tasks WHERE status IN ('pending','running')").get() as { value: number };
    return { enabled, events: Number(counts.events), sessions: Number(counts.sessions), pendingTasks: Number(pending.value) };
  }

  private capturePart(part: JournalPart): JournalPart[] {
    let captured: JournalPart[];
    if (part.type !== "text" && !(part.type === "tool_result" && part.inlinePreview)) captured = [part];
    else {
      const result = captureText(part.type === "text" ? part.text : part.inlinePreview!, this.policy);
      if (result.outcome === "drop") return [];
      captured = part.type === "text"
        ? result.text ? [{ type: "text", text: result.text }] : []
        : [{ ...part, ...(result.text ? { inlinePreview: result.text } : { inlinePreview: undefined, truncated: true }) }];
    }
    // Non-text host parts must obey the same cap.  Drop only the oversized
    // part; never let a single hostile metadata field roll back a whole turn.
    return captured.filter(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= this.policy.maxEventBytes);
  }
}
