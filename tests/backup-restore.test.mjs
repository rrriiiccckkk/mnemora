import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "@photostructure/sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GraphologyStore } from "../dist/index.js";
import { BackupService, consistentBackup } from "../dist/operations/backup.js";
import { ArtifactRegistry } from "../dist/operations/artifacts.js";
import { RestoreService } from "../dist/operations/restore.js";

test("backup is preview-first, verified, opaque, and does not expose configured paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-backup-secret-"));
  const store = new GraphologyStore(":memory:");
  try {
    const registry = new ArtifactRegistry(directory);
    const service = new BackupService({ store, registry, now: () => 1_700_000_000_000, randomBytes: () => Buffer.alloc(32, 9) });
    const preview = service.preview({ operation: "backup", phase: "preview", graph_revision: store.graphRevision(), payload: {} });
    assert.equal(preview.operation, "backup"); assert.match(preview.payload_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(preview).includes(directory), false);
    const result = await service.confirm({ operation: "backup", phase: "confirm", graph_revision: preview.graph_revision, preview_token: preview.preview_token, payload_hash: preview.payload_hash, payload: {} });
    assert.equal(result.confirmed, true); assert.match(result.artifact.artifact_id, /^artifact:/);
    assert.equal(JSON.stringify(result).includes(directory), false);
    const metadata = registry.resolve(result.artifact.artifact_id);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/); assert.equal(metadata.integrity, "ok");
    const portable = JSON.parse(readFileSync(metadata.path.replace(/\.sqlite$/, ".manifest.json"), "utf8"));
    assert.equal(portable.format, "mnemora-portable-backup/v1"); assert.equal(portable.database_sha256, metadata.sha256);
    await assert.rejects(() => service.confirm({ operation: "backup", phase: "confirm", graph_revision: preview.graph_revision, preview_token: preview.preview_token, payload_hash: preview.payload_hash, payload: {} }), /invalid_preview/);
  } finally { store.close(); await cleanup(directory); }
});

test("stale graph revisions reject backup confirmation without creating an artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-backup-stale-")); const store = new GraphologyStore(":memory:");
  try {
    const registry = new ArtifactRegistry(directory), service = new BackupService({ store, registry, randomBytes: () => Buffer.alloc(32, 10) });
    const preview = service.preview({ operation: "backup", phase: "preview", graph_revision: store.graphRevision(), payload: {} });
    store.bumpGraphRevision();
    await assert.rejects(() => service.confirm({ operation: "backup", phase: "confirm", graph_revision: preview.graph_revision, preview_token: preview.preview_token, payload_hash: preview.payload_hash, payload: {} }), /stale_preview/);
    assert.equal(registry.list().length, 0);
  } finally { store.close(); await cleanup(directory); }
});

async function cleanup(directory) {
  await delay(100);
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (error) { if (process.platform !== "win32" || error?.code !== "EPERM") throw error; }
}

test("restore verifies the artifact, creates a recovery point, and replaces a file database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-restore-")), dbPath = join(directory, "active.sqlite"), artifacts = join(directory, "artifacts");
  const store = new GraphologyStore(dbPath);
  try {
    const now = 1_700_000_000_000, registry = new ArtifactRegistry(artifacts), randomBytes = () => Buffer.alloc(32, 11);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:before','company','Before','','[]',0,?,?)").run(now, now); store.bumpGraphRevision();
    const backups = new BackupService({ store, registry, now: () => now, randomBytes });
    const bp = backups.preview({ operation: "backup", phase: "preview", graph_revision: store.graphRevision(), payload: {} });
    const backupResult = await backups.confirm({ operation: "backup", phase: "confirm", graph_revision: bp.graph_revision, preview_token: bp.preview_token, payload_hash: bp.payload_hash, payload: {} });
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:after','company','After','','[]',0,?,?)").run(now, now); store.bumpGraphRevision();
    const restores = new RestoreService({ store, registry, now: () => now, randomBytes });
    const preview = restores.preview({ operation: "restore", phase: "preview", graph_revision: store.graphRevision(), payload: { artifact_id: backupResult.artifact.artifact_id } });
    const result = await restores.confirm({ operation: "restore", phase: "confirm", graph_revision: preview.graph_revision, preview_token: preview.preview_token, payload_hash: preview.payload_hash, payload: { artifact_id: backupResult.artifact.artifact_id } });
    assert.equal(result.confirmed, true); assert.match(result.recovery_point.artifact_id, /^artifact:/); assert.equal(JSON.stringify(result).includes(directory), false);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE id='company:after'").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE id='company:before'").get().n, 1);
  } finally { store.close(); await cleanup(directory); }
});

