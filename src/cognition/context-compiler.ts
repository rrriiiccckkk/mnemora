import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { RecallFeedbackRepository } from "./reflection.js";

export type PersonalContextItemKind = "belief" | "decision";
export type PersonalContextAuthority = "user_correction" | "user_explicit_preference" | "user_self_report" | "manual_operator" | "tool_observation" | "external_source" | "assistant_inference" | "unknown";
export interface PersonalContextItem {
  kind: PersonalContextItemKind;
  text: string;
  confidence: number;
  salience: number;
  stalenessRisk: "fresh" | "review";
  /** Provenance class is intentionally distinct from confidence. */
  authority: PersonalContextAuthority;
  refs: string[];
  estimatedTokens: number;
}
export interface CompiledPersonalContext {
  scope: string;
  queryApplied: boolean;
  historicalAt?: number;
  tokenBudget: number;
  estimatedTokens: number;
  items: PersonalContextItem[];
  omitted: Array<{ kind: PersonalContextItemKind; reason: "budget" | "ambiguous" | "not_relevant" }>;
}
export interface CompilePersonalContextInput {
  scope: string;
  query?: string;
  tokenBudget?: number;
  maxItems?: number;
  historicalAt?: number;
  signal?: AbortSignal;
}

type Candidate = PersonalContextItem & { order: number; ambiguous?: boolean; searchable: string };
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("aborted"); };
const bound = (value: unknown, fallback: number, min: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.trunc(Number(value)))) : fallback;
const compact = (value: unknown, max = 512) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
const tokens = (value: string) => Math.max(1, Math.ceil(value.length / 4));
const words = (value: string) => compact(value, 512).toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2).slice(0, 12);
const matches = (text: string, query: string[]) => !query.length || query.some(word => text.toLocaleLowerCase().includes(word));

/**
 * Rebuildable, local-only cognition projection. It does not write memory,
 * mutate confidence, call a Provider, or turn its output into a prompt.
 */
