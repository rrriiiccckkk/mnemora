import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { MnemoraContextRef } from "../context/context-ref.js";

/** Resolves canonical local references without treating them as paths or URLs. */
export class CognitionReferenceRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  requireActive(reference: MnemoraContextRef): void {
    const exists = (() => {
      switch (reference.kind) {
        case "conversation-event": return this.one("SELECT 1 FROM mnemora_conversation_events WHERE id=? AND scope=? AND deleted_at IS NULL", reference);
        case "artifact": return this.one("SELECT 1 FROM mnemora_artifacts WHERE id=? AND scope=? AND deleted_at IS NULL", reference);
        case "episode": return this.one("SELECT 1 FROM mnemora_episodes WHERE id=? AND scope=? AND deleted_at IS NULL AND status='active'", reference);
        case "claim": return this.one("SELECT 1 FROM kg_observations WHERE id=? AND scope=?", reference);
        case "memory-candidate": return this.one("SELECT 1 FROM mnemora_cognition_candidates WHERE id=? AND scope=?", reference);
        case "memory-document": return this.one("SELECT 1 FROM kg_memory_documents WHERE id=? AND scope=? AND lifecycle_state='active'", reference);
        case "corpus-chunk": return this.one("SELECT 1 FROM mnemora_corpus_chunks WHERE id=? AND scope=?", reference);
        case "belief": return this.one("SELECT 1 FROM mnemora_beliefs WHERE id=? AND scope=? AND state NOT IN ('invalidated','superseded')", reference);
        case "decision": return this.one("SELECT 1 FROM mnemora_decisions d WHERE d.id=? AND d.scope=? AND d.status='active' AND NOT EXISTS (SELECT 1 FROM mnemora_decision_evidence_reviews r WHERE r.decision_id=d.id AND r.scope=d.scope AND r.status='needs_review')", reference);
        case "task-outcome": return this.one("SELECT 1 FROM mnemora_task_outcomes WHERE id=? AND scope=? AND status='recorded'", reference);
        case "reasoning-memory": return this.one("SELECT 1 FROM mnemora_reasoning_memories WHERE id=? AND scope=? AND state='admitted'", reference);
        case "reasoning-delivery-item": return this.one("SELECT 1 FROM mnemora_reasoning_runtime_delivery_items WHERE id=? AND scope=?", reference);
        default: return false;
      }
    })();
    if (!exists) throw new Error("invalid_decision_evidence");
  }

  private one(sql: string, reference: MnemoraContextRef): boolean {
    return this.db.prepare(sql).get(reference.id, reference.scope) != null;
  }
}
