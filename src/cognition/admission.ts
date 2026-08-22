export type FormationAuthority = "manual_operator" | "assistant_inference" | "external_source" | "unknown" | "user_correction" | "user_self_report" | "user_explicit_preference" | "tool_observation" | "assistant_summary" | "system_derivation";
export type FormationKind = "graph_extraction" | "memory_document";
export type AdmissionMode = "shadow" | "enforce";
export type AdmissionOutcome = "accept" | "reject" | "defer" | "episodic_only" | "requires_review";
export type MemoryShape = "preference" | "self_report" | "correction" | "observation" | "event" | "note" | "inference" | "unknown";
export type Durability = "transient" | "episodic" | "persistent";

export interface AdmissionInput {
  authority: FormationAuthority;
  kind: FormationKind;
  content?: string;
  entities: number;
  relations: number;
}

export interface AdmissionDecision {
  outcome: AdmissionOutcome;
  memoryShape: MemoryShape;
  durability: Durability;
  reasonCode: "empty_candidate" | "oversized_candidate" | "assistant_inference" | "unknown_authority" | "transient_content" | "graph_evidence_episodic" | "external_evidence_episodic" | "tool_observation_episodic" | "explicit_user_preference" | "user_correction" | "user_self_report_requires_review" | "manual_operator_requires_review" | "related_memory_requires_review";
}

const transientPattern = /\b(today|tonight|tomorrow|this week|currently|right now|temporary|temporarily)\b|今天|今晚|明天|这周|目前|现在|临时/u;

/** A pure, bounded policy: it classifies candidates but never writes a belief. */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const content = input.content?.trim() ?? "";
  if ((input.kind === "memory_document" && !content) || (input.kind === "graph_extraction" && input.entities + input.relations === 0)) return { outcome: "reject", memoryShape: "unknown", durability: "transient", reasonCode: "empty_candidate" };
  if (content.length > 16_000 || input.entities + input.relations > 5_000) return { outcome: "reject", memoryShape: "unknown", durability: "transient", reasonCode: "oversized_candidate" };
  if (input.authority === "assistant_inference" || input.authority === "assistant_summary" || input.authority === "system_derivation") return { outcome: "reject", memoryShape: "inference", durability: "transient", reasonCode: "assistant_inference" };
  if (input.authority === "unknown") return { outcome: "reject", memoryShape: "unknown", durability: "transient", reasonCode: "unknown_authority" };
  if (input.kind === "graph_extraction") {
    if (input.authority === "external_source") return { outcome: "episodic_only", memoryShape: "observation", durability: "episodic", reasonCode: "external_evidence_episodic" };
    if (input.authority === "tool_observation") return { outcome: "episodic_only", memoryShape: "observation", durability: "episodic", reasonCode: "tool_observation_episodic" };
    return { outcome: "episodic_only", memoryShape: "observation", durability: "episodic", reasonCode: "graph_evidence_episodic" };
  }
  if (transientPattern.test(content)) return { outcome: "episodic_only", memoryShape: "event", durability: "transient", reasonCode: "transient_content" };
  if (input.authority === "user_explicit_preference") return { outcome: "accept", memoryShape: "preference", durability: "persistent", reasonCode: "explicit_user_preference" };
  if (input.authority === "user_correction") return { outcome: "accept", memoryShape: "correction", durability: "persistent", reasonCode: "user_correction" };
  if (input.authority === "user_self_report") return { outcome: "requires_review", memoryShape: "self_report", durability: "persistent", reasonCode: "user_self_report_requires_review" };
  if (input.authority === "external_source") return { outcome: "episodic_only", memoryShape: "observation", durability: "episodic", reasonCode: "external_evidence_episodic" };
  if (input.authority === "tool_observation") return { outcome: "episodic_only", memoryShape: "observation", durability: "episodic", reasonCode: "tool_observation_episodic" };
  return { outcome: "requires_review", memoryShape: "note", durability: "episodic", reasonCode: "manual_operator_requires_review" };
}
