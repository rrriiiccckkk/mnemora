import { normalizeScope } from "../scope.js";
import type { TaskResumeInput, TaskResumeResult, TaskResumeStateItem } from "./service.js";

export const TASK_RESUME_EVALUATION_VERSION = 1 as const;
const categories = new Set(["normal_resume", "decision_update", "ambiguity", "scope_isolation", "forgotten_evidence", "failed_attempt", "insufficient_memory"]);
const statuses = new Set(["ready", "needs_reconfirmation", "ambiguous", "not_found", "query_required"]);

export interface TaskResumeEvaluationCase {
  id: string;
  category: "normal_resume" | "decision_update" | "ambiguity" | "scope_isolation" | "forgotten_evidence" | "failed_attempt" | "insufficient_memory";
  input: TaskResumeInput;
  expected: { status?: "ready" | "needs_reconfirmation" | "ambiguous" | "not_found" | "query_required"; errorCode?: string; requiredText?: string[]; forbiddenText?: string[]; minimumSourceRefs?: number };
}

export interface TaskResumeEvaluationDataset {
  version: typeof TASK_RESUME_EVALUATION_VERSION;
  id: string;
  description?: string;
  cases: TaskResumeEvaluationCase[];
}

export interface TaskResumeEvaluationResult {
  caseId: string;
  category: TaskResumeEvaluationCase["category"];
  status: "passed" | "failed";
  mismatchCodes: Array<"status" | "expected_error" | "required_text" | "forbidden_text" | "source_refs">;
  returnedItems: number;
  sourceRefs: number;
}

export interface TaskResumeEvaluationReport {
  version: typeof TASK_RESUME_EVALUATION_VERSION;
  dataset: { id: string; version: typeof TASK_RESUME_EVALUATION_VERSION };
  baseline: { automaticRecallChanged: false; externalActions: false; maximumItemsPerCase: number };
  results: TaskResumeEvaluationResult[];
  metrics: { cases: number; passed: number; failed: number; byCategory: Record<string, { cases: number; passed: number }> };
}

/** Offline, privacy-safe functional evaluation for the explicit task-resume seam.
 * It reports stable case IDs and mismatch classes, never the fixture query,
 * scope, task text, or source reference. */
export class TaskResumeEvaluationRunner {
  constructor(private readonly subject: { resume(input: TaskResumeInput): TaskResumeResult }) {}

  run(datasetInput: unknown, options: { caseLimit?: number } = {}): TaskResumeEvaluationReport {
    const dataset = validateTaskResumeEvaluationDataset(datasetInput), limit = Math.min(dataset.cases.length, bounded(options.caseLimit, dataset.cases.length));
    const results = dataset.cases.slice(0, limit).map(item => this.evaluate(item));
    const byCategory: Record<string, { cases: number; passed: number }> = {};
    for (const result of results) {
      const category = byCategory[result.category] ?? (byCategory[result.category] = { cases: 0, passed: 0 });
      category.cases++;
      if (result.status === "passed") category.passed++;
    }
    const passed = results.filter(item => item.status === "passed").length;
    return { version: TASK_RESUME_EVALUATION_VERSION, dataset: { id: dataset.id, version: dataset.version }, baseline: { automaticRecallChanged: false, externalActions: false, maximumItemsPerCase: Math.max(...dataset.cases.slice(0, limit).map(item => item.input.limit ?? 20), 0) }, results, metrics: { cases: results.length, passed, failed: results.length - passed, byCategory } };
  }

  private evaluate(item: TaskResumeEvaluationCase): TaskResumeEvaluationResult {
    const mismatchCodes: TaskResumeEvaluationResult["mismatchCodes"] = [];
    try {
      const result = this.subject.resume(item.input), text = resultText(result), refs = resultRefs(result);
      if (item.expected.errorCode || item.expected.status !== result.status) mismatchCodes.push(item.expected.errorCode ? "expected_error" : "status");
      if (item.expected.requiredText?.some(value => !text.includes(value))) mismatchCodes.push("required_text");
      if (item.expected.forbiddenText?.some(value => text.includes(value))) mismatchCodes.push("forbidden_text");
      if (refs.length < (item.expected.minimumSourceRefs ?? 0)) mismatchCodes.push("source_refs");
      return { caseId: item.id, category: item.category, status: mismatchCodes.length ? "failed" : "passed", mismatchCodes, returnedItems: resultItems(result), sourceRefs: refs.length };
    } catch (error) {
      if (item.expected.errorCode === (error instanceof Error ? error.message : "operation_failed")) return { caseId: item.id, category: item.category, status: "passed", mismatchCodes: [], returnedItems: 0, sourceRefs: 0 };
      return { caseId: item.id, category: item.category, status: "failed", mismatchCodes: ["expected_error"], returnedItems: 0, sourceRefs: 0 };
    }
  }
}

