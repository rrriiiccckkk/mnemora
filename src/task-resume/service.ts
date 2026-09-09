import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { authorizeMnemoraContextRef, createMnemoraContextRef } from "../context/context-ref.js";
import { CognitionReferenceRepository } from "../cognition/reference-repository.js";
import { DecisionMemoryService, type DecisionMemory } from "../cognition/decisions.js";
import { TaskOutcomeService, type TaskActionState, type TaskOutcome } from "../cognition/outcomes.js";
import { EpisodeRepository, type Episode } from "../episodes/repository.js";
import { normalizeScope } from "../scope.js";

const MAX_ITEMS = 20;
const MAX_CANDIDATES = 8;

export interface TaskResumeInput {
  scope: string;
  /** A human query is used only to select an existing task episode. */
  query?: string;
  /** An unambiguous, canonical task-episode reference takes precedence over query matching. */
  taskRef?: string;
  limit?: number;
}

export interface TaskResumeCandidate {
  task_ref: string;
  title: string;
  goal: string;
  last_evidence_at: number;
  source_refs: string[];
}

export interface TaskResumeStateItem {
  /** The record kind is deliberately explicit: no plan or failure becomes a completed item. */
  kind: "completed" | "partial" | "failed" | "decision" | "planned" | "constraint" | "history" | "needs_reconfirmation";
  text: string;
  source_refs: string[];
  recorded_at: number;
}

export interface TaskResumeView {
  kind: "task_resume";
  status: "ready" | "blocked" | "needs_reconfirmation";
  scope: string;
  task: {
    id: string;
    task_ref: string;
    title: string;
    goal: string;
    /** Only a task-level accepted outcome can say completed; child actions alone remain in progress. */
    progress: "unknown" | "in_progress" | "blocked" | "completed" | "needs_reconfirmation";
    /** Most recent accepted outcome, if one exists. It is not a claim that the task succeeded. */
    last_verified_at: number | null;
    last_evidence_at: number;
    source_refs: string[];
    artifact_refs: string[];
  };
  completed: TaskResumeStateItem[];
  pending: TaskResumeStateItem[];
  blockers: TaskResumeStateItem[];
  constraints: TaskResumeStateItem[];
  next_steps: TaskResumeStateItem[];
  decisions: TaskResumeStateItem[];
  /** Accepted but not-yet-effective decisions remain visible as plans, never current actions. */
  planned: TaskResumeStateItem[];
  history: TaskResumeStateItem[];
  needs_reconfirmation: TaskResumeStateItem[];
  truncated: boolean;
}

export interface TaskResumeAmbiguous {
  kind: "task_resume";
  status: "ambiguous";
  scope: string;
  candidates: TaskResumeCandidate[];
  truncated: boolean;
}

export interface TaskResumeMissing {
  kind: "task_resume";
  status: "not_found" | "query_required";
  scope: string;
  candidates: TaskResumeCandidate[];
  truncated: boolean;
}

export type TaskResumeResult = TaskResumeView | TaskResumeAmbiguous | TaskResumeMissing;

/**
 * Read-only task continuation projection.
 *
 * The public seam is one `resume` operation. It owns task identification,
 * scope checks, lifecycle filtering, and the conservative distinction between
 * accepted outcomes, failures, decisions, and merely unverified history. No
 * caller needs to reproduce those joins or interpret a journal entry as task
 * state.
 */
export class TaskResumeService {
  private readonly episodes: EpisodeRepository;
  private readonly decisions: DecisionMemoryService;
  private readonly outcomes: TaskOutcomeService;
  private readonly references: CognitionReferenceRepository;

  constructor(private readonly db: DatabaseSyncInstance, private readonly now: () => number = Date.now) {
    this.episodes = new EpisodeRepository(db);
    this.decisions = new DecisionMemoryService(db, now);
    this.outcomes = new TaskOutcomeService(db, now);
    this.references = new CognitionReferenceRepository(db);
  }

