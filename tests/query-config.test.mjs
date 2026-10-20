import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "../dist/index.js";

test("query configuration defaults are exact and clamp to public hard maxima", () => {
  assert.deepEqual(normalizeConfig({}).query, {
    maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000,
    maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576,
    auditRetentionDays: 30, maxWatches: 100, maxDigestWatches: 25,
    maxImportBytes: 10485760, maxImportRecords: 1000
  });
  assert.deepEqual(normalizeConfig({ query: Object.fromEntries([
    "maxSteps", "maxDepth", "maxResults", "maxNodes", "maxEdges", "timeoutMs",
    "maxResponseBytes", "auditRetentionDays", "maxWatches", "maxDigestWatches",
    "maxImportBytes", "maxImportRecords"
  ].map(key => [key, Number.MAX_SAFE_INTEGER])) }).query, {
    maxSteps: 8, maxDepth: 4, maxResults: 50, maxNodes: 10000,
    maxEdges: 50000, timeoutMs: 10000, maxResponseBytes: 1048576,
    auditRetentionDays: 3650, maxWatches: 100, maxDigestWatches: 25,
    maxImportBytes: 10485760, maxImportRecords: 1000
  });
});
