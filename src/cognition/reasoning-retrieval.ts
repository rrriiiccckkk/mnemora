import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { normalizeScope } from "../scope.js";
import type { ReasoningApplicability, ReasoningMemoryKind } from "./reasoning.js";
import { ReasoningQualityPolicyService, type ReasoningQualityPolicy } from "./reasoning-quality.js";

export interface ReasoningRetrievalInput { scope: string; query: string; taskType?: string; riskLevel?: "low" | "medium" | "high"; environment?: string; availableTools?: string[]; limit?: number; semanticScores?: Readonly<Record<string, number>>; qualityPolicy?: ReasoningQualityPolicy; now?: () => number; }
export interface ReasoningRetrievalCandidate { id: string; kind: ReasoningMemoryKind; strategy: string; score: number; utilityScore: number; confidence: number; evidenceQuality?: number; applicability: ReasoningApplicability; reasons: string[]; }
export type ReasoningRetrievalExclusion = "state" | "query" | "task_type" | "risk_level" | "environment" | "required_tool" | "contraindication" | "confidence" | "evidence" | "staleness" | "conflict" | "delivery_circuit";
export interface ReasoningRetrievalResult { version: "reasoning-retrieval-v1"; scope: string; candidates: ReasoningRetrievalCandidate[]; excluded: Record<ReasoningRetrievalExclusion, number>; empty: boolean; }

/**
 * Read-only, operator-facing strategy retrieval. It is deliberately not a
 * ContextEngine or autoRecall policy: callers must explicitly request it.
 */
export class ReasoningRetrievalService {
  constructor(private readonly db: DatabaseSyncInstance) {}

  find(input: ReasoningRetrievalInput): ReasoningRetrievalResult {
    const scope = normalizeScope(input.scope), query = text(input.query, 512), limit = bounded(input.limit ?? 8), excluded: ReasoningRetrievalResult["excluded"] = { state: 0, query: 0, task_type: 0, risk_level: 0, environment: 0, required_tool: 0, contraindication: 0, confidence: 0, evidence: 0, staleness: 0, conflict: 0, delivery_circuit: 0 };
    if (!query) return { version: "reasoning-retrieval-v1", scope, candidates: [], excluded, empty: true };
    const context = normalizeContext(input), tokens = words(query), quality = input.qualityPolicy ? new ReasoningQualityPolicyService(input.qualityPolicy, input.now) : undefined, rows = this.db.prepare("SELECT m.id,m.kind,m.strategy,m.applicability_json,m.contraindications_json,m.evidence_refs_json,m.outcome_refs_json,m.confidence,m.utility_score,m.success_count,m.failure_count,m.updated_at,m.state,EXISTS(SELECT 1 FROM mnemora_reasoning_reflection_proposals p WHERE p.scope=m.scope AND p.memory_id=m.id AND p.status='proposed') AS has_reflection,EXISTS(SELECT 1 FROM mnemora_reasoning_memory_delivery_circuits c WHERE c.scope=m.scope AND c.memory_id=m.id AND c.circuit_open=1) AS delivery_circuit_open FROM mnemora_reasoning_memories m WHERE m.scope=? ORDER BY m.updated_at DESC,m.id DESC LIMIT 200").all(scope) as Array<Record<string, unknown>>, candidates: ReasoningRetrievalCandidate[] = [];
    for (const row of rows) {
      if (row.state !== "admitted") { excluded.state++; continue; }
      if (Number(row.delivery_circuit_open) === 1) { excluded.delivery_circuit++; continue; }
      const strategy = String(row.strategy), lower = strategy.toLowerCase(), applicability = parseApplicability(row.applicability_json), contraindications = strings(row.contraindications_json);
      if (contraindications.some(value => lowerMatch(query, value))) { excluded.contraindication++; continue; }
      const lexical = lexicalScore(lower, tokens), semantic = semanticScore(input.semanticScores, String(row.id)); if (!lexical && !semantic) { excluded.query++; continue; }
      const reasons = lexical ? (lexical === 1 ? ["exact_strategy_match"] : ["strategy_token_match"]) : [];
      if (semantic) reasons.push(`semantic_match:${semantic.toFixed(3)}`);
      const applicabilityScore = this.applicability(applicability, context, excluded, reasons); if (applicabilityScore === undefined) continue;
      const utility = clamp(Number(row.utility_score)), confidence = clamp(Number(row.confidence));
      const qualityDecision = quality?.evaluate({ confidence, evidenceRefs: arrayLength(row.evidence_refs_json), outcomeRefs: arrayLength(row.outcome_refs_json), successCount: Number(row.success_count), failureCount: Number(row.failure_count), updatedAt: Number(row.updated_at), hasOpenReflection: Number(row.has_reflection) === 1 }, context.riskLevel);
      if (qualityDecision && !qualityDecision.allowed) { excluded[qualityDecision.excludedBy!]++; continue; }
      if (qualityDecision) reasons.push(...qualityDecision.reasons);
      const score = Number(Math.min(1, input.semanticScores ? .35 * lexical + .3 * semantic + .15 * ((utility + 1) / 2) + .1 * confidence + .1 * applicabilityScore : .45 * lexical + .2 * ((utility + 1) / 2) + .15 * confidence + .2 * applicabilityScore).toFixed(4));
      reasons.push(`utility:${utility.toFixed(3)}`, `confidence:${confidence.toFixed(3)}`);
      candidates.push({ id: String(row.id), kind: row.kind as ReasoningMemoryKind, strategy, score, utilityScore: utility, confidence, ...(qualityDecision ? { evidenceQuality: qualityDecision.evidenceQuality } : {}), applicability, reasons });
    }
    candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)); const selected = candidates.slice(0, limit);
    return { version: "reasoning-retrieval-v1", scope, candidates: selected, excluded, empty: selected.length === 0 };
  }

  private applicability(value: ReasoningApplicability, context: ReturnType<typeof normalizeContext>, excluded: ReasoningRetrievalResult["excluded"], reasons: string[]): number | undefined {
    let score = 0, checks = 0;
    const exact = (field: string[], requested: string | undefined, label: "task_type" | "risk_level" | "environment") => {
      if (!requested) return true; checks++;
      if (!field.length) { reasons.push(`${label}_generic`); return true; }
      if (!field.includes(requested)) { excluded[label]++; return false; }
      score++; reasons.push(`${label}_match`); return true;
    };
    if (!exact(value.taskTypes, context.taskType, "task_type") || !exact(value.riskLevels, context.riskLevel, "risk_level") || !exact(value.environments, context.environment, "environment")) return undefined;
    if (value.requiredTools.length) {
      checks++;
      if (!context.availableTools) reasons.push("required_tools_unchecked");
      else if (value.requiredTools.every(tool => context.availableTools!.includes(tool))) { score++; reasons.push("required_tools_match"); }
      else { excluded.required_tool++; return undefined; }
    }
    return checks ? score / checks : .5;
  }
}