  resume(input: TaskResumeInput): TaskResumeResult {
    const scope = normalizeScope(input.scope), limit = bound(input.limit), query = text(input.query, 512);
    const task = input.taskRef ? this.taskByReference(input.taskRef, scope) : undefined;
    if (input.taskRef && !task) return { kind: "task_resume", status: "not_found", scope, candidates: [], truncated: false };
    if (task) return this.project(task, scope, limit);

    if (!query) return { kind: "task_resume", status: "query_required", scope, candidates: this.candidates(scope, "", MAX_CANDIDATES), truncated: this.activeTaskCount(scope) > MAX_CANDIDATES };
    const candidates = this.candidates(scope, query, MAX_CANDIDATES + 1);
    if (candidates.length === 1) return this.project(this.taskByReference(candidates[0].task_ref, scope)!, scope, limit);
    const capped = candidates.slice(0, MAX_CANDIDATES);
    if (capped.length) return { kind: "task_resume", status: "ambiguous", scope, candidates: capped, truncated: candidates.length > capped.length };
    return { kind: "task_resume", status: "not_found", scope, candidates: [], truncated: false };
  }

  private project(task: Episode, scope: string, limit: number): TaskResumeView {
    const taskRef = episodeRef(task), taskSources = episodeSources(task), taskEvidenceRefs = [...taskSources.events, ...taskSources.artifacts], active = task.status === "active";
    const decisions = this.linkedDecisions(scope, task.id), outcomes = this.outcomes.forTask(scope, taskRef, MAX_ITEMS + 1);
    const completed: TaskResumeStateItem[] = [], pending: TaskResumeStateItem[] = [], blockers: TaskResumeStateItem[] = [], constraints: TaskResumeStateItem[] = [], nextSteps: TaskResumeStateItem[] = [], decisionItems: TaskResumeStateItem[] = [], planned: TaskResumeStateItem[] = [], history: TaskResumeStateItem[] = [], needsReconfirmation: TaskResumeStateItem[] = [];

    if (!active) needsReconfirmation.push({ kind: "needs_reconfirmation", text: "The task’s source episode is no longer active; confirm its current state before continuing.", source_refs: [taskRef], recorded_at: task.recordedAt });
    else if (!this.evidenceActive(scope, taskEvidenceRefs)) needsReconfirmation.push({ kind: "needs_reconfirmation", text: "The task’s source evidence is unavailable; confirm its current state before continuing.", source_refs: [taskRef, ...taskEvidenceRefs], recorded_at: task.recordedAt });
    const currentDecisions = decisions.current, currentOutcomes = outcomes.filter(outcome => outcome.status === "recorded");
    const actionOutcomes = new Map<string, TaskOutcome[]>();
    for (const outcome of currentOutcomes) if (outcome.actionRef && outcome.actionState) actionOutcomes.set(outcome.actionRef, [...(actionOutcomes.get(outcome.actionRef) ?? []), outcome]);
    for (const outcome of outcomes) if (outcome.status === "superseded") history.push(historyItem(outcome));

    const handledActionRefs = new Set<string>();
    for (const decision of currentDecisions) {
      const decisionRefValue = decisionRef(decision), refs = [decisionRefValue, ...decision.evidence.map(item => item.sourceRef)], recordedAt = decision.decidedAt ?? decision.recordedAt;
      decisionItems.push({ kind: "decision", text: decision.chosenAction ?? decision.objective, source_refs: refs, recorded_at: recordedAt });
      for (const constraint of decision.constraints) constraints.push({ kind: "constraint", text: constraint, source_refs: refs, recorded_at: recordedAt });
      if (!decision.chosenAction) continue;
      const linked = actionOutcomes.get(decisionRefValue) ?? [];
      handledActionRefs.add(decisionRefValue);
      if (!linked.length) {
        nextSteps.push({ kind: "decision", text: decision.chosenAction, source_refs: refs, recorded_at: recordedAt });
        continue;
      }
      if (linked.length !== 1) {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "Conflicting confirmed states exist for a linked action; confirm its current result before continuing.", source_refs: linked.flatMap(actionRefs), recorded_at: Math.max(...linked.map(item => item.recordedAt)) });
        continue;
      }
      const outcome = linked[0], actionRefsValue = actionRefs(outcome);
      if (!this.evidenceActive(scope, outcome.evidenceRefs)) {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked action state has unavailable evidence and must be reconfirmed.", source_refs: actionRefsValue, recorded_at: outcome.recordedAt });
        continue;
      }
      this.projectActionState(outcome, completed, pending, blockers, history, needsReconfirmation);
    }
    for (const [actionRef, linked] of actionOutcomes) if (!handledActionRefs.has(actionRef)) for (const outcome of linked) history.push(historyItem(outcome, "A tracked action is no longer a current decision."));
    for (const item of decisions.planned) planned.push(item);
    for (const stale of decisions.needsReconfirmation) needsReconfirmation.push(stale);

    const taskOutcomes = currentOutcomes.filter(outcome => !outcome.actionRef);
    for (const outcome of taskOutcomes) {
      const item = outcomeItem(outcome);
      if (!this.evidenceActive(scope, outcome.evidenceRefs)) {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "An accepted task outcome has unavailable evidence and must be reconfirmed.", source_refs: [outcomeRef(outcome), ...outcome.evidenceRefs], recorded_at: outcome.recordedAt });
      } else if (outcome.verdict === "success") {
        completed.push(item);
      } else if (outcome.verdict === "failure") {
        blockers.push(item);
        pending.push({ ...item, kind: "partial", text: outcome.summary ?? "A failed task outcome was recorded; choose and confirm the next action before continuing." });
      } else {
        pending.push(item);
      }
    }
    if (!currentDecisions.length && !currentOutcomes.length && !planned.length) needsReconfirmation.push({ kind: "needs_reconfirmation", text: "No accepted decision or outcome describes the current task state; confirm progress before continuing.", source_refs: [taskRef, ...taskEvidenceRefs], recorded_at: task.recordedAt });

    const progress = !active || needsReconfirmation.length ? "needs_reconfirmation" : blockers.length ? "blocked" : taskOutcomes.some(outcome => outcome.verdict === "success" && this.evidenceActive(scope, outcome.evidenceRefs)) && !pending.length && !nextSteps.length ? "completed" : currentDecisions.length || currentOutcomes.length || planned.length ? "in_progress" : "unknown";
    const allItems = [...completed, ...pending, ...blockers, ...constraints, ...nextSteps, ...decisionItems, ...planned, ...history, ...needsReconfirmation];
    const lastVerified = currentOutcomes.filter(outcome => this.evidenceActive(scope, outcome.evidenceRefs)).reduce<number | null>((latest, outcome) => latest === null || outcome.recordedAt > latest ? outcome.recordedAt : latest, null);
    const lastEvidence = Math.max(task.recordedAt, ...currentDecisions.map(item => item.recordedAt), ...planned.map(item => item.recorded_at), ...outcomes.map(item => item.recordedAt));
    const limited = [completed, pending, blockers, constraints, nextSteps, decisionItems, planned, history, needsReconfirmation].map(items => items.slice(0, limit));
    return {
      kind: "task_resume",
      status: !active || needsReconfirmation.length ? "needs_reconfirmation" : blockers.length ? "blocked" : "ready",
      scope,
      task: { id: task.id, task_ref: taskRef, title: task.title ?? "Untitled task", goal: task.summary, progress, last_verified_at: lastVerified, last_evidence_at: lastEvidence, source_refs: taskSources.events, artifact_refs: taskSources.artifacts },
      completed: limited[0], pending: limited[1], blockers: limited[2], constraints: limited[3], next_steps: limited[4], decisions: limited[5], planned: limited[6], history: limited[7], needs_reconfirmation: limited[8],
      truncated: allItems.length > limited.reduce((count, items) => count + items.length, 0)
    };
  }

  private projectActionState(outcome: TaskOutcome, completed: TaskResumeStateItem[], pending: TaskResumeStateItem[], blockers: TaskResumeStateItem[], history: TaskResumeStateItem[], needsReconfirmation: TaskResumeStateItem[]): void {
    const item = actionItem(outcome), state = outcome.actionState as TaskActionState;
    if (state === "completed") completed.push(item);
    else if (state === "partial") pending.push(item);
    else if (state === "failed") {
      blockers.push(item);
      pending.push({ ...item, kind: "partial", text: outcome.summary ?? "A linked action failed; choose and confirm its recovery before continuing." });
    } else if (state === "attempted") {
      pending.push({ ...item, kind: "partial", text: outcome.summary ?? "A linked action was attempted; confirm its result before continuing." });
      needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked action was attempted but its final result is not confirmed.", source_refs: actionRefs(outcome), recorded_at: outcome.recordedAt });
    } else {
      history.push(historyItem(outcome));
    }
  }

  private linkedDecisions(scope: string, episodeId: string): { current: DecisionMemory[]; planned: TaskResumeStateItem[]; needsReconfirmation: TaskResumeStateItem[] } {
    const current: DecisionMemory[] = [], planned: TaskResumeStateItem[] = [], needsReconfirmation: TaskResumeStateItem[] = [];
    const rows = this.db.prepare(`SELECT d.id FROM mnemora_decisions d
      JOIN mnemora_decision_episodes e ON e.decision_id=d.id
      WHERE d.scope=? AND e.episode_id=?
      ORDER BY d.recorded_at DESC,d.id DESC LIMIT ?`).all(scope, episodeId, MAX_ITEMS + 1) as Array<{ id: string }>;
    for (const row of rows) {
      const decision = this.decisions.get(row.id, scope);
      if (!decision) continue;
      const refs = [decisionRef(decision), ...decision.evidence.map(item => item.sourceRef)], recordedAt = decision.decidedAt ?? decision.recordedAt;
      if (decision.status === "needs_review") {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked decision’s evidence needs review and must be reconfirmed.", source_refs: refs, recorded_at: recordedAt });
        continue;
      }
      if (decision.status !== "active") continue;
      const now = this.now();
      if (decision.validFrom !== undefined && now < decision.validFrom) {
        planned.push({ kind: "planned", text: decision.chosenAction ?? decision.objective, source_refs: refs, recorded_at: recordedAt });
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked decision is scheduled for future activation; wait until its declared effective time before continuing.", source_refs: refs, recorded_at: recordedAt });
      } else if (decision.validUntil !== undefined && decision.validUntil < now) {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked decision has passed its declared validity window and must be reconfirmed.", source_refs: refs, recorded_at: recordedAt });
      } else if (!this.evidenceActive(scope, decision.evidence.map(item => item.sourceRef))) {
        needsReconfirmation.push({ kind: "needs_reconfirmation", text: "A linked decision has unavailable evidence and must be reconfirmed.", source_refs: refs, recorded_at: recordedAt });
      } else current.push(decision);
    }
    return { current, planned, needsReconfirmation };
  }

  private taskByReference(value: string, scope: string): Episode | undefined {
    let reference;
    try { reference = authorizeMnemoraContextRef(value, { scope, kinds: ["episode"] }); }
    catch { throw new Error("invalid_task_resume"); }
    const task = this.episodes.get(reference.id, scope);
    return task?.kind === "task" ? task : undefined;
  }

  private candidates(scope: string, query: string, limit: number): TaskResumeCandidate[] {
    const tasks = this.taskEpisodes(scope), terms = tokenize(query), scored = tasks.map(task => ({ task, score: taskScore(task, terms) }));
    const matching = terms.length ? scored.filter(item => item.score > 0) : scored;
    // “Continue this project” has no task identity. Present bounded candidates
    // instead of pretending that the most recent task is authoritative.
    return matching.sort((a, b) => b.score - a.score || b.task.recordedAt - a.task.recordedAt || a.task.id.localeCompare(b.task.id)).slice(0, limit).map(({ task }) => ({ task_ref: episodeRef(task), title: task.title ?? "Untitled task", goal: task.summary, last_evidence_at: task.recordedAt, source_refs: [...episodeSources(task).events, ...episodeSources(task).artifacts] }));
  }

  private taskEpisodes(scope: string): Episode[] {
    const rows = this.db.prepare("SELECT id FROM mnemora_episodes WHERE scope=? AND kind='task' AND status='active' AND deleted_at IS NULL ORDER BY recorded_at DESC,id DESC LIMIT 100").all(scope) as Array<{ id: string }>;
    return rows.flatMap(row => this.episodes.get(row.id, scope) ?? []);
  }

  private activeTaskCount(scope: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS value FROM mnemora_episodes WHERE scope=? AND kind='task' AND status='active' AND deleted_at IS NULL").get(scope) as { value: unknown }).value);
  }

  private evidenceActive(scope: string, refs: string[]): boolean {
    try { for (const value of refs) this.references.requireActive(authorizeMnemoraContextRef(value, { scope })); return true; }
    catch { return false; }
  }
}

