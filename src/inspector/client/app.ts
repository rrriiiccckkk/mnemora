import { api, bootstrap } from "./api.js";
import { renderGraph } from "./graph-view.js";

type GraphPage = { nodes: unknown[]; edges: unknown[]; next_cursor: string | null };
type Capabilities = { operations: boolean; graph_revision?: number; config_revision?: number };
type ScopeList = { default_scope: string; scopes: Array<{ id: string }> };
type MemoryItem = { kind: string; title: string; detail: string; updated_at: number };
type MemoryWorkbench = { scope: string; summary: { accepted_facts: number; pending_reviews: number; stale_items: number; conflicts: number }; accepted: MemoryItem[]; attention: MemoryItem[]; truncated: boolean };
type MemoryView = { scope: string; section: string; items: Array<Record<string, unknown>>; truncated: boolean };
type CorrectionKind = "event" | "artifact" | "episode" | "summary";
type MemoryCorrectionPreview = { kind: "memory_correction"; phase: "preview"; preview_token: string; scope: string; target: { kind: CorrectionKind }; affected: ImpactCounts };
type MemoryCorrectionResult = { kind: "memory_correction"; phase: "confirm"; forgotten: true; scope: string; target: { kind: CorrectionKind }; affected: ImpactCounts };
type ImpactCounts = { events: number; artifacts: number; episodes: number; summaries: number; decisions: number };
type RecallCandidate = { kind: "node" | "edge"; decision: "included" | "excluded"; reason: string; pending_conflict: boolean };
type RecallActualAttachment = { telemetry: "available" | "disabled"; status: "matched" | "not_observed" | "not_comparable"; attached?: boolean; created_at?: number; local_selected_count?: number; graph_attached?: boolean };
type RecallExplanation = { kind: "memory_intelligence"; view: "retrieval"; scope: string; automatic_recall_configured: boolean; strict_verification_enabled: boolean; policy: { allowed: boolean; reason: string }; candidates: RecallCandidate[]; injected: { candidates_considered: number; nodes: number; memories: number; budget_tokens: number }; actual_attachment?: RecallActualAttachment; items?: Array<Record<string, unknown>> };
type IntelligenceView = { kind: "memory_intelligence"; view: string; scope: string; items: Array<Record<string, unknown>>; truncated: boolean };
type TaskResumeStateItem = { kind: string; text: string; source_refs: string[]; recorded_at: number };
type TaskResumeCandidate = { task_ref: string; title: string; goal: string; last_evidence_at: number; source_refs: string[] };
type TaskResumeResult = { kind: "task_resume"; status: "ready" | "needs_reconfirmation"; scope: string; task: { id: string; task_ref: string; title: string; goal: string; last_verified_at: number | null; last_evidence_at: number; source_refs: string[]; artifact_refs: string[] }; completed: TaskResumeStateItem[]; pending: TaskResumeStateItem[]; blockers: TaskResumeStateItem[]; next_steps: TaskResumeStateItem[]; decisions: TaskResumeStateItem[]; needs_reconfirmation: TaskResumeStateItem[]; truncated: boolean } | { kind: "task_resume"; status: "ambiguous" | "not_found" | "query_required"; scope: string; candidates: TaskResumeCandidate[]; truncated: boolean };

let graphCursor: string | null = null;
let entityCursor: string | null = null;
let researchCursor: string | null = null;
let sourcesCursor: string | null = null;
let researchSection = "insights";
let capabilities: Capabilities = { operations: false };
let lastPreview: any;
let lastPayload: Record<string, unknown> = {};
let correctionPreview: MemoryCorrectionPreview | undefined;

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;

async function start(): Promise<void> {
  await bootstrap();
  capabilities = await api<Capabilities>("/api/capabilities");
  const operations = $<HTMLButtonElement>('button[data-view="operations"]');
  if (capabilities.operations) operations.hidden = false;
  await loadScopes();
  bindNavigation();
  bindForms();
  await showOverview();
  $("#status").textContent = capabilities.operations ? "Operations enabled" : "Read-only";
}

