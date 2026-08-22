import { MnemoraContextRefError, parseMnemoraContextRef } from "../context/context-ref.js";
import { validateEvaluationDataset } from "./dataset-repository.js";
import { buildEvaluationReport } from "./evaluation-report.js";
import type {
  EvaluationCandidate,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationFailureCategory,
  EvaluationFallbackCategory,
  EvaluationReport,
  EvaluationRetrievalResult,
  EvaluationRunOptions,
  EvaluationSubject
} from "./types.js";

const DEFAULT_CASE_LIMIT = 100;
const DEFAULT_CANDIDATE_LIMIT = 10;
const DEFAULT_OPERATION_TIMEOUT_MS = 2_000;
const DEFAULT_DEADLINE_MS = 30_000;
const MAX_CANDIDATES_FROM_SUBJECT = 1_000;

/**
 * Offline evaluation boundary. The runner owns deadlines and cancellation;
 * injected subjects may use local retrieval or bounded Provider adapters.
 */
export class EvaluationRunner {
  constructor(private readonly subject: EvaluationSubject) {}

  async run(datasetInput: import("./types.js").EvaluationDataset, options: EvaluationRunOptions = {}): Promise<EvaluationReport> {
    const dataset = validateEvaluationDataset(datasetInput);
    const configuration = {
      caseLimit: boundedInteger(options.caseLimit, DEFAULT_CASE_LIMIT, 1, 1_000),
      candidateLimit: boundedInteger(options.candidateLimit, DEFAULT_CANDIDATE_LIMIT, 1, 50),
      operationTimeoutMs: boundedInteger(options.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 10, 60_000),
      deadlineMs: boundedInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, 10, 300_000)
    };
    const now = options.now ?? Date.now;
    const startedAt = now();
    const deadlineAt = performance.now() + configuration.deadlineMs;
    const results: EvaluationCaseResult[] = [];
    for (const item of dataset.cases.slice(0, configuration.caseLimit)) {
      if (options.signal?.aborted || performance.now() >= deadlineAt) {
        results.push(failedResult(item, "find", "deadline", 0));
        continue;
      }
      results.push(await this.runCase(item, configuration.candidateLimit, configuration.operationTimeoutMs, deadlineAt, options.signal));
    }
    return buildEvaluationReport({ dataset, results, configuration, startedAt, completedAt: now() });
  }

  private async runCase(item: EvaluationCase, candidateLimit: number, operationTimeoutMs: number, deadlineAt: number, callerSignal?: AbortSignal): Promise<EvaluationCaseResult> {
    const started = performance.now();
    const limit = Math.min(candidateLimit, item.topK ?? candidateLimit);
    let route: EvaluationCaseResult["route"] = item.kind === "complex_search" ? "search" : "find";
    let fallbackCategory: EvaluationFallbackCategory | undefined;
    let result: EvaluationRetrievalResult;
    try {
      if (item.kind === "complex_search" && this.subject.search) {
        try {
          result = normalizeRetrievalResult(await runBounded(
            signal => this.subject.search!({ query: item.query, scope: item.scope, limit, signal }),
            operationTimeoutMs,
            deadlineAt,
            callerSignal
          ));
        } catch (error) {
          const category = failureCategory(error);
          if (category === "aborted") throw error;
          fallbackCategory = fallbackFor(category);
          route = "find_fallback";
          result = normalizeRetrievalResult(await runBounded(
            signal => this.subject.find({ query: item.query, scope: item.scope, limit, signal }),
            operationTimeoutMs,
            deadlineAt,
            callerSignal
          ));
        }
      } else {
        if (item.kind === "complex_search") {
          route = "find_fallback";
          fallbackCategory = "search_unavailable";
        }
        result = normalizeRetrievalResult(await runBounded(
          signal => this.subject.find({ query: item.query, scope: item.scope, limit, signal }),
          operationTimeoutMs,
          deadlineAt,
          callerSignal
        ));
      }
      return successfulResult(item, route, fallbackCategory, result.candidates.slice(0, limit), performance.now() - started);
    } catch (error) {
      return failedResult(item, route, failureCategory(error), performance.now() - started, fallbackCategory);
    }
  }
}

