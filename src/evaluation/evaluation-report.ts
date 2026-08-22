import type { EvaluationCaseResult, EvaluationDataset, EvaluationMetrics, EvaluationReport } from "./types.js";

const MAX_REPORT_BYTES = 1_048_576;

export function buildEvaluationReport(input: {
  dataset: EvaluationDataset;
  results: EvaluationCaseResult[];
  configuration: EvaluationReport["configuration"];
  startedAt: number;
  completedAt: number;
}): EvaluationReport {
  return {
    version: 1,
    dataset: { id: input.dataset.id, version: input.dataset.version, seed: input.dataset.seed ?? null },
    configuration: { ...input.configuration },
    startedAt: finiteTime(input.startedAt),
    completedAt: finiteTime(input.completedAt),
    results: input.results.map(result => ({ ...result })),
    metrics: calculateEvaluationMetrics(input.results),
    ...cohorts(input.results)
  };
}

export function serializeEvaluationReport(report: EvaluationReport, maxBytes = MAX_REPORT_BYTES): string {
  const maximum = Number.isInteger(maxBytes) ? Math.max(1_024, Math.min(MAX_REPORT_BYTES, maxBytes)) : MAX_REPORT_BYTES;
  const encoded = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(encoded, "utf8") > maximum) throw new Error("evaluation_report_too_large");
  return encoded;
}

export function calculateEvaluationMetrics(results: EvaluationCaseResult[]): EvaluationMetrics {
  const succeeded = results.filter(item => item.status === "succeeded");
  const positive = succeeded.filter(item => item.expected > 0);
  const empty = succeeded.filter(item => item.kind === "empty_recall");
  const source = succeeded.filter(item => item.kind === "source_recovery");
  const totalReturned = sum(succeeded.map(item => item.returned));
  const latency = succeeded.map(item => item.latencyMs).sort((a, b) => a - b);
  const tokens = succeeded.map(item => item.selectedTokens);
  const bytes = succeeded.map(item => item.selectedBytes);
  return {
    cases: results.length,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    fallbackRate: ratio(results.filter(item => item.route === "find_fallback").length, results.length),
    recallAtK: mean(positive.map(item => ratio(item.relevantReturned, item.expected))),
    precisionAtK: mean(positive.map(item => ratio(item.relevantReturned, item.returned))),
    recallCurve: curve(positive, (item, key) => ratio(item.relevantAt[key], item.expected)),
    precisionCurve: curve(positive, (item, key) => ratio(item.relevantAt[key], item.returnedAt[key])),
    meanReciprocalRank: mean(positive.map(item => item.firstRelevantRank === null ? 0 : 1 / item.firstRelevantRank)),
    emptyRecallPrecision: ratio(empty.filter(item => item.returned === 0).length, empty.length),
    irrelevantInjectionRate: ratio(sum(succeeded.map(item => item.irrelevantReturned)), totalReturned),
    sourceRecoveryRate: ratio(source.filter(item => item.sourceRecovered).length, source.length),
    scopeLeakageRate: ratio(sum(succeeded.map(item => item.crossScopeReturned)), totalReturned),
    latencyMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), p99: percentile(latency, .99) },
    selectedTokens: { average: mean(tokens), maximum: tokens.length ? Math.max(...tokens) : 0 },
    selectedBytes: { average: mean(bytes), maximum: bytes.length ? Math.max(...bytes) : 0 }
  };
}

function cohorts(results: EvaluationCaseResult[]): Pick<EvaluationReport, "cohorts"> {
  const entries = (["explicit", "auto_extract"] as const).flatMap(cohort => {
    const values = results.filter(item => item.cohort === cohort);
    return values.length ? [[cohort, calculateEvaluationMetrics(values)] as const] : [];
  });
  return entries.length ? { cohorts: Object.fromEntries(entries) } : {};
}

function curve(values: EvaluationCaseResult[], measure: (item: EvaluationCaseResult, key: "k3" | "k5" | "k10") => number): EvaluationMetrics["recallCurve"] {
  return { k3: mean(values.map(item => measure(item, "k3"))), k5: mean(values.map(item => measure(item, "k5"))), k10: mean(values.map(item => measure(item, "k10"))) };
}

function percentile(sorted: number[], percentileValue: number): number {
  if (!sorted.length) return 0;
  return round(sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)]);
}
function mean(values: number[]): number { return values.length ? round(sum(values) / values.length) : 0; }
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? round(numerator / denominator) : 0; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0; }
function finiteTime(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