function bindNavigation(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("nav button")) button.addEventListener("click", () => {
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) panel.hidden = panel.id !== button.dataset.view;
    for (const item of document.querySelectorAll("nav button")) item.removeAttribute("aria-current");
    button.setAttribute("aria-current", "page");
    if (button.dataset.view === "memory") void loadMemory();
    if (button.dataset.view === "task-resume") void loadTaskResume();
    if (button.dataset.view === "intelligence") void loadIntelligence();
    if (button.dataset.view === "graph") void loadGraph(true);
    if (button.dataset.view === "sources") { sourcesCursor = null; void loadSources(); }
    if (button.dataset.view === "trust") void loadTrust();
  });
}

function bindForms(): void {
  $<HTMLFormElement>("#memory-form").addEventListener("submit", event => { event.preventDefault(); void loadMemory(); });
  $<HTMLSelectElement>("#memory-scope").addEventListener("change", () => void loadMemory());
  $<HTMLFormElement>("#task-resume-form").addEventListener("submit", event => { event.preventDefault(); void loadTaskResume(); });
  $<HTMLSelectElement>("#task-resume-scope").addEventListener("change", () => void loadTaskResume());
  $<HTMLFormElement>("#intelligence-form").addEventListener("submit", event => { event.preventDefault(); void loadIntelligence(); });
  $<HTMLSelectElement>("#intelligence-scope").addEventListener("change", () => void loadIntelligence());
  $<HTMLFormElement>("#graph-filters").addEventListener("submit", event => { event.preventDefault(); void loadGraph(true); });
  $("#load-more").addEventListener("click", () => void loadGraph(false));
  $<HTMLFormElement>("#entity-form").addEventListener("submit", event => { event.preventDefault(); entityCursor = null; void loadEntity(); });
  $("#entity-next").addEventListener("click", () => void loadEntity());
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-research]")) button.addEventListener("click", () => { researchSection = button.dataset.research ?? "insights"; researchCursor = null; void loadResearch(); });
  $("#research-next").addEventListener("click", () => void loadResearch());
  $("#sources-next").addEventListener("click", () => void loadSources());
  $<HTMLFormElement>("#operation-form").addEventListener("submit", event => { event.preventDefault(); void previewOperation(); });
  $("#confirm-operation").addEventListener("click", () => void confirmOperation());
  $("#confirm-memory-correction").addEventListener("click", () => void confirmMemoryCorrection());
  $("#cancel-memory-correction").addEventListener("click", clearMemoryCorrection);
}

async function showOverview(): Promise<void> {
  const value = await api<any>("/api/overview");
  $("#overview-cards").innerHTML = ["nodes", "edges", "observations", "graph_revision"].map(key => `<article class="card"><span>${key.replace("_", " ")}</span><strong>${Number(value[key] ?? 0).toLocaleString()}</strong></article>`).join("");
}

async function loadScopes(): Promise<void> {
  const result = await api<ScopeList>("/api/scopes");
  const ids = [...new Set([result.default_scope, ...result.scopes.map(scope => scope.id)])].filter(Boolean);
  for (const selector of ["#memory-scope", "#task-resume-scope", "#intelligence-scope"]) {
    const element = $<HTMLSelectElement>(selector), prior = element.value;
    element.replaceChildren(...ids.map(id => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      return option;
    }));
    element.value = ids.includes(prior) ? prior : result.default_scope;
  }
}

async function loadMemory(): Promise<void> {
  const form = new FormData($<HTMLFormElement>("#memory-form"));
  const section = String(form.get("section") ?? "today"), limit = Number(form.get("limit") ?? 20), subject = String(form.get("subject") ?? "").trim();
  const scope = $<HTMLSelectElement>("#memory-scope").value;
  const [workbench, result] = await Promise.all([
    api<MemoryWorkbench>("/api/memory-workbench", { scope, limit: 8 }),
    api<MemoryView>("/api/memory", { scope, section, limit, ...(subject ? { subject } : {}) })
  ]);
  renderWorkbench(workbench);
  renderMemoryItems(result);
}

