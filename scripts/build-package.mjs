import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { filesUnder, runtimeMetadata, sha256, sourceFingerprint, verifyDistribution } from "./package-artifact.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Build requires Node 24");
// Only generated output in this checkout is removed; never reuse stale modules.
rmSync(join(root, "dist"), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
for (const args of [["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], ["node_modules/typescript/bin/tsc", "-p", "tsconfig.inspector.json", "--noEmit"], ["scripts/ensure-cli-executable.mjs"], ["scripts/build-inspector.mjs"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const metadata = runtimeMetadata(root);
const sourceSchema = Number(readFileSync(join(root, "src/schema.ts"), "utf8").match(/SUPPORTED_SCHEMA_VERSION\s*=\s*(\d+)/)[1]);
if (metadata.schema !== sourceSchema) throw new Error("source_schema_mismatch");
let sourceCommit = null;
try {
  const clean = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (clean && /^[a-f0-9]{40}$/.test(head)) sourceCommit = head;
} catch { /* source exports have no Git checkout */ }
const files = Object.fromEntries(filesUnder(join(root, "dist")).map(path => [path, sha256(readFileSync(join(root, "dist", path)))]));
writeFileSync(join(root, "dist/build-manifest.json"), JSON.stringify({ format: "mnemora-build-v1", ...metadata, sourceCommit, packageHash: sha256(readFileSync(join(root, "package.json"))), pluginManifestHash: sha256(readFileSync(join(root, "openclaw.plugin.json"))), sourceFingerprint: sourceFingerprint(root), files }, null, 2) + "\n");
console.log(JSON.stringify({ build: verifyDistribution(root) }));
