import { authorizeMnemoraContextRef, parseMnemoraContextRef } from "../context/context-ref.js";
import { normalizeScope } from "../scope.js";
import { PERSONAL_MEMORY_EVALUATION_VERSION, type EvaluationCase, type EvaluationCaseKind, type EvaluationCohort, type EvaluationDataset } from "./types.js";

export class EvaluationDatasetError extends Error {
  constructor(readonly code: "invalid_dataset" | "duplicate_dataset" | "dataset_not_found") {
    super(code);
    this.name = "EvaluationDatasetError";
  }
}

const caseKinds = new Set<EvaluationCaseKind>(["simple_find", "complex_search", "source_recovery", "long_session_recall", "empty_recall", "scope_isolation"]);
const cohorts = new Set<EvaluationCohort>(["explicit", "auto_extract"]);
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const MAX_DATASETS = 32;
const MAX_CASES = 1_000;
const MAX_QUERY_BYTES = 16_384;

/** In-memory only in Phase 0; evaluation data never mutates the production graph. */
export class EvaluationDatasetRepository {
  private readonly datasets = new Map<string, EvaluationDataset>();

  register(input: EvaluationDataset): EvaluationDataset {
    const dataset = validateEvaluationDataset(input);
    if (this.datasets.has(dataset.id)) throw new EvaluationDatasetError("duplicate_dataset");
    if (this.datasets.size >= MAX_DATASETS) throw new EvaluationDatasetError("invalid_dataset");
    this.datasets.set(dataset.id, dataset);
    return clone(dataset);
  }

  get(id: string): EvaluationDataset {
    const dataset = this.datasets.get(id);
    if (!dataset) throw new EvaluationDatasetError("dataset_not_found");
    return clone(dataset);
  }

  list(): Array<{ id: string; version: 1; cases: number }> {
    return [...this.datasets.values()].map(item => ({ id: item.id, version: item.version, cases: item.cases.length })).sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function validateEvaluationDataset(input: EvaluationDataset): EvaluationDataset {
  if (!input || typeof input !== "object" || input.version !== PERSONAL_MEMORY_EVALUATION_VERSION || !idPattern.test(input.id) || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > MAX_CASES) invalid();
  if (input.description !== undefined && (typeof input.description !== "string" || Buffer.byteLength(input.description, "utf8") > 1_024)) invalid();
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) invalid();
  const ids = new Set<string>();
  const cases = input.cases.map(item => validateCase(item, ids));
  return { version: 1, id: input.id, ...(input.description === undefined ? {} : { description: input.description }), ...(input.seed === undefined ? {} : { seed: input.seed }), cases };
}

function validateCase(input: EvaluationCase, ids: Set<string>): EvaluationCase {
  if (!input || typeof input !== "object" || !idPattern.test(input.id) || ids.has(input.id) || !caseKinds.has(input.kind)) invalid();
  ids.add(input.id);
  let scope: string;
  try {
    scope = normalizeScope(input.scope, "default");
    if (scope !== input.scope) invalid();
  } catch { invalid(); }
  if (typeof input.query !== "string" || !input.query.trim() || Buffer.byteLength(input.query, "utf8") > MAX_QUERY_BYTES) invalid();
  const expectedRefs = validateRefs(input.expectedRefs, scope!);
  const forbiddenRefs = input.forbiddenRefs === undefined ? undefined : validateRefs(input.forbiddenRefs);
  if (input.kind !== "empty_recall" && input.kind !== "scope_isolation" && expectedRefs.length === 0) invalid();
  if (input.kind === "empty_recall" && expectedRefs.length !== 0) invalid();
  if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50)) invalid();
  if (input.cohort !== undefined && !cohorts.has(input.cohort)) invalid();
  return { id: input.id, kind: input.kind, scope: scope!, query: input.query, expectedRefs, ...(forbiddenRefs === undefined ? {} : { forbiddenRefs }), ...(input.topK === undefined ? {} : { topK: input.topK }), ...(input.cohort === undefined ? {} : { cohort: input.cohort }) };
}

function validateRefs(value: unknown, scope?: string): string[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) invalid();
    try {
      const parsed = parseMnemoraContextRef(item);
      if (scope !== undefined) authorizeMnemoraContextRef(parsed.canonical, { scope });
    } catch { invalid(); }
    seen.add(item);
  }
  return [...seen];
}

function clone<T>(value: T): T { return structuredClone(value); }
function invalid(): never { throw new EvaluationDatasetError("invalid_dataset"); }
