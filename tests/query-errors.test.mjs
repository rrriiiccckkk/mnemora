import test from "node:test";
import assert from "node:assert/strict";
import { ResearchOperationError, toResearchError } from "../dist/query/errors.js";

const contracts = [
  ["ambiguous_subject", "COMPARE_SUBJECT_AMBIGUOUS", "subject_resolution", true, "Multiple graph subjects matched.", { side: "left", candidates: [], truncated: false }],
  ["subject_not_found", "COMPARE_SUBJECT_NOT_FOUND", "subject_resolution", true, "No graph subject matched.", { side: "right", candidates: [], truncated: false }],
  ["same_subject", "COMPARE_SAME_SUBJECT", "subject_resolution", true, "Subjects must be distinct.", {}],
  ["limit_exceeded", "COMPARE_LIMIT_EXCEEDED", "execution", false, "Comparison limit exceeded.", { limit: 5 }],
  ["invalid_plan", "QUERY_INVALID_PLAN", "planning", true, "Query plan is invalid.", {}],
  ["planner_unavailable", "QUERY_PLANNER_UNAVAILABLE", "planning", true, "Query planner is unavailable.", {}],
  ["timeout", "QUERY_TIMEOUT", "execution", true, "Query timed out.", {}],
  ["invalid_input", "WATCH_INVALID_INPUT", "input_validation", true, "Watch input is invalid.", {}],
  ["already_running", "DIGEST_ALREADY_RUNNING", "execution", true, "Digest is already running.", {}],
  ["invalid_import", "IMPORT_INVALID", "input_validation", true, "Import data is invalid.", {}],
  ["stale_import", "IMPORT_STALE", "persistence", true, "Import preview is stale.", {}],
  ["confirmation_required", "IMPORT_CONFIRMATION_REQUIRED", "authorization", true, "Import confirmation is required.", {}],
  ["export_limit", "EXPORT_LIMIT", "serialization", false, "Export limit exceeded.", { limit: 1024 }],
  ["operation_failed", "RESEARCH_OPERATION_FAILED", "execution", false, "Research operation failed.", {}]
];

test("research errors expose every closed code-stage contract", () => {
  for (const [error, error_code, stage, retryable, summary, details] of contracts) {
    const thrown = new ResearchOperationError({ error_code, retryable, details });
    const expected = { error, error_code, stage, retryable, summary, details };
    assert.deepEqual(thrown.public, expected, error_code);
    assert.deepEqual(toResearchError("kg_compare", thrown), expected, error_code);
    assert.deepEqual(JSON.parse(JSON.stringify(thrown)), expected, error_code);
  }
});

test("research error constructors derive every stage and summary from closed codes", () => {
  for (const [error, error_code, stage, retryable, summary, details] of contracts) {
    const thrown = new ResearchOperationError({ error_code, retryable, details, stage: "authorization", summary: "Context: /etc/passwd" });
    assert.deepEqual(thrown.public, { error, error_code, stage, retryable, summary, details }, error_code);
    assert.doesNotMatch(JSON.stringify(thrown.public), /Context|etc|passwd/i, error_code);
  }
});

test("research errors whitelist details through explicit safe fields", () => {
  const error = new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: {
      side: "left", truncated: false, candidates: [{ id: "company:acme", name: "Acme", type: "company", aliases: ["Acme Corp"], match_reason: "name_exact", score: .99 }],
      provider_body: "SECRET_PROVIDER_BODY", source: "SECRET_SOURCE", prompt: "SECRET_PROMPT", path: "C:\\Users\\rick\\secret.db"
    }
  });
  assert.deepEqual(error.public, {
    error: "ambiguous_subject", error_code: "COMPARE_SUBJECT_AMBIGUOUS", stage: "subject_resolution", retryable: true,
    summary: "Multiple graph subjects matched.",
    details: { side: "left", candidates: [{ id: "company:acme", name: "Acme", type: "company", aliases: ["Acme Corp"], match_reason: "name_exact" }], truncated: false }
  });
});