export class PersonalContextCompiler {
  private readonly feedback: RecallFeedbackRepository;
  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now, private readonly options: { staleAfterDays?: number } = {}) { this.feedback = new RecallFeedbackRepository(db, now); }

  compile(input: CompilePersonalContextInput): CompiledPersonalContext {
    abort(input.signal);
    const scope = normalizeScope(input.scope);
    const tokenBudget = bound(input.tokenBudget, 600, 64, 1600);
    const maxItems = bound(input.maxItems, 8, 1, 20);
    const historicalAt = input.historicalAt === undefined ? undefined : bound(input.historicalAt, 0, 0, Number.MAX_SAFE_INTEGER);
    const query = words(input.query ?? "");
    const candidates = [...this.beliefs(scope, historicalAt), ...this.decisions(scope, historicalAt)];
    const ambiguous = new Set<string>();
    const activeBeliefs = candidates.filter((item): item is Candidate & { kind: "belief" } => item.kind === "belief");
    for (const belief of activeBeliefs) {
      const key = belief.searchable.split("\u0000", 1)[0];
      if (activeBeliefs.filter(other => other.searchable.split("\u0000", 1)[0] === key).length > 1) ambiguous.add(key);
    }
    const omitted: CompiledPersonalContext["omitted"] = [];
    const output: PersonalContextItem[] = [];
    let used = 0;
    for (const candidate of candidates.sort((a, b) => b.order - a.order || a.text.localeCompare(b.text))) {
      abort(input.signal);
      const field = candidate.kind === "belief" ? candidate.searchable.split("\u0000", 1)[0] : "";
      if (candidate.kind === "belief" && ambiguous.has(field)) { omitted.push({ kind: candidate.kind, reason: "ambiguous" }); continue; }
      if (!matches(candidate.searchable, query)) { omitted.push({ kind: candidate.kind, reason: "not_relevant" }); continue; }
      if (output.length >= maxItems || used + candidate.estimatedTokens > tokenBudget) { omitted.push({ kind: candidate.kind, reason: "budget" }); continue; }
      output.push({ kind: candidate.kind, text: candidate.text, confidence: candidate.confidence, salience: candidate.salience, stalenessRisk: candidate.stalenessRisk, authority: candidate.authority, refs: candidate.refs, estimatedTokens: candidate.estimatedTokens });
      used += candidate.estimatedTokens;
    }
    return { scope, queryApplied: query.length > 0, ...(historicalAt === undefined ? {} : { historicalAt }), tokenBudget, estimatedTokens: used, items: output, omitted: uniqueOmissions(omitted) };
  }

  private beliefs(scope: string, historicalAt?: number): Candidate[] {
    const rows = this.db.prepare(`SELECT id,subject_ref,predicate,value_json,state,epistemic_confidence,support_count,recorded_at,updated_at FROM mnemora_beliefs WHERE scope=? AND recorded_at<=? AND (state NOT IN ('invalidated','superseded') OR (? IS NOT NULL AND COALESCE(superseded_at,invalidated_at,9223372036854775807)>?)) ORDER BY epistemic_confidence DESC,support_count DESC,recorded_at DESC,id ASC LIMIT 40`).all(scope, historicalAt ?? Number.MAX_SAFE_INTEGER, historicalAt ?? null, historicalAt ?? -1) as Array<Record<string, unknown>>;
    return rows.flatMap(row => {
      const value = parseText(row.value_json); if (!value) return [];
      const predicate = compact(row.predicate, 64) || "memory";
      const text = compact(`${capitalize(predicate)}: ${value}`); if (!text) return [];
      const id = String(row.id), targetRef = createMnemoraContextRef({ scope, kind: "belief", id }), refs = [targetRef, ...this.beliefRefs(scope, id)].slice(0, 4);
      const confidence = clamp(Number(row.epistemic_confidence));
      const salience = this.feedback.salience(scope, targetRef), stalenessRisk = this.risk(scope, targetRef, Number(row.updated_at ?? row.recorded_at)), authority = this.beliefAuthority(id);
      return [{ kind: "belief" as const, text, confidence, salience, stalenessRisk, authority, refs, estimatedTokens: tokens(text), order: salience * 2_000_000 + authorityRank(authority) * 1_000_000 + confidence * 100_000 + Number(row.support_count ?? 0) * 1_000 + Number(row.recorded_at ?? 0) / 1e9, searchable: `${compact(row.subject_ref, 64)}:${predicate}\u0000${text}` }];
    });
  }

  private decisions(scope: string, historicalAt?: number): Candidate[] {
    const at = historicalAt ?? Date.now();
    const rows = this.db.prepare(`SELECT id,objective,chosen_action,confidence,recorded_at FROM mnemora_decisions d WHERE scope=? AND recorded_at<=? AND (status='active' OR (? IS NOT NULL AND COALESCE(superseded_at,invalidated_at,9223372036854775807)>?)) AND NOT EXISTS (SELECT 1 FROM mnemora_decision_evidence_reviews r WHERE r.decision_id=d.id AND r.scope=d.scope AND r.status='needs_review') AND (valid_from IS NULL OR valid_from<=?) AND (valid_until IS NULL OR valid_until>=?) ORDER BY COALESCE(confidence,0) DESC,recorded_at DESC,id ASC LIMIT 40`).all(scope, at, historicalAt ?? null, historicalAt ?? -1, at, at) as Array<Record<string, unknown>>;
    return rows.flatMap(row => {
      const objective = compact(row.objective, 384), action = compact(row.chosen_action, 384);
      const text = compact(`Decision: ${objective}${action ? ` — ${action}` : ""}`); if (!objective) return [];
      const confidence = row.confidence === null || row.confidence === undefined ? .5 : clamp(Number(row.confidence));
      const id = String(row.id), targetRef = createMnemoraContextRef({ scope, kind: "decision", id }), salience = this.feedback.salience(scope, targetRef), stalenessRisk = this.risk(scope, targetRef, Number(row.recorded_at)), authority = this.decisionAuthority(id);
      return [{ kind: "decision" as const, text, confidence, salience, stalenessRisk, authority, refs: [targetRef], estimatedTokens: tokens(text), order: salience * 2_000_000 + authorityRank(authority) * 1_000_000 + confidence * 100_000 + Number(row.recorded_at ?? 0) / 1e9, searchable: text }];
    });
  }

  private beliefRefs(scope: string, beliefId: string): string[] {
    const rows = this.db.prepare("SELECT source_ref FROM mnemora_belief_evidence WHERE belief_id=? ORDER BY source_ref LIMIT 3").all(beliefId) as Array<{ source_ref: string }>;
    return rows.flatMap(row => row.source_ref.startsWith("mnemora://") ? [row.source_ref] : row.source_ref.startsWith("cognition-candidate:") ? [createMnemoraContextRef({ scope, kind: "memory-candidate", id: row.source_ref })] : []);
  }
  private beliefAuthority(beliefId: string): PersonalContextAuthority { return strongest((this.db.prepare("SELECT authority FROM mnemora_belief_evidence WHERE belief_id=?").all(beliefId) as Array<{ authority: string }>).map(row => row.authority)); }
  private decisionAuthority(decisionId: string): PersonalContextAuthority {
    const rows = this.db.prepare("SELECT c.authority_detail FROM mnemora_decision_evidence e JOIN mnemora_cognition_candidates c ON e.source_ref LIKE '%' || replace(c.id,':','%3A') WHERE e.decision_id=?").all(decisionId) as Array<{ authority_detail: string }>;
    return strongest(rows.map(row => row.authority_detail));
  }
  private risk(scope: string, targetRef: string, updatedAt: number): "fresh" | "review" { return this.feedback.requiresReview(scope, targetRef) || this.now() - updatedAt > (this.options.staleAfterDays ?? 90) * 86_400_000 ? "review" : "fresh"; }
}

function parseText(value: unknown): string { try { const parsed = JSON.parse(String(value)); return compact(parsed?.text); } catch { return ""; } }
function clamp(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }
function capitalize(value: string): string { return value ? value[0].toUpperCase() + value.slice(1) : value; }
function uniqueOmissions(value: CompiledPersonalContext["omitted"]): CompiledPersonalContext["omitted"] { return [...new Map(value.map(item => [`${item.kind}:${item.reason}`, item])).values()]; }
const authorityValues = new Set<PersonalContextAuthority>(["user_correction","user_explicit_preference","user_self_report","manual_operator","tool_observation","external_source","assistant_inference","unknown"]);
function authorityRank(value: PersonalContextAuthority): number { return ({ user_correction: 7, user_explicit_preference: 6, user_self_report: 5, manual_operator: 4, tool_observation: 3, external_source: 2, assistant_inference: 1, unknown: 0 })[value]; }
function strongest(values: string[]): PersonalContextAuthority { return values.filter((value): value is PersonalContextAuthority => authorityValues.has(value as PersonalContextAuthority)).sort((a, b) => authorityRank(b) - authorityRank(a))[0] ?? "unknown"; }