async function loadTaskResume(): Promise<void> {
  const form = new FormData($<HTMLFormElement>("#task-resume-form"));
  const query = String(form.get("query") ?? "").trim(), taskRef = String(form.get("task_ref") ?? "").trim(), limit = Number(form.get("limit") ?? 8);
  const result = await api<TaskResumeResult>("/api/task-resume", { scope: $<HTMLSelectElement>("#task-resume-scope").value, limit, ...(query ? { query } : {}), ...(taskRef ? { task_ref: taskRef } : {}) });
  renderTaskResume(result);
}

function renderTaskResume(result: TaskResumeResult): void {
  const root = $<HTMLElement>("#task-resume-result");
  root.replaceChildren();
  if (!("task" in result)) {
    root.append(emptyMessage(result.status === "ambiguous" ? "Choose the task to resume. Similar tasks are not merged automatically." : result.status === "query_required" ? "Enter a task query or choose one of the available task records." : "No task record matched this request in the selected scope."));
    if (result.candidates.length) {
      const choices = document.createElement("section");
      choices.className = "resume-list";
      const heading = document.createElement("h3");
      heading.textContent = "Task candidates";
      choices.append(heading);
      for (const candidate of result.candidates) {
        const item = document.createElement("article");
        item.className = "resume-item";
        const title = document.createElement("h4"), goal = document.createElement("p"), button = document.createElement("button");
        title.textContent = candidate.title;
        goal.textContent = candidate.goal;
        button.type = "button";
        button.textContent = "Resume this task";
        button.addEventListener("click", () => {
          $<HTMLInputElement>('#task-resume-form input[name="task_ref"]').value = candidate.task_ref;
          void loadTaskResume();
        });
        item.append(title, goal, referenceList(candidate.source_refs), button);
        choices.append(item);
      }
      root.append(choices);
    }
    return;
  }
  const overview = document.createElement("section");
  overview.className = "resume-list";
  const title = document.createElement("h3"), goal = document.createElement("p"), meta = document.createElement("p");
  title.textContent = result.task.title;
  goal.textContent = result.task.goal;
  meta.className = "empty-state";
  meta.textContent = `Last verified: ${result.task.last_verified_at ? new Date(result.task.last_verified_at).toLocaleString() : "Not recorded"}. Last evidence: ${new Date(result.task.last_evidence_at).toLocaleString()}.`;
  overview.append(title, goal, meta, referenceList([...result.task.source_refs, ...result.task.artifact_refs]));
  root.append(overview);
  const columns = document.createElement("div");
  columns.className = "resume-columns";
  columns.append(resumeList("Completed", result.completed, "No accepted completed item."), resumeList("Pending", result.pending, "No accepted pending item."), resumeList("Blockers", result.blockers, "No blocker recorded."), resumeList("Next steps", result.next_steps, "No next step is evidenced."), resumeList("Decisions", result.decisions, "No accepted decision."), resumeList("Needs reconfirmation", result.needs_reconfirmation, "No reconfirmation needed."));
  root.append(columns);
}

function resumeList(title: string, items: TaskResumeStateItem[], empty: string): HTMLElement {
  const section = document.createElement("section");
  section.className = title === "Needs reconfirmation" ? "resume-list resume-attention" : "resume-list";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  if (!items.length) { section.append(emptyMessage(empty)); return section; }
  for (const value of items) {
    const item = document.createElement("article");
    item.className = "resume-item";
    const text = document.createElement("p");
    text.textContent = value.text;
    item.append(text, referenceList(value.source_refs));
    section.append(item);
  }
  return section;
}

function referenceList(refs: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const ref of refs.slice(0, 8)) {
    const value = document.createElement("code");
    value.className = "resume-ref";
    value.textContent = ref;
    root.append(value);
  }
  return root;
}