export function validateTaskResumeEvaluationDataset(input: unknown): TaskResumeEvaluationDataset {
  if (!record(input) || input.version !== TASK_RESUME_EVALUATION_VERSION || !id(input.id) || input.description !== undefined && (typeof input.description !== "string" || Buffer.byteLength(input.description, "utf8") > 1024) || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100) invalid();
  const ids = new Set<string>(), cases = input.cases.map(value => validateCase(value, ids));
  return { version: TASK_RESUME_EVALUATION_VERSION, id: input.id, ...(typeof input.description === "string" ? { description: input.description } : {}), cases };
}

function validateCase(value: unknown, ids: Set<string>): TaskResumeEvaluationCase {
  if (!record(value) || !id(value.id) || ids.has(value.id) || typeof value.category !== "string" || !categories.has(value.category) || !record(value.input) || !record(value.expected)) invalid();
  ids.add(value.id);
  const scope = typeof value.input.scope === "string" ? normalizeScope(value.input.scope) : invalid();
  const query = optionalText(value.input.query, 512), taskRef = optionalText(value.input.taskRef, 1024), limit = value.input.limit === undefined ? undefined : bounded(value.input.limit, 20);
  if (!query && !taskRef && value.category !== "ambiguity") invalid();
  const status = value.expected.status;
  if (status !== undefined && (typeof status !== "string" || !statuses.has(status))) invalid();
  const errorCode = optionalText(value.expected.errorCode, 80), requiredText = textList(value.expected.requiredText), forbiddenText = textList(value.expected.forbiddenText), minimumSourceRefs = value.expected.minimumSourceRefs === undefined ? undefined : bounded(value.expected.minimumSourceRefs, 100);
  if ((!status && !errorCode) || status && errorCode) invalid();
  return { id: value.id, category: value.category as TaskResumeEvaluationCase["category"], input: { scope, ...(query ? { query } : {}), ...(taskRef ? { taskRef } : {}), ...(limit ? { limit } : {}) }, expected: { ...(status ? { status: status as TaskResumeEvaluationCase["expected"]["status"] } : {}), ...(errorCode ? { errorCode } : {}), ...(requiredText.length ? { requiredText } : {}), ...(forbiddenText.length ? { forbiddenText } : {}), ...(minimumSourceRefs !== undefined ? { minimumSourceRefs } : {}) } };
}

function resultItems(result: TaskResumeResult): number { return "task" in result ? result.completed.length + result.pending.length + result.blockers.length + result.next_steps.length + result.decisions.length + result.needs_reconfirmation.length : result.candidates.length; }
function resultText(result: TaskResumeResult): string { return "task" in result ? [result.task.title, result.task.goal, ...stateItems(result)].join("\n") : result.candidates.flatMap(item => [item.title, item.goal]).join("\n"); }
function resultRefs(result: TaskResumeResult): string[] { return "task" in result ? [result.task.task_ref, ...result.task.source_refs, ...result.task.artifact_refs, ...stateItems(result, true)] : result.candidates.flatMap(item => [item.task_ref, ...item.source_refs]); }
function stateItems(result: Extract<TaskResumeResult, { task: unknown }>, refs = false): string[] { const items: TaskResumeStateItem[] = [...result.completed, ...result.pending, ...result.blockers, ...result.next_steps, ...result.decisions, ...result.needs_reconfirmation]; return refs ? items.flatMap(item => item.source_refs) : items.map(item => item.text); }
function record(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(value); }
function optionalText(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= max ? value.trim() : undefined; }
function textList(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 8) invalid(); const result = value.map(item => optionalText(item, 128)); if (result.some(item => !item)) invalid(); return result as string[]; }
function bounded(value: unknown, maximum: number): number { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) invalid(); return Number(value); }
function invalid(): never { throw new Error("invalid_task_resume_evaluation_dataset"); }
