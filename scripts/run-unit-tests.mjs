import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runInTempProcess } from "../tests/helpers/temp.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const testDirectory = resolve(scriptDirectory, "../tests");

export async function runUnitTests(files = readdirSync(testDirectory).filter(name => name.endsWith(".test.mjs")).sort().map(name => resolve(testDirectory, name))) {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  // Native SQLite fixtures remain serial and deterministic on both platforms.
  const args = ["--test", "--test-concurrency=1"];
  if (major >= 24) args.push("--test-isolation=none");
  args.push(...files);
  try {
    return await runInTempProcess(args);
  } catch (error) {
    if (error.operationExitCode) error.testExitCode = error.operationExitCode;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runUnitTests(process.argv.length > 2 ? process.argv.slice(2).map(path => resolve(path)) : undefined); }
  catch (error) { console.error(error); process.exitCode = error.testExitCode ?? 1; }
}