function renderWorkbench(value: MemoryWorkbench): void {
  const root = $<HTMLElement>("#memory-workbench");
  root.dataset.scope = value.scope;
  const summary = document.createElement("div");
  summary.className = "cards memory-summary";
  for (const [label, count] of [["Accepted facts", value.summary.accepted_facts], ["Needs review", value.summary.pending_reviews], ["Outdated items", value.summary.stale_items], ["Conflicts", value.summary.conflicts]] as const) summary.append(memoryMetric(label, count));
  const lists = document.createElement("div");
  lists.className = "memory-columns";
  lists.append(workbenchList("Needs attention", value.attention, "No urgent review items in this scope."), workbenchList("Accepted facts", value.accepted, "No verified facts in this scope yet."));
  root.replaceChildren(summary, lists);
}

function memoryMetric(label: string, count: number): HTMLElement {
  const card = document.createElement("article");
  card.className = "card";
  const name = document.createElement("span"), value = document.createElement("strong");
  name.textContent = label;
  value.textContent = Number(count ?? 0).toLocaleString();
  card.append(name, value);
  return card;
}

function workbenchList(title: string, items: MemoryItem[], empty: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "memory-list";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  if (!items.length) {
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = empty;
    section.append(message);
    return section;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = `memory-item memory-${item.kind}`;
    const name = document.createElement("h4"), detail = document.createElement("p");
    name.textContent = item.title;
    detail.textContent = item.detail;
    card.append(name, detail);
    section.append(card);
  }
  return section;
}

function renderMemoryItems(value: MemoryView): void {
  renderRecords($<HTMLElement>("#memory-result"), value.items, "Nothing to show in this view yet.", item => correctionTarget(value.section, item), item => value.section === "claims" && typeof item.claim_id === "string" ? item.claim_id : undefined);
}

function renderRecords(root: HTMLElement, items: Array<Record<string, unknown>>, empty: string, target?: (item: Record<string, unknown>) => { kind: CorrectionKind; id: string } | undefined, claim?: (item: Record<string, unknown>) => string | undefined): void {
  root.replaceChildren();
  if (!items.length) {
    root.append(emptyMessage(empty));
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "memory-item";
    const heading = document.createElement("h4");
    heading.textContent = firstText(item, ["title", "summary", "text", "claim_id", "id", "report"]) || "Memory item";
    card.append(heading);
    const details = document.createElement("dl");
    for (const [key, current] of Object.entries(item).filter(([key]) => !["title", "summary", "text", "claim_id", "id", "report"].includes(key)).slice(0, 8)) {
      const term = document.createElement("dt"), description = document.createElement("dd");
      term.textContent = key.replaceAll("_", " ");
      description.textContent = displayValue(key, current);
      details.append(term, description);
    }
    card.append(details);
    const claimId = claim?.(item);
    if (claimId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "memory-correction-button";
      button.dataset.claimEvidence = "true";
      button.textContent = "View evidence";
      button.addEventListener("click", () => openClaimProvenance(claimId, $<HTMLSelectElement>("#memory-scope").value));
      card.append(button);
    } else {
      const correction = target?.(item);
      if (correction && capabilities.operations) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "memory-correction-button";
      button.dataset.correctKind = correction.kind;
      button.textContent = "Review removal impact";
      button.addEventListener("click", () => void previewMemoryCorrection(correction));
      card.append(button);
      }
    }
    root.append(card);
  }
}

function openClaimProvenance(claimId: string, scope: string): void {
  $<HTMLSelectElement>("#intelligence-scope").value = scope;
  $<HTMLSelectElement>('#intelligence-form select[name="view"]').value = "provenance";
  $<HTMLInputElement>('#intelligence-form input[name="value"]').value = claimId;
  $<HTMLElement>('button[data-view="intelligence"]').click();
}

function correctionTarget(section: string, item: Record<string, unknown>): { kind: CorrectionKind; id: string } | undefined {
  const kinds: Record<string, CorrectionKind> = { today: "event", episodes: "episode", summaries: "summary", artifacts: "artifact" };
  const id = typeof item.id === "string" ? item.id : "";
  return kinds[section] && id ? { kind: kinds[section], id } : undefined;
}

