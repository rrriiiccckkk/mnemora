import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const testDirectory = resolve(scriptDirectory, "../tests");
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve(testDirectory, name));
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// Run files serially: the suite shares bounded native SQLite and child-process
// fixtures, and serial execution is deterministic on the two-core CI runners.
const args = ["--test", "--test-concurrency=1"];

// Node 24 introduced this opt-out. Node 22 remains a supported CI runtime.
if (major >= 24) args.push("--test-isolation=none");
args.push(...testFiles);

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