function episodeRef(task: Episode): string { return createMnemoraContextRef({ scope: task.scope, kind: "episode", id: task.id }); }
function decisionRef(decision: DecisionMemory): string { return createMnemoraContextRef({ scope: decision.scope, kind: "decision", id: decision.id }); }
function outcomeRef(outcome: TaskOutcome): string { return createMnemoraContextRef({ scope: outcome.scope, kind: "task-outcome", id: outcome.id }); }
function episodeSources(task: Episode): { events: string[]; artifacts: string[] } { return { events: task.sourceEventIds.map(id => createMnemoraContextRef({ scope: task.scope, kind: "conversation-event", id })), artifacts: task.sourceArtifactIds.map(id => createMnemoraContextRef({ scope: task.scope, kind: "artifact", id })) }; }
function outcomeItem(outcome: TaskOutcome): TaskResumeStateItem { const kind = outcome.verdict === "success" ? "completed" : outcome.verdict === "failure" ? "failed" : "partial"; return { kind, text: outcome.summary ?? outcomeMessage(outcome.verdict), source_refs: [outcomeRef(outcome), ...outcome.evidenceRefs], recorded_at: outcome.recordedAt }; }
function actionRefs(outcome: TaskOutcome): string[] { return [outcomeRef(outcome), ...(outcome.actionRef ? [outcome.actionRef] : []), ...outcome.evidenceRefs]; }
function actionItem(outcome: TaskOutcome): TaskResumeStateItem { const kind = outcome.actionState === "completed" ? "completed" : outcome.actionState === "failed" ? "failed" : "partial"; return { kind, text: outcome.summary ?? actionMessage(outcome.actionState), source_refs: actionRefs(outcome), recorded_at: outcome.recordedAt }; }
function historyItem(outcome: TaskOutcome, fallback?: string): TaskResumeStateItem { return { kind: "history", text: outcome.summary ?? fallback ?? (outcome.actionState ? actionMessage(outcome.actionState) : outcomeMessage(outcome.verdict)), source_refs: actionRefs(outcome), recorded_at: outcome.recordedAt }; }
function outcomeMessage(verdict: TaskOutcome["verdict"]): string { return verdict === "failure" ? "A failed attempt was recorded." : verdict === "partial" ? "A partial outcome was recorded." : verdict === "unknown" ? "An outcome with unknown completion was recorded." : "A successful outcome was recorded."; }
function actionMessage(state: TaskActionState | undefined): string { return state === "attempted" ? "A linked action was attempted." : state === "partial" ? "A linked action is partially complete." : state === "completed" ? "A linked action was completed." : state === "failed" ? "A linked action failed." : state === "cancelled" ? "A linked action was cancelled." : "A linked action was superseded."; }
function tokenize(value: string): string[] { return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 12); }
function taskScore(task: Episode, terms: string[]): number { const haystack = `${task.title ?? ""}\n${task.summary}`.toLowerCase(); return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0); }
function text(value: unknown, max: number): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined; }
function bound(value: unknown): number { return typeof value === "number" && Number.isInteger(value) ? Math.min(MAX_ITEMS, Math.max(1, value)) : MAX_ITEMS; }