test("research errors always redact arbitrary thrown values and sensitive text", () => {
  const circular = { provider: { body: "SECRET_PROVIDER_BODY" }, sql: "SELECT * FROM kg_nodes", url: "https://user:password@example.test/x", path: "C:\\Users\\rick\\secret.db", posix: "/home/rick/secret.db" };
  circular.self = circular;
  for (const value of [
    circular,
    new Error("SQLite failed: SELECT * FROM evidence at /private/SECRET.db"),
    "https://api:credential@example.test/provider body SECRET_PROVIDER_BODY",
    { stack: "SECRET_STACK", prompt: "SECRET_PROMPT", source: "SECRET_SOURCE", evidence: "SECRET_EVIDENCE" }
  ]) {
    const output = toResearchError("kg_query", value);
    assert.deepEqual(output, { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: "kg_query failed", details: {} });
    assert.doesNotMatch(JSON.stringify(output), /SECRET|SQLite|SELECT|credential|provider|source|evidence|prompt|[A-Za-z]:\\|\/(?:home|private)\//i);
  }
});

test("research errors enforce a compiled sixteen KiB ceiling with deterministic generic fallback", () => {
  const huge = new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", candidates: Array.from({ length: 5 }, (_, i) => ({ id: `company:${i}`, name: "x".repeat(4000), type: "company", aliases: ["y".repeat(1024)], match_reason: "name_exact" })), truncated: false }
  });
  const output = huge.public;
  assert.ok(Buffer.byteLength(JSON.stringify(output), "utf8") <= 16 * 1024);
  assert.deepEqual(output, { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "serialization", retryable: false, summary: "Research operation failed.", details: {} });
  assert.deepEqual(toResearchError("kg_compare", huge), output);
});

test("toResearchError is total for hostile thrown values", () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = [
    new Proxy({}, { get() { throw new Error("getter trap"); } }),
    new Proxy({}, { getPrototypeOf() { throw new Error("prototype trap"); } }),
    new Proxy({}, { ownKeys() { throw new Error("keys trap"); } }),
    revoked.proxy,
    { toJSON() { throw new Error("toJSON trap"); } }
  ];
  const circular = {}; circular.self = circular;
  hostile.push(circular);
  for (const value of hostile) {
    assert.doesNotThrow(() => toResearchError("kg_query", value));
    assert.deepEqual(toResearchError("kg_query", value), { error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false, summary: "kg_query failed", details: {} });
  }
});

test("toResearchError uses a closed operation-name lookup for arbitrary values", () => {
  const coercionTrap = new Proxy({}, {
    get() { throw new Error("coercion getter trap"); },
    getPrototypeOf() { throw new Error("coercion prototype trap"); }
  });
  for (const operation of ["__proto__", "constructor", "toString", "hasOwnProperty", Symbol("kg_query"), coercionTrap, null, 42]) {
    let output;
    assert.doesNotThrow(() => { output = toResearchError(operation, new Error("SECRET provider body")); });
    assert.deepEqual(output, {
      error: "operation_failed", error_code: "RESEARCH_OPERATION_FAILED", stage: "execution", retryable: false,
      summary: "Research operation failed.", details: {}
    });
    assert.equal(typeof output.summary, "string");
  }
});

test("research error output is deeply immutable after construction and serialization", () => {
  const error = new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", truncated: false, candidates: [{ id: "company:acme", name: "Acme", type: "company", aliases: ["Acme Corp"], match_reason: "name_exact" }] }
  });
  const expected = JSON.parse(JSON.stringify(error));
  assert.equal(Object.isFrozen(error), true);
  assert.equal(Object.isFrozen(error.public), true);
  assert.equal(Object.isFrozen(error.public.details), true);
  assert.equal(Object.isFrozen(error.public.details.candidates), true);
  assert.equal(Object.isFrozen(error.public.details.candidates[0]), true);
  assert.equal(Object.isFrozen(error.public.details.candidates[0].aliases), true);
  assert.throws(() => { error.public.summary = "x"; }, TypeError);
  assert.throws(() => { error.public.details.candidates.push({}); }, TypeError);
  assert.throws(() => { error.public.details.candidates[0].aliases.push("x"); }, TypeError);
  assert.deepEqual(error.public, expected);
  assert.deepEqual(error.toJSON(), expected);
  assert.deepEqual(toResearchError("kg_compare", error), expected);
});

