import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { FormationKind } from "./admission.js";

export type PreAdmissionMode = "off" | "shadow" | "enforce";
export type PreAdmissionReason = "new_evidence" | "multi_source_support" | "same_session_repeat" | "same_source_duplicate" | "low_information";
export interface PreAdmissionDecision {
  decision: "accept" | "drop";
  reason: PreAdmissionReason;
  sourceCount: number;
  sessionCount: number;
  confidenceMultiplier: number;
}

export interface PreAdmissionInput {
  scope: string;
  origin: "explicit_ingest" | "automatic_extract" | "memory_store";
  kind: FormationKind;
  source: string;
  content?: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Exact low-information forms only. This intentionally does not try to infer
 * a user's intent, personality, or the value of a substantive question.
 */
export function isLowInformationAutomaticInput(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s\p{P}]+/gu, "");
  return new Set([
    "hi", "hello", "hey", "thanks", "thankyou", "ok", "okay", "gotit", "soundsgood", "sure", "great", "cool", "bye", "goodbye",
    "你好", "您好", "嗨", "谢谢", "感谢", "好的", "好", "可以", "收到", "明白", "没问题", "行", "嗯", "再见", "拜拜",
    "你是谁", "你能做什么", "whatcanyoudo", "whatareyou"
  ]).has(normalized);
}

const contentHash = (content: string | undefined): string | undefined => {
  const normalized = content?.trim();
  return normalized ? hash(normalized) : undefined;
};

/** The source itself is never retained; only a one-way session fingerprint. */
function sessionHash(source: string, origin: PreAdmissionInput["origin"]): string | undefined {
  if (origin !== "automatic_extract") return undefined;
  if (!source.startsWith("session:")) return undefined;
  const delimiter = source.lastIndexOf(":turn:");
  const session = delimiter > "session:".length ? source.slice("session:".length, delimiter) : "";
  return session ? hash(session) : undefined;
}

/** Separate repository: formation quality does not expand GraphologyStore. */
export class PreAdmissionRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  assess(input: PreAdmissionInput): PreAdmissionDecision {
    const scope = normalizeScope(input.scope), source = hash(input.source), content = contentHash(input.content), session = sessionHash(input.source, input.origin);
    if (input.origin === "automatic_extract" && isLowInformationAutomaticInput(input.content ?? "")) return { decision: "drop", reason: "low_information", sourceCount: 1, sessionCount: 0, confidenceMultiplier: 0 };
    if (!content) return { decision: "accept", reason: "new_evidence", sourceCount: 1, sessionCount: 0, confidenceMultiplier: 1 };
    const duplicate = this.db.prepare("SELECT candidate_id FROM mnemora_cognition_pre_admissions WHERE scope=? AND kind=? AND content_hash=? AND source_hash=? LIMIT 1").get(scope, input.kind, content, source) as { candidate_id: string } | undefined;
    if (duplicate) return { decision: "drop", reason: "same_source_duplicate", sourceCount: 1, sessionCount: 0, confidenceMultiplier: 0 };
    const support = this.db.prepare("SELECT COUNT(DISTINCT source_hash) AS source_count, COUNT(*) AS candidate_count FROM mnemora_cognition_pre_admissions WHERE scope=? AND kind=? AND content_hash=? AND decision='accept'").get(scope, input.kind, content) as { source_count: number; candidate_count: number } | undefined;
    const priorSources = Math.max(0, Number(support?.source_count ?? 0));
    const priorSession = session
      ? Math.max(0, Number((this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_cognition_pre_admissions WHERE scope=? AND kind=? AND content_hash=? AND session_hash=? AND decision='accept'").get(scope, input.kind, content, session) as { value: number } | undefined)?.value ?? 0))
      : 0;
    const sourceCount = Math.min(1000, priorSources + 1), sessionCount = Math.min(1000, priorSession + 1);
    if (priorSession > 0) return { decision: "accept", reason: "same_session_repeat", sourceCount, sessionCount, confidenceMultiplier: .5 };
    if (priorSources > 0) return { decision: "accept", reason: "multi_source_support", sourceCount, sessionCount, confidenceMultiplier: Math.min(1.25, 1 + Math.min(3, priorSources) * .08) };
    return { decision: "accept", reason: "new_evidence", sourceCount, sessionCount, confidenceMultiplier: 1 };
  }

  record(candidateId: string, input: PreAdmissionInput, mode: Exclude<PreAdmissionMode, "off">, decision: PreAdmissionDecision, now: number): void {
    const scope = normalizeScope(input.scope);
    this.db.prepare(`INSERT OR IGNORE INTO mnemora_cognition_pre_admissions(
      candidate_id,scope,kind,mode,decision,reason_code,content_hash,source_hash,session_hash,source_count,session_count,confidence_multiplier,policy_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidateId, scope, input.kind, mode, decision.decision, decision.reason === "same_source_duplicate" ? "new_evidence" : decision.reason,
      contentHash(input.content) ?? null, hash(input.source), sessionHash(input.source, input.origin) ?? null,
      decision.sourceCount, decision.sessionCount, decision.confidenceMultiplier, "pre-admission-v1", now
    );
  }
}
