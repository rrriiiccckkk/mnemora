import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("memory lifecycle benchmark covers 10k, 50k, and 100k offline scales with observable output", () => {
  const source = readFileSync("scripts/benchmark-memory-lifecycle.mjs", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["benchmark:lifecycle"], "npm run build && node scripts/benchmark-memory-lifecycle.mjs");
  assert.match(pkg.scripts.verify, /benchmark:lifecycle/);
  assert.match(source, /SCALES\s*=\s*\[10_000,\s*50_000,\s*100_000\]/);
  for (const operation of ["reviewMemoryExpiry", "previewMemoryLifecycle", "confirmMemoryLifecycle", "quick_check"]) assert.match(source, new RegExp(operation));
  for (const field of ["fixture_insert_ms", "expiry_review_ms", "archive_confirm_ms", "recover_confirm_ms", "integrity"]) assert.match(source, new RegExp(field));
  assert.doesNotMatch(source, /fetch\s*\(|https?:\/\//i);
});
