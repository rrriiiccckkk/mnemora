import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createMnemoraContextRef } from "../context/context-ref.js";
import { DecisionMemoryService } from "../cognition/decisions.js";
import { normalizeScope } from "../scope.js";

export interface MemoryImpactPreview {
  previewHash: string; scope: string; target: { kind: "event" | "artifact" | "episode" | "summary"; id: string };
  affected: { events: string[]; artifacts: string[]; episodes: string[]; summaries: string[]; decisions: string[] };
  counts: { events: number; artifacts: number; episodes: number; summaries: number; decisions: number };
}
const bounded = (value: string) => value.trim().slice(0, 512);

/** Erasure is preview-confirmed and makes dependent decisions review-only. */
export class MemoryImpactService {
  constructor(private readonly db: DatabaseSyncInstance) {}

  preview(input: { scope: string; kind: "event" | "artifact" | "episode" | "summary"; id: string }): MemoryImpactPreview {
    const scope = normalizeScope(input.scope), id = bounded(input.id);
    if (!id) throw new Error("invalid_memory_target");
    const one = (sql: string) => (this.db.prepare(sql).all(scope, id) as Array<{ id: string }>).map(row => row.id);
    let events: string[] = [], artifacts: string[] = [], episodes: string[] = [], summaries: string[] = [];
    if (input.kind === "event") { events = [id]; artifacts = one("SELECT id FROM mnemora_artifacts WHERE scope=? AND source_event_id=? AND deleted_at IS NULL"); episodes = one("SELECT episode_id AS id FROM mnemora_episode_event_edges WHERE scope=? AND event_id=?"); summaries = this.summaryDependentsFromEvent(scope, id); }
    if (input.kind === "artifact") { artifacts = [id]; episodes = one("SELECT episode_id AS id FROM mnemora_episode_artifact_edges WHERE scope=? AND artifact_id=?"); }
    if (input.kind === "episode") episodes = [id];
    if (input.kind === "summary") summaries = this.summaryDependentsFromSummary(scope, id);
    const all = { events: [...new Set(events)], artifacts: [...new Set(artifacts)], episodes: [...new Set(episodes)], summaries: [...new Set(summaries)] };
    const base = { events: all.events.slice(0, 100), artifacts: all.artifacts.slice(0, 100), episodes: all.episodes.slice(0, 100), summaries: all.summaries.slice(0, 100) };
    const episodeRefs = base.episodes.map(episodeId => createMnemoraContextRef({ scope, kind: "episode", id: episodeId }));
    const placeholders = episodeRefs.map(() => "?").join(",") || "''";
    const decisions = (this.db.prepare(`SELECT DISTINCT d.id FROM mnemora_decisions d LEFT JOIN mnemora_decision_episodes de ON de.decision_id=d.id LEFT JOIN mnemora_decision_evidence ev ON ev.decision_id=d.id WHERE d.scope=? AND d.status='active' AND (de.episode_id IN (${placeholders}) OR ev.source_ref IN (${placeholders})) LIMIT 100`).all(scope, ...base.episodes, ...episodeRefs) as Array<{ id: string }>).map(row => row.id);
    const affected = { ...base, decisions }, target = { kind: input.kind, id };
    const previewHash = createHash("sha256").update(JSON.stringify({ scope, target, affected })).digest("hex");
    return { previewHash, scope, target, affected, counts: { events: all.events.length, artifacts: all.artifacts.length, episodes: all.episodes.length, summaries: all.summaries.length, decisions: affected.decisions.length } };
  }