function successfulResult(item: EvaluationCase, route: EvaluationCaseResult["route"], fallbackCategory: EvaluationFallbackCategory | undefined, candidates: EvaluationCandidate[], elapsed: number): EvaluationCaseResult {
  const expected = new Set(item.expectedRefs);
  const forbidden = new Set(item.forbiddenRefs ?? []);
  const seen = new Set<string>();
  let relevantReturned = 0, forbiddenReturned = 0, invalidReferences = 0, crossScopeReturned = 0;
  let firstRelevantRank: number | null = null, sourceRecovered = false, selectedTokens = 0, selectedBytes = 0;
  const relevantAt = { k3: 0, k5: 0, k10: 0 };
  const returnedAt = { k3: Math.min(3, candidates.length), k5: Math.min(5, candidates.length), k10: Math.min(10, candidates.length) };
  candidates.forEach((candidate, index) => {
    selectedTokens += boundedMetric(candidate.estimatedTokens);
    selectedBytes += boundedMetric(candidate.bytes);
    let parsed: ReturnType<typeof parseMnemoraContextRef>;
    try { parsed = parseMnemoraContextRef(candidate.contextRef); }
    catch { invalidReferences++; return; }
    if (parsed.scope !== item.scope) { crossScopeReturned++; return; }
    if (seen.has(parsed.canonical)) return;
    seen.add(parsed.canonical);
    if (expected.has(parsed.canonical)) {
      relevantReturned++;
      if (index < 3) relevantAt.k3++;
      if (index < 5) relevantAt.k5++;
      if (index < 10) relevantAt.k10++;
      if (firstRelevantRank === null) firstRelevantRank = index + 1;
      if (candidate.sourceRecovered === true) sourceRecovered = true;
    }
    if (forbidden.has(parsed.canonical)) forbiddenReturned++;
  });
  const returned = candidates.length;
  return {
    caseId: item.id, ...(item.cohort === undefined ? {} : { cohort: item.cohort }),
    kind: item.kind,
    route,
    status: "succeeded",
    ...(fallbackCategory ? { fallbackCategory } : {}),
    latencyMs: roundedMs(elapsed),
    expected: expected.size,
    returned,
    relevantReturned,
    relevantAt,
    returnedAt,
    irrelevantReturned: Math.max(0, returned - relevantReturned),
    forbiddenReturned,
    invalidReferences,
    crossScopeReturned,
    firstRelevantRank,
    sourceRecovered,
    selectedTokens,
    selectedBytes
  };
}

function failedResult(item: EvaluationCase, route: EvaluationCaseResult["route"], failureCategory: EvaluationFailureCategory, elapsed: number, fallbackCategory?: EvaluationFallbackCategory): EvaluationCaseResult {
  return {
    caseId: item.id, kind: item.kind, ...(item.cohort === undefined ? {} : { cohort: item.cohort }), route, status: "failed", ...(fallbackCategory ? { fallbackCategory } : {}), failureCategory,
    latencyMs: roundedMs(elapsed), expected: item.expectedRefs.length, returned: 0, relevantReturned: 0, irrelevantReturned: 0,
    relevantAt: { k3: 0, k5: 0, k10: 0 }, returnedAt: { k3: 0, k5: 0, k10: 0 },
    forbiddenReturned: 0, invalidReferences: 0, crossScopeReturned: 0, firstRelevantRank: null, sourceRecovered: false,
    selectedTokens: 0, selectedBytes: 0
  };
}

function normalizeRetrievalResult(value: unknown): EvaluationRetrievalResult {
  if (!value || typeof value !== "object") throw new EvaluationOperationError("invalid_response");
  const result = value as Partial<EvaluationRetrievalResult>;
  if (!Array.isArray(result.candidates) || result.candidates.length > MAX_CANDIDATES_FROM_SUBJECT) throw new EvaluationOperationError("invalid_response");
  if (result.plannedQueries !== undefined && (!Number.isInteger(result.plannedQueries) || result.plannedQueries < 0 || result.plannedQueries > 5)) throw new EvaluationOperationError("invalid_response");
  const candidates = result.candidates.map(item => {
    if (!item || typeof item !== "object" || typeof item.contextRef !== "string") throw new EvaluationOperationError("invalid_response");
    return {
      contextRef: item.contextRef,
      ...(Number.isFinite(item.score) ? { score: Math.max(0, Math.min(1, Number(item.score))) } : {}),
      ...(item.sourceRecovered === true ? { sourceRecovered: true } : {}),
      ...(item.estimatedTokens !== undefined ? { estimatedTokens: boundedMetric(item.estimatedTokens) } : {}),
      ...(item.bytes !== undefined ? { bytes: boundedMetric(item.bytes) } : {})
    };
  });
  return { candidates, ...(result.plannedQueries === undefined ? {} : { plannedQueries: result.plannedQueries }) };
}

async function runBounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, deadlineAt: number, callerSignal?: AbortSignal): Promise<T> {
  if (callerSignal?.aborted) throw new EvaluationOperationError("aborted");
  const remaining = Math.max(0, deadlineAt - performance.now());
  if (remaining <= 0) throw new EvaluationOperationError("deadline");
  const controller = new AbortController();
  const timeout = Math.max(1, Math.min(timeoutMs, Math.ceil(remaining)));
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); callerSignal?.removeEventListener("abort", onAbort); callback(); };
    const onAbort = () => { controller.abort(); finish(() => reject(new EvaluationOperationError("aborted"))); };
    const timer = setTimeout(() => { controller.abort(); finish(() => reject(new EvaluationOperationError("deadline"))); }, timeout);
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => operation(controller.signal)).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error instanceof EvaluationOperationError ? error : new EvaluationOperationError("provider")))
    );
  });
}

class EvaluationOperationError extends Error {
  constructor(readonly category: EvaluationFailureCategory) { super(category); this.name = "EvaluationOperationError"; }
}

function failureCategory(error: unknown): EvaluationFailureCategory {
  if (error instanceof EvaluationOperationError) return error.category;
  if (error instanceof MnemoraContextRefError) return "invalid_response";
  return "provider";
}
function fallbackFor(category: EvaluationFailureCategory): EvaluationFallbackCategory {
  if (category === "deadline") return "search_deadline";
  if (category === "invalid_response") return "search_invalid_response";
  return "search_provider";
}
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
}
function boundedMetric(value: unknown): number { return boundedInteger(value, 0, 0, 1_000_000); }
function roundedMs(value: number): number { return Number.isFinite(value) ? Math.round(Math.max(0, value) * 1_000) / 1_000 : 0; }
