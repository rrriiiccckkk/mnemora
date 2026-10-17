import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function filesUnder(root, directory = root) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path);
    assert(!stat.isSymbolicLink(), "artifact_symlink_not_allowed");
    return stat.isDirectory() ? filesUnder(root, path) : [relative(root, path).replaceAll("\\", "/")];
  });
}
const canonicalJson = value => Array.isArray(value) ? value.map(canonicalJson) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])])) : value;
export function sourceFingerprint(root, format = "canonical-json-lock-v1") {
  const paths = [...filesUnder(join(root, "src")).map(p => `src/${p}`), "package.json", "package-lock.json", "openclaw.plugin.json", "tsconfig.json", "tsconfig.inspector.json", "scripts/build-package.mjs", ...(existsSync(join(root, "scripts/node-compat.mjs")) ? ["scripts/node-compat.mjs"] : []), "scripts/package-artifact.mjs", "scripts/build-inspector.mjs", "scripts/ensure-cli-executable.mjs"].sort();
  assert(["raw-v1", "canonical-json-lock-v1"].includes(format), "unsupported_source_fingerprint_format");
  return sha256(JSON.stringify(paths.map(path => {
    const bytes = readFileSync(join(root, path));
    return [path, sha256(path === "package-lock.json" && format === "canonical-json-lock-v1" ? JSON.stringify(canonicalJson(JSON.parse(bytes.toString("utf8")))) : bytes)];
  })));
}
export function runtimeMetadata(root) {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const runtime = readFileSync(join(root, "dist/version.js"), "utf8").match(/mnemoraVersion\s*=\s*"([^"]+)"/)[1];
  const schema = Number(readFileSync(join(root, "dist/schema.js"), "utf8").match(/SUPPORTED_SCHEMA_VERSION\s*=\s*(\d+)/)[1]);
  assert.equal(runtime, version, "artifact_runtime_version_mismatch");
  assert.equal(manifest.version, version, "artifact_plugin_version_mismatch");
  return { version, schema };
}
export function verifyDistribution(root, expectedFingerprint) {
  const metadata = runtimeMetadata(root);
  const manifest = JSON.parse(readFileSync(join(root, "dist/build-manifest.json"), "utf8"));
  assert.equal(manifest.format, "mnemora-build-v1");
  assert(manifest.sourceFingerprintFormat === undefined || manifest.sourceFingerprintFormat === "canonical-json-lock-v1", "unsupported_source_fingerprint_format");
  assert.equal(manifest.version, metadata.version);
  assert.equal(manifest.schema, metadata.schema);
  assert.equal(manifest.packageHash, sha256(readFileSync(join(root, "package.json"))), "artifact_package_metadata_mismatch");
  assert.equal(manifest.pluginManifestHash, sha256(readFileSync(join(root, "openclaw.plugin.json"))), "artifact_plugin_metadata_mismatch");
  assert.match(manifest.sourceFingerprint, /^[a-f0-9]{64}$/);
  if (expectedFingerprint) assert.equal(manifest.sourceFingerprint, expectedFingerprint, "artifact_source_fingerprint_mismatch");
  if (existsSync(join(root, "src/schema.ts"))) {
    assert.equal(manifest.sourceFingerprint, sourceFingerprint(root, manifest.sourceFingerprintFormat ?? "raw-v1"), "source_and_dist_mismatch");
    assert.equal(metadata.schema, Number(readFileSync(join(root, "src/schema.ts"), "utf8").match(/SUPPORTED_SCHEMA_VERSION\s*=\s*(\d+)/)[1]), "source_schema_mismatch");
  }
  const files = filesUnder(join(root, "dist")).filter(path => path !== "build-manifest.json");
  assert.deepEqual(files.sort(), Object.keys(manifest.files).sort(), "artifact_file_set_mismatch");
  for (const path of files) assert.equal(sha256(readFileSync(join(root, "dist", path))), manifest.files[path], `artifact_hash_mismatch:${path}`);
  for (const path of ["plugin.js", "schema.js", "version.js", "index.js", "cli.js", "inspector/index.html", "inspector/asset-manifest.json"]) assert(files.includes(path), `artifact_missing:${path}`);
  return { ...metadata, sourceFingerprint: manifest.sourceFingerprint, sourceCommit: manifest.sourceCommit ?? null, fileCount: files.length };
}

/** Snapshot keys must change when bytes change, even if package.version does not. */
export function distributionFingerprint(root) {
  const paths = ["package.json", "openclaw.plugin.json", ...["dist", "skills"].flatMap(directory => existsSync(join(root, directory)) ? filesUnder(join(root, directory)).map(path => `${directory}/${path}`) : [])].sort();
  return sha256(JSON.stringify(paths.map(path => [path, sha256(readFileSync(join(root, path)))])));
}
