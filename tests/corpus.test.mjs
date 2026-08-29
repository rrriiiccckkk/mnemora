import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mnemora, GraphologyStore, SUPPORTED_SCHEMA_VERSION, parseMnemoraContextRef } from "../dist/index.js";

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-corpus-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  mkdirSync(join(root, "sessions", "research"), { recursive: true });
  mkdirSync(join(root, "dreaming"), { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "# Canonical memory\nThe first source is grounded.\n");
  writeFileSync(join(root, "memory", "guide.md"), "Use CITATION-NEEDLE for source-citable testing.\nKeep graph and corpus separate.\n");
  writeFileSync(join(root, "memory", "USER.md"), "This must not become a corpus fact.\n");
  writeFileSync(join(root, "sessions", "research", "latest.jsonl"), "{\"content\":\"SESSION-NEEDLE\"}\n");
  writeFileSync(join(root, "dreaming", "reflection.md"), "DREAM-NEEDLE\n");
  return root;
}

test("canonical corpus is bounded, source-citable, and isolated from graph memory", async () => {
  const root = fixture();
  const graph = new Mnemora({ config: { dbPath: ":memory:", scope: { default: "project:corpus" }, corpus: { enabled: true, workspaceRoot: root, includeSessions: true, includeDreamingArtifacts: true }, workspaceBoundary: { userMdExclusive: { enabled: true } } } });
  try {
    const synced = await graph.kg_memory({ operation: "corpus_sync" });
    assert.equal(synced.status, "ready");
    assert.equal(synced.indexed, 4);
    assert.equal(synced.skipped >= 1, true);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_nodes").get().n, 0);
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_memory_documents").get().n, 0);
    const found = await graph.kg_memory({ operation: "corpus_search", query: "CITATION-NEEDLE", sync: false });
    assert.equal(found.status, "ready");
    assert.equal(found.results.length, 1);
    assert.deepEqual(found.results[0].citation, "memory/guide.md:L1-L2");
    assert.equal(found.results[0].source, "canonical_corpus:memory");
    assert.equal(found.results[0].path.includes(root), false);
    assert.deepEqual(parseMnemoraContextRef(found.results[0].context_ref).kind, "corpus-chunk");
    const user = await graph.kg_memory({ operation: "corpus_search", query: "must not become", sync: false });
    assert.equal(user.results.length, 0);
    writeFileSync(join(root, "memory", "guide.md"), "UPDATED-NEEDLE is a changed canonical source.\n");
    const refreshed = await graph.kg_memory({ operation: "corpus_sync" });
    assert.equal(refreshed.indexed, 1);
    const old = await graph.kg_memory({ operation: "corpus_search", query: "CITATION-NEEDLE", sync: false });
    const changed = await graph.kg_memory({ operation: "corpus_search", query: "UPDATED-NEEDLE", sync: false });
    assert.equal(old.results.length, 0);
    assert.equal(changed.results[0].citation, "memory/guide.md:L1-L1");
  } finally { graph.close(); rmSync(root, { recursive: true, force: true }); }
});

test("corpus citations preserve the physical start line at a maxChunkLines boundary", async () => {
  const root = fixture();
  writeFileSync(join(root, "memory", "line-map.md"), "LINE_ONE\nLINE_TWO\nLINE_THREE\nLINE_FOUR\n");
  const graph = new Mnemora({ config: { dbPath: ":memory:", corpus: { enabled: true, workspaceRoot: root, maxChunkChars: 100, maxChunkLines: 2 }, workspaceBoundary: { userMdExclusive: { enabled: true } } } });
  try {
    await graph.kg_memory({ operation: "corpus_sync" });
    const found = await graph.kg_memory({ operation: "corpus_search", query: "LINE_THREE", sync: false });
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].citation, "memory/line-map.md:L3-L4");
  } finally { graph.close(); rmSync(root, { recursive: true, force: true }); }
});