async function previewMemoryCorrection(target: { kind: CorrectionKind; id: string }): Promise<void> {
  const root = $<HTMLElement>("#memory-correction"), copy = $("#memory-correction-copy");
  root.hidden = false;
  copy.textContent = "Calculating the downstream impact…";
  $<HTMLButtonElement>("#confirm-memory-correction").disabled = true;
  try {
    correctionPreview = await api<MemoryCorrectionPreview>("/api/memory-correction/preview", { scope: $<HTMLSelectElement>("#memory-scope").value, ...target });
    copy.textContent = "Review the affected memory before removing this item from future recall.";
    renderImpact(correctionPreview.affected);
    $<HTMLButtonElement>("#confirm-memory-correction").disabled = false;
  } catch {
    correctionPreview = undefined;
    $("#memory-correction-impact").replaceChildren();
    copy.textContent = "The impact preview is no longer available. Refresh the memory view and try again.";
  }
}

async function confirmMemoryCorrection(): Promise<void> {
  if (!correctionPreview) return;
  const button = $<HTMLButtonElement>("#confirm-memory-correction");
  button.disabled = true;
  try {
    const result = await api<MemoryCorrectionResult>("/api/memory-correction/confirm", { preview_token: correctionPreview.preview_token });
    $("#memory-correction-copy").textContent = "This memory was removed from future recall. Dependent decisions, if any, now need review.";
    renderImpact(result.affected);
    correctionPreview = undefined;
    await loadMemory();
  } catch {
    $("#memory-correction-copy").textContent = "The memory changed before confirmation. Review its impact again.";
  }
}

function clearMemoryCorrection(): void {
  correctionPreview = undefined;
  $<HTMLElement>("#memory-correction").hidden = true;
  $("#memory-correction-impact").replaceChildren();
  $<HTMLButtonElement>("#confirm-memory-correction").disabled = true;
}

function renderImpact(affected: ImpactCounts): void {
  const root = $("#memory-correction-impact");
  root.replaceChildren(...[["Events", affected.events], ["Artifacts", affected.artifacts], ["Episodes", affected.episodes], ["Summaries", affected.summaries], ["Decisions needing review", affected.decisions]].map(([label, count]) => memoryMetric(String(label), Number(count))));
}

function firstText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) if (typeof item[key] === "string" && item[key].trim()) return item[key] as string;
  return "";
}

function displayValue(key: string, value: unknown): string {
  if (key.endsWith("_at") && typeof value === "number" && Number.isFinite(value)) return new Date(value).toLocaleString();
  if (value === null) return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  if (typeof value === "string") return value;
  return "Available";
}

async function loadIntelligence(): Promise<void> {
  const form = new FormData($<HTMLFormElement>("#intelligence-form"));
  const view = String(form.get("view") ?? "retrieval"), value = String(form.get("value") ?? "").trim(), limit = Number(form.get("limit") ?? 20);
  const payload: Record<string, unknown> = { view, limit, scope: $<HTMLSelectElement>("#intelligence-scope").value };
  if (view === "provenance") payload.claim_id = value;
  if (view === "retrieval") payload.query = value;
  const result = await api<IntelligenceView | RecallExplanation>("/api/intelligence", payload);
  if (result.view === "retrieval") renderRecallExplanation(result as RecallExplanation);
  else renderRecords($<HTMLElement>("#intelligence-result"), result.items ?? [], "Nothing to show in this trace yet.");
}

