import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import { ConversationEventRepository } from "../journal/repository.js";
import type { JournalCapturePolicy, JournalEvent } from "../journal/types.js";
import { estimateCompactionTokens } from "./token-estimate.js";

export interface SummaryNode { id: string; scope: string; sessionId: string; branchId: string; level: number; content: string; estimatedTokens: number; injectionEligible: boolean; safetyVersion: number; createdAt: number; sourceEventIds: string[]; childSummaryIds: string[]; }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); };
export class SummaryRepository {
  private readonly events: ConversationEventRepository;
  constructor(private readonly db: DatabaseSyncInstance, policy: JournalCapturePolicy) { this.events = new ConversationEventRepository(db, policy); }
  create(input: { id?: string; scope: string; sessionId: string; branchId?: string; eventIds?: string[]; childSummaryIds?: string[]; content: string; maxChars: number; injectionEligible?: boolean; signal?: AbortSignal; now?: number }): SummaryNode {
    abort(input.signal); const scope = normalizeScope(input.scope), branchId = input.branchId ?? "main", eventIds = [...new Set(input.eventIds ?? [])].slice(0, 100), childIds = [...new Set(input.childSummaryIds ?? [])].slice(0, 100), content = input.content.trim().slice(0, Math.max(1, input.maxChars));
    if (!content || (!eventIds.length && !childIds.length)) throw new Error("invalid_summary");
    const eventRows = eventIds.map(id => this.events.get(id, scope)); if (eventRows.some(event => !event || event.sessionId !== input.sessionId || event.branchId !== branchId)) throw new Error("invalid_summary_source");
    this.ensureClosedToolPairs(eventRows as JournalEvent[]); abort(input.signal);
    const children = childIds.map(id => this.get(id, scope)); if (children.some(node => !node || node.sessionId !== input.sessionId || node.branchId !== branchId)) throw new Error("invalid_summary_source");
    const id = input.id ?? randomUUID(), now = input.now ?? Date.now(), level = Math.max(0, ...children.map(node => node!.level + 1)), estimate = estimateCompactionTokens(content);
    const sourceEligible = eventRows.every(event => event!.contextDomain === "user_chat") && children.every(node => node!.injectionEligible);
    const injectionEligible = input.injectionEligible == null ? sourceEligible : sourceEligible && input.injectionEligible;
    this.db.exec("BEGIN IMMEDIATE"); try { this.db.prepare("INSERT INTO mnemora_summary_nodes(id,scope,session_id,branch_id,level,content,content_hash,estimated_tokens,injection_eligible,safety_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, scope, input.sessionId, branchId, level, content, digest(content), estimate, injectionEligible ? 1 : 0, injectionEligible ? 1 : 0, now); const eventInsert = this.db.prepare("INSERT INTO mnemora_summary_event_edges(summary_id,event_id,scope,ordinal) VALUES(?,?,?,?)"); eventIds.forEach((eventId, ordinal) => eventInsert.run(id, eventId, scope, ordinal)); const summaryInsert = this.db.prepare("INSERT INTO mnemora_summary_summary_edges(parent_summary_id,child_summary_id,scope,ordinal) VALUES(?,?,?,?)"); childIds.forEach((childId, ordinal) => summaryInsert.run(id, childId, scope, ordinal)); this.db.exec("COMMIT"); } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return this.get(id, scope)!;
  }
  get(id: string, scope: string): SummaryNode | undefined { const row = this.db.prepare("SELECT * FROM mnemora_summary_nodes WHERE id=? AND scope=? AND deleted_at IS NULL").get(id, normalizeScope(scope)) as Record<string, unknown> | undefined; if (!row) return undefined; const events = this.db.prepare("SELECT event_id FROM mnemora_summary_event_edges WHERE summary_id=? AND scope=? ORDER BY ordinal").all(id, row.scope) as Array<{ event_id: string }>; const children = this.db.prepare("SELECT child_summary_id FROM mnemora_summary_summary_edges WHERE parent_summary_id=? AND scope=? ORDER BY ordinal").all(id, row.scope) as Array<{ child_summary_id: string }>; return { id: String(row.id), scope: String(row.scope), sessionId: String(row.session_id), branchId: String(row.branch_id), level: Number(row.level), content: String(row.content), estimatedTokens: Number(row.estimated_tokens), injectionEligible: Number(row.injection_eligible) === 1, safetyVersion: Number(row.safety_version ?? 0), createdAt: Number(row.created_at), sourceEventIds: events.map(x => x.event_id), childSummaryIds: children.map(x => x.child_summary_id) }; }
  list(scope: string, sessionId: string, branchId = "main", limit = 20): SummaryNode[] { const rows = this.db.prepare("SELECT id FROM mnemora_summary_nodes WHERE scope=? AND session_id=? AND branch_id=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?").all(normalizeScope(scope), sessionId, branchId, Math.min(100, Math.max(1, limit))) as Array<{ id: string }>; return rows.flatMap(x => { const value = this.get(x.id, scope); return value ? [value] : []; }); }
  /** Active roots are the only summary projections eligible for prompt assembly.
   * A child is represented through its parent, so selecting roots avoids
   * duplicate context while retaining a fully expandable evidence DAG. */
  roots(scope: string, sessionId: string, branchId = "main", limit = 8): SummaryNode[] {
    const normalized = normalizeScope(scope), bounded = Math.min(20, Math.max(1, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT n.id FROM mnemora_summary_nodes n
      WHERE n.scope=? AND n.session_id=? AND n.branch_id=? AND n.deleted_at IS NULL AND n.injection_eligible=1
      AND NOT EXISTS (SELECT 1 FROM mnemora_summary_summary_edges e JOIN mnemora_summary_nodes p ON p.id=e.parent_summary_id
        WHERE e.child_summary_id=n.id AND e.scope=n.scope AND p.deleted_at IS NULL)
      ORDER BY n.level DESC,n.created_at DESC,n.id DESC LIMIT ?`).all(normalized, sessionId, branchId, bounded) as Array<{ id: string }>;
    return rows.flatMap(row => { const value = this.get(row.id, normalized); return value?.injectionEligible ? [value] : []; });
  }
  /** A host may decline a requested rewrite after the source-linked summary has
   * been persisted. Retire that projection so it cannot later be surfaced as
   * if the transcript had been compacted. Sources and audit rows remain. */
  archive(id: string, scope: string, now = Date.now()): void { this.db.prepare("UPDATE mnemora_summary_nodes SET deleted_at=?,injection_eligible=0 WHERE id=? AND scope=? AND deleted_at IS NULL").run(now, id, normalizeScope(scope)); }
  /** A compaction summary remains non-injectable until its public host rewrite
   * has explicitly succeeded. */
  activate(id: string, scope: string): void { this.db.prepare("UPDATE mnemora_summary_nodes SET injection_eligible=1 WHERE id=? AND scope=? AND deleted_at IS NULL").run(id, normalizeScope(scope)); }
  expand(id: string, scope: string, maxDepth = 4): { summary: SummaryNode; events: JournalEvent[]; summaries: SummaryNode[] } | undefined { const root = this.get(id, scope); if (!root) return undefined; const events: JournalEvent[] = [], summaries: SummaryNode[] = [], seen = new Set<string>(); const visit = (node: SummaryNode, depth: number) => { if (seen.has(node.id) || depth > maxDepth) return; seen.add(node.id); summaries.push(node); for (const eventId of node.sourceEventIds) { const event = this.events.getEvidenceAnchor(eventId, scope); if (event) events.push(event); } for (const childId of node.childSummaryIds) { const child = this.get(childId, scope); if (child) visit(child, depth + 1); } }; visit(root, 0); return { summary: root, events, summaries }; }
  private ensureClosedToolPairs(events: JournalEvent[]): void { const calls = new Set<string>(), results = new Set<string>(); for (const event of events) for (const part of event.parts) { if (part.type === "tool_call") calls.add(part.callId); if (part.type === "tool_result") results.add(part.callId); } if ([...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id))) throw new Error("incomplete_tool_pair"); }
}