test("corpus defaults to disabled and USER.md ingestion remains an explicit boundary", async () => {
  const root = fixture();
  const graph = new Mnemora({ config: { dbPath: ":memory:", workspaceBoundary: { userMdExclusive: { enabled: true } } } });
  try {
    assert.deepEqual(graph.kg_memory({ operation: "corpus_status" }).status, "disabled");
    const result = await graph.kg_ingest_file(join(root, "memory", "USER.md"));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.category, "workspace_boundary");
    assert.equal(graph.store.db.prepare("SELECT COUNT(*) AS n FROM kg_observations").get().n, 0);
  } finally { graph.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disabling an optional corpus source removes its prior cache on explicit sync", async () => {
  const root = fixture(), dbPath = join(root, "memory.sqlite");
  let graph = new Mnemora({ config: { dbPath, corpus: { enabled: true, workspaceRoot: root, includeSessions: true } } });
  try {
    await graph.kg_memory({ operation: "corpus_sync" });
    assert.equal((await graph.kg_memory({ operation: "corpus_search", query: "SESSION-NEEDLE", sync: false })).results.length, 1);
  } finally { graph.close(); }
  graph = new Mnemora({ config: { dbPath, corpus: { enabled: true, workspaceRoot: root, includeSessions: false } } });
  try {
    await graph.kg_memory({ operation: "corpus_sync" });
    assert.equal((await graph.kg_memory({ operation: "corpus_search", query: "SESSION-NEEDLE", sync: false })).results.length, 0);
  } finally { graph.close(); try { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {} }
});

test("v60 corpus migration is additive over a v59 database", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-corpus-migration-"));
  const path = join(directory, "memory.sqlite");
  let legacy;
  try {
    legacy = new GraphologyStore(path);
    legacy.db.prepare("INSERT INTO kg_nodes(id,type,name,description,aliases,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("concept:kept", "concept", "Kept", "", "[]", 0, 1, 1);
    legacy.db.exec("DROP TABLE mnemora_corpus_chunks_fts; DROP TABLE mnemora_corpus_chunks; DROP TABLE mnemora_corpus_documents; PRAGMA user_version=59");
    legacy.close(); legacy = undefined;
    const migrated = new GraphologyStore(path);
    try {
      assert.equal(SUPPORTED_SCHEMA_VERSION, 70);
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 70);
      assert.equal(migrated.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mnemora_corpus_documents'").get().name, "mnemora_corpus_documents");
      assert.equal(migrated.db.prepare("SELECT name FROM kg_nodes WHERE id='concept:kept'").get().name, "Kept");
      assert.equal(migrated.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { migrated.close(); }
  } finally { legacy?.close(); try { rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {} }
});

test("current-schema startup repairs a missing derived corpus FTS table without changing corpus chunks", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-corpus-fts-repair-")), path = join(directory, "memory.sqlite");
  let store;
  try {
    store = new GraphologyStore(path);
    store.db.prepare("INSERT INTO mnemora_corpus_documents(id,scope,logical_path,source_kind,content_hash,byte_length,line_count,last_synced_at) VALUES(?,?,?,?,?,?,?,?)").run("corpus:repair", "default", "memory/repair.md", "memory", "a".repeat(64), 10, 1, 1);
    store.db.prepare("INSERT INTO mnemora_corpus_chunks(id,document_id,scope,start_line,end_line,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run("corpus:repair:chunk", "corpus:repair", "default", 1, 1, "REPAIR-NEEDLE", "b".repeat(64), 1);
    store.db.exec("DROP TABLE mnemora_corpus_chunks_fts");
    store.close(); store = new GraphologyStore(path);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM pragma_table_list WHERE name=?").get("mnemora_corpus_chunks_fts").value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_corpus_chunks_fts WHERE mnemora_corpus_chunks_fts MATCH 'REPAIR'").get().value, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM mnemora_corpus_chunks WHERE id=?").get("corpus:repair:chunk").value, 1);
  } finally { try { store?.close(); } catch {} try { rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {} }
});

test("restore rebuilds the corpus FTS cache from restored canonical chunks", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp", "mnemora-corpus-restore-"));
  const sourcePath = join(directory, "source.sqlite"), targetPath = join(directory, "target.sqlite");
  const source = new GraphologyStore(sourcePath), target = new GraphologyStore(targetPath);
  try {
    const insert = store => {
      store.db.prepare("INSERT OR IGNORE INTO kg_scopes(id,created_at,updated_at) VALUES('default',1,1)").run();
      store.db.prepare("INSERT INTO mnemora_corpus_documents(id,scope,logical_path,source_kind,content_hash,byte_length,line_count,last_synced_at) VALUES(?,?,?,?,?,?,?,?)").run("corpus:doc", "default", "memory/kept.md", "memory", "a".repeat(64), 9, 1, 1);
      store.db.prepare("INSERT INTO mnemora_corpus_chunks(id,document_id,scope,start_line,end_line,content,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)").run("corpus:chunk", "corpus:doc", "default", 1, 1, "KEPT-FTS", "b".repeat(64), 1);
      store.db.prepare("INSERT INTO mnemora_corpus_chunks_fts(id,content) VALUES(?,?)").run("corpus:chunk", "KEPT-FTS");
    };
    insert(source);
    target.db.prepare("INSERT INTO mnemora_corpus_chunks_fts(id,content) VALUES(?,?)").run("stale", "STALE-FTS");
    target.replaceDatabaseFrom(sourcePath);
    assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM mnemora_corpus_chunks_fts WHERE mnemora_corpus_chunks_fts MATCH 'KEPT'").get().n, 1);
    assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM mnemora_corpus_chunks_fts WHERE mnemora_corpus_chunks_fts MATCH 'STALE'").get().n, 0);
  } finally { source.close(); target.close(); try { rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {} }
});