function renderRecallExplanation(result: RecallExplanation): void {
  const root = $<HTMLElement>("#intelligence-result");
  root.replaceChildren();
  if (result.items?.[0]?.status === "query_required") {
    root.append(emptyMessage("Enter the question you asked to see the retrieval decision."));
    return;
  }
  if (result.items?.[0]?.status === "unavailable") {
    root.append(emptyMessage("This explanation is temporarily unavailable. No memory was changed."));
    return;
  }
  const overview = document.createElement("section");
  overview.className = "recall-overview";
  const heading = document.createElement("h3"), decision = document.createElement("p"), detail = document.createElement("p");
  heading.textContent = "What the recall policy decided";
  decision.textContent = result.policy.allowed ? "The policy allows this scope to contribute memory." : "The policy did not allow memory from this scope.";
  detail.className = "empty-state";
  detail.textContent = policyReason(result.policy.reason);
  overview.append(heading, decision, detail, actualAttachment(result.actual_attachment));
  root.append(overview);
  const metrics = document.createElement("div");
  metrics.className = "cards recall-metrics";
  metrics.append(memoryMetric("Would be included", result.injected.nodes + result.injected.memories), memoryMetric("Considered", result.injected.candidates_considered), memoryMetric("Context budget", result.injected.budget_tokens));
  root.append(metrics);
  const candidates = document.createElement("section");
  candidates.className = "recall-candidates";
  const candidateHeading = document.createElement("h3");
  candidateHeading.textContent = "Candidate decisions";
  candidates.append(candidateHeading);
  if (!result.candidates.length) candidates.append(emptyMessage("No graph candidates matched this question in this scope."));
  else result.candidates.forEach((candidate, index) => candidates.append(recallCandidate(candidate, index + 1)));
  root.append(candidates);
}

function actualAttachment(value: RecallActualAttachment | undefined): HTMLElement {
  const message = document.createElement("p");
  message.className = "actual-attachment";
  if (!value || value.telemetry === "disabled") message.textContent = "Actual ContextEngine attachment is not observable because redacted recall telemetry is off.";
  else if (value.status === "not_comparable") message.textContent = "This question was routed before automatic recall, so the policy trace cannot be compared with a stored attachment run.";
  else if (value.status === "not_observed") message.textContent = "No matching ContextEngine run has been observed yet. This is a retrieval explanation, not proof of attachment.";
  else message.textContent = value.attached ? `A matching ContextEngine run attached memory${value.created_at ? ` on ${new Date(value.created_at).toLocaleString()}` : ""}.` : "A matching ContextEngine run did not attach memory.";
  return message;
}

function recallCandidate(candidate: RecallCandidate, index: number): HTMLElement {
  const card = document.createElement("article");
  card.className = `memory-item recall-${candidate.decision}`;
  const heading = document.createElement("h4"), detail = document.createElement("p");
  heading.textContent = `Candidate ${index}: ${candidate.decision === "included" ? "would be retrieved" : "not retrieved"}`;
  detail.textContent = `${reasonLabel(candidate.reason)}${candidate.pending_conflict ? " It also has a pending conflict." : ""}`;
  card.append(heading, detail);
  return card;
}

function emptyMessage(text: string): HTMLElement {
  const message = document.createElement("p");
  message.className = "empty-state";
  message.textContent = text;
  return message;
}

function policyReason(reason: string): string {
  return ({ verification_disabled: "Verification filtering is not enabled for automatic recall.", verified_evidence: "At least one candidate has eligible verified evidence.", no_eligible_evidence: "No candidate has eligible verified evidence.", no_candidates: "No candidate was available in this scope." } as Record<string, string>)[reason] ?? "The policy returned a bounded decision.";
}

function reasonLabel(reason: string): string {
  return ({ verification_disabled: "Verification filtering is disabled.", verified_evidence: "It has eligible verified evidence.", unverified_evidence: "Its evidence is not eligible for recall.", no_claim_evidence: "It has no claim evidence for this policy." } as Record<string, string>)[reason] ?? "The policy returned a bounded decision.";
}