function text(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max).toLowerCase() : undefined; }
function identifier(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined; }
function normalizeContext(input: ReasoningRetrievalInput) { const risk = input.riskLevel; if (risk !== undefined && !["low", "medium", "high"].includes(risk)) throw new Error("invalid_reasoning_retrieval"); const availableTools = input.availableTools === undefined ? undefined : [...new Set(input.availableTools.map(identifier).filter((value): value is string => Boolean(value)))].slice(0, 20); return { taskType: identifier(input.taskType), riskLevel: risk, environment: identifier(input.environment), availableTools }; }
function strings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter(item => typeof item === "string").map(item => item.toLowerCase()).slice(0, 20) : []; } catch { return []; } }
function parseApplicability(value: unknown): ReasoningApplicability { try { const parsed = JSON.parse(String(value)); const values = (field: string): string[] => Array.isArray(parsed?.[field]) ? parsed[field].map(identifier).filter((item: string | undefined): item is string => Boolean(item)).slice(0, 20) : []; return { taskTypes: values("taskTypes"), riskLevels: values("riskLevels").filter((value): value is "low" | "medium" | "high" => ["low", "medium", "high"].includes(value)), environments: values("environments"), requiredTools: values("requiredTools") }; } catch { return { taskTypes: [], riskLevels: [], environments: [], requiredTools: [] }; } }
function words(query: string): string[] { return [...new Set(query.split(/[^\p{L}\p{N}_-]+/u).filter(value => value.length >= 2))].slice(0, 24); }
function lexicalScore(strategy: string, tokens: string[]): number { if (!tokens.length) return 0; const matches = tokens.filter(token => strategy.includes(token)).length; return matches ? matches / tokens.length : 0; }
function lowerMatch(query: string, value: string): boolean { const candidate = value.trim().toLowerCase(); return candidate.length > 2 && (query.includes(candidate) || candidate.includes(query)); }
function clamp(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0; }
function bounded(value: number): number { return Math.min(20, Math.max(1, Math.trunc(value))); }
function semanticScore(scores: Readonly<Record<string, number>> | undefined, id: string): number { const value = scores?.[id]; return Number.isFinite(value) ? Math.min(1, Math.max(0, Number(value))) : 0; }
function arrayLength(value: unknown): number { try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.length : 0; } catch { return 0; } }