test("restore failure rolls back without changing the active graph", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-restore-rollback-")), dbPath = join(directory, "active.sqlite"), artifacts = join(directory, "artifacts");
  const store = new GraphologyStore(dbPath);
  try {
    const now = 1_700_000_000_000, registry = new ArtifactRegistry(artifacts);
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:safe','company','Safe','','[]',0,?,?)").run(now, now); store.bumpGraphRevision();
    const broken = join(artifacts, ".broken.sqlite"), db = new DatabaseSync(broken); db.exec("CREATE TABLE kg_graph_state(key TEXT PRIMARY KEY,value INTEGER NOT NULL,updated_at INTEGER NOT NULL); PRAGMA user_version=10"); db.close();
    const checksum = createHash("sha256").update(readFileSync(broken)).digest("hex"); registry.register({ artifact_id: "artifact:broken", kind: "backup", path: broken, sha256: checksum, integrity: "ok", graph_revision: 0, created_at: now });
    const service = new RestoreService({ store, registry, now: () => now, randomBytes: () => Buffer.alloc(32, 12) });
    const preview = service.preview({ operation: "restore", phase: "preview", graph_revision: store.graphRevision(), payload: { artifact_id: "artifact:broken" } });
    await assert.rejects(() => service.confirm({ operation: "restore", phase: "confirm", graph_revision: preview.graph_revision, preview_token: preview.preview_token, payload_hash: preview.payload_hash, payload: { artifact_id: "artifact:broken" } }), /restore_failed/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE id='company:safe'").get().n, 1);
  } finally { store.close(); await cleanup(directory); }
});

test("artifact registry survives restart and reports missing recovery files without exposing paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-artifact-health-")), artifactPath = join(directory, ".persist.sqlite");
  try {
    writeFileSync(artifactPath, "fixture");
    const registry = new ArtifactRegistry(directory);
    registry.register({ artifact_id: "artifact:persist", kind: "backup", path: artifactPath, sha256: "a".repeat(64), integrity: "ok", graph_revision: 4, created_at: 1_700_000_000_000 });
    assert.deepEqual(registry.health(), { status: "healthy", artifacts: { backups: 1, recovery_points: 0, available: 1, missing: 0 }, latest_created_at: 1_700_000_000_000 });
    assert.equal(readFileSync(join(directory, ".mnemora-artifacts.json"), "utf8").includes(directory), false);
    const restarted = new ArtifactRegistry(directory, { create: false });
    assert.equal(restarted.resolve("artifact:persist").sha256, "a".repeat(64));
    unlinkSync(artifactPath);
    assert.deepEqual(restarted.health(), { status: "degraded", artifacts: { backups: 1, recovery_points: 0, available: 0, missing: 1 }, latest_created_at: 1_700_000_000_000 });
  } finally { await cleanup(directory); }
});