async function loadGraph(reset: boolean): Promise<void> {
  if (reset) graphCursor = null;
  const form = new FormData($<HTMLFormElement>("#graph-filters"));
  const text = (name: string) => String(form.get(name) ?? "").trim(), confidence = Number(form.get("confidence") ?? 0);
  const filters: any = { confidence_min: confidence };
  if (text("nodeType")) filters.node_types = [text("nodeType")];
  if (text("source")) filters.sources = [text("source")];
  if (text("community")) filters.community_id = text("community");
  if (text("validFrom")) filters.valid_from = Date.parse(`${text("validFrom")}T00:00:00.000Z`);
  if (text("validTo")) filters.valid_to = Date.parse(`${text("validTo")}T23:59:59.999Z`);
  const page = await api<GraphPage>("/api/graph", { kind: "graph", cursor: graphCursor ?? undefined, max_nodes: 5000, max_edges: 20000, filters });
  graphCursor = page.next_cursor;
  renderGraph($<HTMLElement>("#graph-canvas"), page as any);
  $<HTMLButtonElement>("#load-more").disabled = !graphCursor;
}

async function loadEntity(): Promise<void> {
  const form = new FormData($<HTMLFormElement>("#entity-form"));
  const id = String(form.get("id") ?? ""), section = String(form.get("section") ?? "evidence");
  const result: any = await api("/api/entity", { kind: "entity", id, section, cursor: entityCursor ?? undefined });
  entityCursor = result.next_cursor ?? null;
  $("#entity-result").textContent = JSON.stringify(result, null, 2);
  $<HTMLButtonElement>("#entity-next").disabled = !entityCursor;
}

async function loadResearch(): Promise<void> {
  const result: any = await api("/api/research", { kind: "research", section: researchSection, cursor: researchCursor ?? undefined });
  researchCursor = result.next_cursor ?? null;
  $("#research-result").textContent = JSON.stringify(result, null, 2);
  $<HTMLButtonElement>("#research-next").disabled = !researchCursor;
}

async function loadSources(): Promise<void> {
  const result: any = await api("/api/sources", { kind: "sources", cursor: sourcesCursor ?? undefined });
  sourcesCursor = result.next_cursor ?? null;
  $("#sources-result").textContent = JSON.stringify(result, null, 2);
  $<HTMLButtonElement>("#sources-next").disabled = !sourcesCursor;
}

async function loadTrust(): Promise<void> {
  const result: any = await api("/api/trust");
  $("#trust-result").textContent = JSON.stringify(result, null, 2);
}

function operationPayload(operation: string, form: FormData): Record<string, unknown> {
  const target = String(form.get("target") ?? "").trim(), amount = Number(form.get("amount"));
  if (operation === "source_trust") return { source: target, weight: amount };
  if (operation === "restore") return { artifact_id: target };
  if (operation === "orphan_cleanup" || operation === "weight_recompute") return Number.isSafeInteger(amount) && amount > 0 ? { limit: amount } : {};
  return {};
}

async function previewOperation(): Promise<void> {
  const form = new FormData($<HTMLFormElement>("#operation-form")), operation = String(form.get("operation"));
  capabilities = await api<Capabilities>("/api/capabilities");
  lastPayload = operationPayload(operation, form);
  const request: any = { operation, phase: "preview", graph_revision: capabilities.graph_revision ?? 0, payload: lastPayload };
  if (operation === "source_trust") request.config_revision = capabilities.config_revision ?? 0;
  lastPreview = await api("/api/operations/preview", request);
  $("#operation-result").textContent = JSON.stringify(lastPreview, null, 2);
  $<HTMLButtonElement>("#confirm-operation").disabled = false;
}

async function confirmOperation(): Promise<void> {
  if (!lastPreview) return;
  const request: any = { operation: lastPreview.operation, phase: "confirm", preview_token: lastPreview.preview_token, payload_hash: lastPreview.payload_hash, graph_revision: lastPreview.graph_revision, payload: lastPayload };
  if (lastPreview.operation === "source_trust") request.config_revision = lastPreview.config_revision;
  const result = await api("/api/operations/confirm", request);
  $("#operation-result").textContent = JSON.stringify(result, null, 2);
  lastPreview = undefined;
  lastPayload = {};
  $<HTMLButtonElement>("#confirm-operation").disabled = true;
  capabilities = await api<Capabilities>("/api/capabilities");
  await showOverview();
}

start().catch(() => { $("#status").textContent = "Inspector unavailable"; });
