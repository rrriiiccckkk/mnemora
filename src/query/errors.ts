import type {
  ResearchErrorCandidate,
  ResearchErrorCode,
  ResearchErrorDetails,
  ResearchErrorEnvelope,
  ResearchErrorMatchReason,
  ResearchErrorName,
  ResearchErrorStage,
  ResearchOperationErrorInput
} from "./types.js";
import { isCanonicalId } from "./canonical-id.js";

export type {
  ResearchErrorCandidate,
  ResearchErrorCode,
  ResearchErrorDetails,
  ResearchErrorEnvelope,
  ResearchErrorMatchReason,
  ResearchErrorName,
  ResearchErrorStage,
  ResearchOperationErrorInput
} from "./types.js";

const MAX_SERIALIZED_BYTES = 16 * 1024;
const brandedErrors = new WeakSet<object>();
const EMPTY_DETAILS = Object.freeze({}) as ResearchErrorDetails;
const controlCharacter = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const urlOrUserinfo = /\b(?:[a-z][a-z0-9+.-]*:)?[^\s:@/\\]+:[^\s@/\\]+@|\b(?:https?|file|ftp|mailto):/i;
const REDACTED_GRAPH_LABEL = "[redacted]";
const sqlCommandKeyword = /\b(?:select|insert|replace|update|delete|drop|alter|create|pragma|attach|detach|with|vacuum|begin|commit|end|rollback|savepoint|release|explain|analyze|reindex)\b/i;
const sqlStatementStructure = /(?:\bselect\s+(?:(?:distinct|all)\s+)?(?:[\s\S]{0,512}?\bfrom\b|\*|[-+]?\d+(?:\.\d+)?\b|null\b|true\b|false\b|'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]+\]|[a-z_][a-z0-9_]*\s*\()|\b(?:insert|replace)\s+(?:or\s+(?:abort|fail|ignore|replace|rollback)\s+)?into\b|\bupdate\s+[\s\S]{0,256}?\bset\b|\bdelete\s+from\b|\b(?:create|alter|drop)\s+(?:table|index|trigger|view|virtual\s+table)\b|\bpragma\s+(?:[a-z_][a-z0-9_]*_[a-z0-9_]*\b|[a-z_][a-z0-9_]*\s*(?:\(|=)|table_info\b|index_list\b|foreign_key_list\b|database_list\b|compile_options\b|journal_mode\b|synchronous\b|wal_checkpoint\b|cache_size\b)|\battach\s+database\b|\bdetach\s+database\b|\bwith\s+(?:recursive\s+)?[a-z_][a-z0-9_]*\s*(?:\([^)]*\))?\s+as\s*\(|\bvacuum\s*(?:;|$|\s+into\b)|\bbegin\s*(?:;|$|\s+(?:deferred|immediate|exclusive|transaction)\b)|\b(?:commit|end)(?:\s+transaction)?\s*(?:;|$)|\brollback(?:\s+(?:transaction|to\b))?|\bsavepoint\s+[a-z_][a-z0-9_]*\b|\brelease\s+(?:savepoint\s+)?[a-z_][a-z0-9_]*\b|\bexplain(?:\s+query\s+plan)?\s+(?:select|insert|update|delete|pragma)\b|\banalyze\s*(?:;|$|\s+[a-z_][a-z0-9_]*)|\breindex\s*(?:;|$|\s+[a-z_][a-z0-9_]*))/i;

type DetailBuilder = (value: unknown) => ResearchErrorDetails;
interface CodeContract { error: ResearchErrorName; stage: ResearchErrorStage; summary: string; details: DetailBuilder }

const codeContracts: Record<ResearchErrorCode, CodeContract> = {
  COMPARE_SUBJECT_AMBIGUOUS: { error: "ambiguous_subject", stage: "subject_resolution", summary: "Multiple graph subjects matched.", details: compareSubjectDetails },
  COMPARE_SUBJECT_NOT_FOUND: { error: "subject_not_found", stage: "subject_resolution", summary: "No graph subject matched.", details: compareSubjectDetails },
  COMPARE_SAME_SUBJECT: { error: "same_subject", stage: "subject_resolution", summary: "Subjects must be distinct.", details: noCompareSameSubjectDetails },
  COMPARE_LIMIT_EXCEEDED: { error: "limit_exceeded", stage: "execution", summary: "Comparison limit exceeded.", details: compareLimitDetails },
  QUERY_INVALID_PLAN: { error: "invalid_plan", stage: "planning", summary: "Query plan is invalid.", details: noQueryInvalidPlanDetails },
  QUERY_PLANNER_UNAVAILABLE: { error: "planner_unavailable", stage: "planning", summary: "Query planner is unavailable.", details: noQueryPlannerUnavailableDetails },
  QUERY_TIMEOUT: { error: "timeout", stage: "execution", summary: "Query timed out.", details: noQueryTimeoutDetails },
  WATCH_INVALID_INPUT: { error: "invalid_input", stage: "input_validation", summary: "Watch input is invalid.", details: noWatchInvalidInputDetails },
  DIGEST_ALREADY_RUNNING: { error: "already_running", stage: "execution", summary: "Digest is already running.", details: noDigestAlreadyRunningDetails },
  IMPORT_INVALID: { error: "invalid_import", stage: "input_validation", summary: "Import data is invalid.", details: noImportInvalidDetails },
  IMPORT_STALE: { error: "stale_import", stage: "persistence", summary: "Import preview is stale.", details: noImportStaleDetails },
  IMPORT_CONFIRMATION_REQUIRED: { error: "confirmation_required", stage: "authorization", summary: "Import confirmation is required.", details: noImportConfirmationRequiredDetails },
  EXPORT_LIMIT: { error: "export_limit", stage: "serialization", summary: "Export limit exceeded.", details: exportLimitDetails },
  RESEARCH_OPERATION_FAILED: { error: "operation_failed", stage: "execution", summary: "Research operation failed.", details: noResearchOperationFailedDetails }
};

export class ResearchOperationError extends Error {
  readonly public: ResearchErrorEnvelope;

  constructor(input: ResearchOperationErrorInput) {
    super("Research operation failed.");
    this.name = "ResearchOperationError";
    this.public = bounded(normalize(input));
    brandedErrors.add(this);
    Object.freeze(this);
  }

  toJSON(): ResearchErrorEnvelope { return this.public; }
}

export function toResearchError(operation: unknown, value: unknown): ResearchErrorEnvelope {
  try {
    if (isResearchOperationError(value)) return value.public;
    return generic("execution", operationSummary(operation));
  } catch { return generic(); }
}

function isResearchOperationError(value: unknown): value is ResearchOperationError {
  return typeof value === "object" && value !== null && brandedErrors.has(value);
}

function operationSummary(operation: unknown): string {
  switch (operation) {
    case "kg_compare": return "kg_compare failed";
    case "kg_digest": return "kg_digest failed";
    case "kg_export": return "kg_export failed";
    case "kg_import": return "kg_import failed";
    case "kg_query": return "kg_query failed";
    case "kg_query_history": return "kg_query_history failed";
    case "kg_timeline": return "kg_timeline failed";
    case "kg_watch": return "kg_watch failed";
    default: return "Research operation failed.";
  }
}

function normalize(input: unknown): ResearchErrorEnvelope {
  try {
    if (!record(input)) return generic();
    const code = input.error_code;
    const retryable = input.retryable;
    const details = input.details;
    if (!validCode(code)) return generic();
    const contract = codeContracts[code];
    if (typeof retryable !== "boolean") return generic();
    return envelope(contract.error, code, contract.stage, retryable, contract.summary, contract.details(details));
  } catch { return generic(); }
}

function generic(stage: ResearchErrorStage = "execution", summary = "Research operation failed."): ResearchErrorEnvelope {
  return envelope("operation_failed", "RESEARCH_OPERATION_FAILED", stage, false, summary, EMPTY_DETAILS);
}

function envelope(error: ResearchErrorName, errorCode: ResearchErrorCode, stage: ResearchErrorStage, retryable: boolean, summary: string, details: ResearchErrorDetails): ResearchErrorEnvelope {
  return Object.freeze({ error, error_code: errorCode, stage, retryable, summary, details });
}

function compareSubjectDetails(value: unknown): ResearchErrorDetails {
  try {
    if (!record(value)) return frozenCompareDetails("left", [], false);
    const side = value.side === "right" ? "right" : "left";
    const truncated = value.truncated === true;
    const rawCandidates = value.candidates;
    const candidates = Array.isArray(rawCandidates) ? rawCandidates.map(candidate).filter((item): item is ResearchErrorCandidate => item !== undefined).slice(0, 5) : [];
    return frozenCompareDetails(side, candidates, truncated);
  } catch { return frozenCompareDetails("left", [], false); }
}

function frozenCompareDetails(side: "left" | "right", candidates: ResearchErrorCandidate[], truncated: boolean): ResearchErrorDetails {
  return Object.freeze({ side, candidates: Object.freeze(candidates), truncated });
}

function compareLimitDetails(value: unknown): ResearchErrorDetails { return frozenLimitDetails(value); }
function exportLimitDetails(value: unknown): ResearchErrorDetails { return frozenLimitDetails(value); }
function frozenLimitDetails(value: unknown): ResearchErrorDetails {
  try {
    if (!record(value)) return EMPTY_DETAILS;
    const limit = value.limit;
    return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0 && limit <= 10_000_000 ? Object.freeze({ limit }) : EMPTY_DETAILS;
  } catch { return EMPTY_DETAILS; }
}

function noCompareSameSubjectDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noQueryInvalidPlanDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noQueryPlannerUnavailableDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noQueryTimeoutDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noWatchInvalidInputDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noDigestAlreadyRunningDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noImportInvalidDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noImportStaleDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noImportConfirmationRequiredDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }
function noResearchOperationFailedDetails(_value: unknown): ResearchErrorDetails { return EMPTY_DETAILS; }

function candidate(value: unknown): ResearchErrorCandidate | undefined {
  try {
    if (!record(value)) return undefined;
    const id = value.id;
    const name = safeGraphLabel(value.name, 4_096);
    const type = value.type;
    const matchReason = value.match_reason;
    if (!isCanonicalId(id) || !name || typeof type !== "string" || !validType(type) || !validMatchReason(matchReason)) return undefined;
    const rawAliases = value.aliases;
    const aliases = Array.isArray(rawAliases)
      ? rawAliases.map(alias => safeGraphLabel(alias, 1_024)).filter((alias): alias is string => alias !== undefined).slice(0, 10)
      : [];
    return Object.freeze({ id, name, type, aliases: Object.freeze(aliases), match_reason: matchReason });
  } catch { return undefined; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCode(value: unknown): value is ResearchErrorCode {
  return typeof value === "string" && Object.hasOwn(codeContracts, value);
}

function safeGraphLabel(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  try {
    const normalized = value.normalize("NFKC");
    if (sqlCommandKeyword.test(normalized)) return REDACTED_GRAPH_LABEL;
    return unsafeDisplayLabel(normalized) ? undefined : value;
  }
  catch { return undefined; }
}

function unsafeDisplayLabel(value: string): boolean {
  return /[\\/]/.test(value) || controlCharacter.test(value) || urlOrUserinfo.test(value) || sqlStatementStructure.test(value) || unsafeMarkerText(value);
}

function unsafeMarkerText(value: string): boolean {
  return /\bsqlite\b|(?:<\s*\/?\s*(?:provider(?:[_ -]?(?:response[_ -]?)?body)?|prompt|evidence|source)\b|\b(?:provider(?:[_ -]?(?:response[_ -]?)?body)|prompt|evidence|source)\s*[:=])|\b(?:api[_ -]?key|authorization|bearer|password|credential|token)\s*[:=]/i.test(value);
}

function validType(value: string): value is ResearchErrorCandidate["type"] {
  return ["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio", "community"].includes(value);
}

function validMatchReason(value: unknown): value is ResearchErrorMatchReason {
  return value === "id_exact" || value === "name_exact" || value === "alias_exact" || value === "prefix" || value === "lexical" || value === "semantic";
}

function bounded(envelopeValue: ResearchErrorEnvelope): ResearchErrorEnvelope {
  try { return Buffer.byteLength(JSON.stringify(envelopeValue), "utf8") <= MAX_SERIALIZED_BYTES ? envelopeValue : generic("serialization"); }
  catch { return generic("serialization"); }
}