test("research errors redact unsafe graph labels without dropping ordinary labels", () => {
  const prohibited = [
    "\\\\server\\share\\secret.txt", "//server/share/secret.txt", "/opt/private/secret.txt", "C:\\Users\\rick\\secret.txt", "D:/private/secret.txt",
    "https://api:password@example.test/path", "provider_body: SECRET", "<prompt>SECRET</prompt>", "evidence: SECRET"
  ];
  const make = (name, aliases) => new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", truncated: false, candidates: [{ id: "company:acme", name, type: "company", aliases, match_reason: "name_exact" }] }
  });
  for (const text of prohibited) {
    const unsafeName = make(text, ["Ordinary Alias"]);
    assert.deepEqual(unsafeName.public.details.candidates, [], text);
    const unsafeAlias = make("Ordinary Evidence Systems", [text, "Ordinary Alias"]);
    assert.deepEqual(unsafeAlias.public.details.candidates, [{ id: "company:acme", name: "Ordinary Evidence Systems", type: "company", aliases: ["Ordinary Alias"], match_reason: "name_exact" }], text);
  }
  const ordinary = make("Ordinary Evidence Systems", ["Ordinary Source Group"]);
  assert.deepEqual(ordinary.public.details.candidates, [{ id: "company:acme", name: "Ordinary Evidence Systems", type: "company", aliases: ["Ordinary Source Group"], match_reason: "name_exact" }]);
});

test("research errors reject every absolute path", () => {
  const candidate = (label) => new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", truncated: false, candidates: [{ id: "company:acme", name: label, type: "company", aliases: [label], match_reason: "name_exact" }] }
  }).public.details.candidates;
  const rejected = [
    "/", "/tmp", "/etc", "/tmp/", "/var/lib/mnemora/graph.db", "\\\\server\\share\\graph.db", "C:\\graph.db", "D:/graph.db"
  ];
  for (const label of rejected) assert.deepEqual(candidate(label), [], label);
  for (const label of ["Acme Research", "Acme Research Group", "Research Examples", "Evidence Partners"]) {
    assert.deepEqual(candidate(label), [{ id: "company:acme", name: label, type: "company", aliases: [label], match_reason: "name_exact" }], label);
  }
});

test("research errors use a closed display-label policy for names and aliases", () => {
  const details = (name, aliases) => new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", truncated: false, candidates: [{ id: "company:acme", name, type: "company", aliases, match_reason: "name_exact" }] }
  }).public.details;
  const unsafe = [
    "Context: /etc/passwd", "Location /tmp/secret.txt", "notes\\private\\graph.db", "https://example.test/research", "user:password@example.test",
    "line\nbreak", "tab\tvalue", "nul\u0000value"
  ];
  for (const label of unsafe) {
    assert.deepEqual(details(label, ["Safe Alias"]).candidates, [], `name: ${label}`);
    assert.deepEqual(details("Safe Entity", [label, "Safe Alias"]).candidates, [{ id: "company:acme", name: "Safe Entity", type: "company", aliases: ["Safe Alias"], match_reason: "name_exact" }], `alias: ${label}`);
  }
  const displayed = (label) => /\b(?:select|update)\b/i.test(label) ? "[redacted]" : label;
  for (const label of ["Select Medical", "Update Partners", "Acme (R&D), Inc.", "研究・開発株式会社", "Crème Brûlée — Labs", "Company: Alpha-Beta"]) {
    assert.deepEqual(details(label, [label]).candidates, [{ id: "company:acme", name: displayed(label), type: "company", aliases: [displayed(label)], match_reason: "name_exact" }], label);
  }
});

test("research errors redact every SQLite command token in graph labels", () => {
  const details = (name, aliases) => new ResearchOperationError({
    error_code: "COMPARE_SUBJECT_AMBIGUOUS", retryable: true,
    details: { side: "left", truncated: false, candidates: [{ id: "company:acme", name, type: "company", aliases, match_reason: "name_exact" }] }
  }).public.details;
  for (const label of [
    "SELECT identifier", "INSERT :parameter", "REPLACE record", "UPDATE customer", "DELETE record", "DROP index", "ALTER schema", "CREATE table",
    "PRAGMA", "ATTACH database", "DETACH database", "WITH context", "VACUUM report", "BEGIN wellness", "COMMIT report", "END note",
    "ROLLBACK plan", "SAVEPOINT marker", "RELEASE marker", "EXPLAIN result", "ANALYZE data", "REINDEX data",
    "  seLeCt identifier", "/* reviewed */ SELECT identifier", "-- audit\nPRAGMA :parameter"
  ]) {
    assert.deepEqual(details(label, [label, "Safe Alias"]).candidates, [{ id: "company:acme", name: "[redacted]", type: "company", aliases: ["[redacted]", "Safe Alias"], match_reason: "name_exact" }], label);
  }
  for (const label of ["Acme Medical", "Evidence Partners", "Explainable AI", "Research Partners"]) {
    assert.deepEqual(details(label, [label]).candidates, [{ id: "company:acme", name: label, type: "company", aliases: [label], match_reason: "name_exact" }], label);
  }
});