  forget(input: { scope: string; kind: "event" | "artifact" | "episode" | "summary"; id: string; previewHash: string; confirm: boolean }): MemoryImpactPreview & { status: "confirm_required" | "forgotten" } {
    const preview = this.preview(input);
    if (!input.confirm) return { ...preview, status: "confirm_required" };
    if (preview.previewHash !== input.previewHash) throw new Error("stale_memory_preview");
    const now = Date.now(); this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.kind === "event") { this.db.prepare("UPDATE mnemora_conversation_events SET deleted_at=? WHERE id=? AND scope=?").run(now, preview.target.id, preview.scope); this.db.prepare("UPDATE mnemora_artifacts SET deleted_at=? WHERE scope=? AND source_event_id=?").run(now, preview.scope, preview.target.id); this.db.prepare("UPDATE mnemora_episodes SET status='archived',archived_at=? WHERE scope=? AND id IN (SELECT episode_id FROM mnemora_episode_event_edges WHERE scope=? AND event_id=?)").run(now, preview.scope, preview.scope, preview.target.id); this.invalidateSummaryDependentsFromEvent(preview.scope, preview.target.id, now); }
      if (input.kind === "artifact") this.db.prepare("UPDATE mnemora_artifacts SET deleted_at=? WHERE id=? AND scope=?").run(now, preview.target.id, preview.scope);
      if (input.kind === "episode") this.db.prepare("UPDATE mnemora_episodes SET status='deleted',deleted_at=? WHERE id=? AND scope=?").run(now, preview.target.id, preview.scope);
      if (input.kind === "summary") this.invalidateSummaryDependentsFromSummary(preview.scope, preview.target.id, now);
      new DecisionMemoryService(this.db, () => now).markEvidenceNeedsReview({ scope: preview.scope, decisionIds: preview.affected.decisions, sourceRefs: preview.affected.episodes.map(episodeId => createMnemoraContextRef({ scope: preview.scope, kind: "episode", id: episodeId })) });
      this.db.exec("COMMIT");
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    return { ...preview, status: "forgotten" };
  }

  private summaryDependentsFromEvent(scope: string, eventId: string): string[] {
    return (this.db.prepare(`WITH RECURSIVE impacted(id) AS (
      SELECT summary_id FROM mnemora_summary_event_edges WHERE scope=? AND event_id=?
      UNION
      SELECT edge.parent_summary_id FROM mnemora_summary_summary_edges edge JOIN impacted ON edge.child_summary_id=impacted.id WHERE edge.scope=?
    ) SELECT id FROM impacted ORDER BY id`).all(scope, eventId, scope) as Array<{ id: string }>).map(row => row.id);
  }

  private summaryDependentsFromSummary(scope: string, summaryId: string): string[] {
    return (this.db.prepare(`WITH RECURSIVE impacted(id) AS (
      SELECT ? AS id
      UNION
      SELECT edge.parent_summary_id FROM mnemora_summary_summary_edges edge JOIN impacted ON edge.child_summary_id=impacted.id WHERE edge.scope=?
    ) SELECT id FROM impacted ORDER BY id`).all(summaryId, scope) as Array<{ id: string }>).map(row => row.id);
  }

  private invalidateSummaryDependentsFromEvent(scope: string, eventId: string, now: number): void {
    this.db.prepare(`WITH RECURSIVE impacted(id) AS (
      SELECT summary_id FROM mnemora_summary_event_edges WHERE scope=? AND event_id=?
      UNION
      SELECT edge.parent_summary_id FROM mnemora_summary_summary_edges edge JOIN impacted ON edge.child_summary_id=impacted.id WHERE edge.scope=?
    ) UPDATE mnemora_summary_nodes SET deleted_at=?,injection_eligible=0 WHERE scope=? AND id IN (SELECT id FROM impacted)`).run(scope, eventId, scope, now, scope);
  }

  private invalidateSummaryDependentsFromSummary(scope: string, summaryId: string, now: number): void {
    this.db.prepare(`WITH RECURSIVE impacted(id) AS (
      SELECT ? AS id
      UNION
      SELECT edge.parent_summary_id FROM mnemora_summary_summary_edges edge JOIN impacted ON edge.child_summary_id=impacted.id WHERE edge.scope=?
    ) UPDATE mnemora_summary_nodes SET deleted_at=?,injection_eligible=0 WHERE scope=? AND id IN (SELECT id FROM impacted)`).run(summaryId, scope, now, scope);
  }
}