test("artifact registry rejects a new entry at capacity while preserving every existing registration across restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-artifact-capacity-")), artifactPath = join(directory, ".persist.sqlite");
  try {
    writeFileSync(artifactPath, "fixture");
    const registry = new ArtifactRegistry(directory);
    for (let index = 0; index < 1000; index++) registry.register({ artifact_id: `artifact:${index}`, kind: "backup", path: artifactPath, sha256: "a".repeat(64), integrity: "ok", graph_revision: index, created_at: index });
    assert.throws(() => registry.register({ artifact_id: "artifact:overflow", kind: "backup", path: artifactPath, sha256: "a".repeat(64), integrity: "ok", graph_revision: 1000, created_at: 1000 }), /artifact_registry_full/);
    const restarted = new ArtifactRegistry(directory, { create: false });
    assert.equal(restarted.list().length, 1000);
    assert.equal(restarted.resolve("artifact:999").graph_revision, 999);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a valid legacy artifact manifest above the admission cap remains recoverable after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-artifact-legacy-")), artifactPath = join(directory, ".persist.sqlite");
  try {
    writeFileSync(artifactPath, "fixture");
    const artifacts = Array.from({ length: 1001 }, (_, index) => ({ artifact_id: `artifact:${index}`, kind: "backup", file: ".persist.sqlite", sha256: "a".repeat(64), graph_revision: index, created_at: index }));
    writeFileSync(join(directory, ".mnemora-artifacts.json"), JSON.stringify({ version: 1, artifacts }));
    const restarted = new ArtifactRegistry(directory, { create: false });
    assert.equal(restarted.list().length, 1001);
    assert.equal(restarted.resolve("artifact:1000").graph_revision, 1000);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an unreadable artifact manifest remains visible as a bounded registry failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-artifact-invalid-"));
  try {
    writeFileSync(join(directory, ".mnemora-artifacts.json"), "not json");
    const registry = new ArtifactRegistry(directory, { create: false });
    assert.deepEqual(registry.health(), { status: "degraded", artifacts: { backups: 0, recovery_points: 0, available: 0, missing: 0 }, latest_created_at: null, load_error: "manifest_invalid" });
    assert.throws(() => registry.list(), /artifact_registry_unavailable/);
    assert.throws(() => registry.resolve("artifact:missing"), /artifact_registry_unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("restore accepts a v1.0 observation schema and maps restored evidence to default scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-restore-v10-")), active = join(directory, "active.sqlite"), legacy = join(directory, "legacy.sqlite");
  const store = new GraphologyStore(active);
  try {
    const now = 1_700_000_000_000;
    store.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES('company:legacy','company','Legacy','','[]',0,?,?)").run(now, now);
    store.db.prepare("INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,scope,quote,confidence,created_at) VALUES('obs:legacy',NULL,'company:legacy','{}','fixture:legacy','project:old','quote',.9,?)").run(now);
    consistentBackup(store.db, legacy);
    const db = new DatabaseSync(legacy);
    try {
      db.exec(`DROP TABLE kg_memory_documents_fts; DROP TABLE kg_memory_documents; DROP TABLE kg_scopes;
        ALTER TABLE kg_observations RENAME TO kg_observations_v11;
        CREATE TABLE kg_observations (id TEXT PRIMARY KEY,edge_id TEXT,source_entity_id TEXT,payload TEXT NOT NULL DEFAULT '{}',source TEXT NOT NULL,quote TEXT NOT NULL,confidence REAL NOT NULL,valid_from INTEGER,valid_to INTEGER,temporal_confidence REAL,created_at INTEGER NOT NULL);
        INSERT INTO kg_observations(id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at) SELECT id,edge_id,source_entity_id,payload,source,quote,confidence,valid_from,valid_to,temporal_confidence,created_at FROM kg_observations_v11;
        DROP TABLE kg_observations_v11; PRAGMA user_version=10`);
    } finally { db.close(); }
    store.replaceDatabaseFrom(legacy);
    assert.equal(store.db.prepare("SELECT scope FROM kg_observations WHERE id='obs:legacy'").get().scope, "default");
    assert.deepEqual(store.listScopes().map(item => item.id), ["default"]);
  } finally { store.close(); await cleanup(directory); }
});
