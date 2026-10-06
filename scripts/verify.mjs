import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
if (!["fast", "full"].includes(mode)) throw new Error("Usage: node scripts/verify.mjs fast|full [test filenames]");
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
run(["node_modules/typescript/bin/tsc", "-p", "tsconfig.inspector.json", "--noEmit"]);
run(["scripts/ensure-cli-executable.mjs"]);
run(["scripts/build-inspector.mjs"]);
const selected = process.argv.slice(3);
if (mode === "full" && selected.length) throw new Error("Full verification does not accept a test filter");
run(["scripts/run-unit-tests.mjs", ...(mode === "fast" ? (selected.length ? selected : ["plugin.test.mjs", "context-engine.test.mjs", "official-plugin-gate.test.mjs"]) : [])]);
const benchmarks = ["hybrid-recall", "quality-ranking", "insights", "query", "inspector", "memory-lifecycle", "ingestion", "personal-memory-harness", "recall-quality", "cognition-graduation", "reasoning-runtime", "reasoning-delivery-effectiveness", "single-memory-harness-graduation"];
if (mode === "full") {
  for (const name of benchmarks) run([`scripts/benchmark-${name}.mjs`]);
  run(["scripts/run-unit-tests.mjs", "tests/task-resume-evaluation.test.mjs", "tests/task-resume-comparison.test.mjs", "tests/task-resume-preregistration.test.mjs"]);
}
for (const name of ["validate-plugin", "smoke-test", ...(mode === "full" ? ["official-plugin-gate", "validate-release-version"] : [])]) run([`scripts/${name}.mjs`]);
console.log(`verify:${mode} passed (one build)`);
