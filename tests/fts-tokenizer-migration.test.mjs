import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "@photostructure/sqlite";
import { GraphologyStore, SUPPORTED_SCHEMA_VERSION } from "../dist/index.js";

const ftsTables = ["kg_nodes_fts", "kg_memory_documents_fts", "kg_memory_chunks_fts"];

function createLegacyFtsTables(db) {
  db.exec(`
    DROP TABLE kg_nodes_fts;
    DROP TABLE kg_memory_documents_fts;
    DROP TABLE kg_memory_chunks_fts;
    CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(id UNINDEXED,name,description,aliases,tokenize='unicode61');
    CREATE VIRTUAL TABLE kg_memory_documents_fts USING fts5(id UNINDEXED,title,content,tokenize='unicode61');
    CREATE VIRTUAL TABLE kg_memory_chunks_fts USING fts5(id UNINDEXED,content,tokenize='unicode61');
    INSERT INTO kg_nodes_fts(id,name,description,aliases)
      SELECT id,name,description,aliases FROM kg_nodes WHERE deleted_at IS NULL;
    INSERT INTO kg_memory_documents_fts(id,title,content)
      SELECT id,title,content FROM kg_memory_documents;
    INSERT INTO kg_memory_chunks_fts(id,content)
      SELECT id,content FROM kg_memory_chunks;
    PRAGMA user_version=18;
  `);
}

function removeTemporaryDirectory(directory) {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
}

test("v19 rebuilds legacy FTS indexes with trigram tokenization without losing Chinese content", () => {
  const directory = mkdtempSync(join(tmpdir(), "mnemora-fts-trigram-"));
  const path = join(directory, "kg.db");
  try {
    const initial = new GraphologyStore(path);
    initial.ingest([{ name: "先进封装技术", type: "technology", description: "用于中文检索的实体描述", aliases: [], confidence: .9, evidence_span: "先进封装技术" }], [], "fixture");
    initial.upsertMemoryDocument({ title: "中文知识图谱", content: "这是一条中文知识图谱记忆内容。", source: "fixture:memory" });
    initial.close();

    const legacy = new DatabaseSync(path);
    createLegacyFtsTables(legacy);
    assert.equal(legacy.prepare("SELECT count(*) AS n FROM kg_nodes_fts WHERE kg_nodes_fts MATCH ?").get("封装技").n, 0);
    legacy.close();

    const migrated = new GraphologyStore(path);
    try {
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, SUPPORTED_SCHEMA_VERSION);
      for (const table of ftsTables) {
        const row = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
        assert.match(row.sql, /tokenize\s*=\s*'trigram'/i, table);
      }
      assert.equal(migrated.db.prepare("SELECT count(*) AS n FROM kg_nodes_fts WHERE kg_nodes_fts MATCH ?").get("封装技").n, 1);
      assert.equal(migrated.db.prepare("SELECT count(*) AS n FROM kg_memory_documents_fts WHERE kg_memory_documents_fts MATCH ?").get("知识图").n, 1);
      assert.ok(migrated.db.prepare("SELECT count(*) AS n FROM kg_memory_chunks_fts WHERE kg_memory_chunks_fts MATCH ?").get("知识图").n >= 1);
    } finally { migrated.close(); }
  } finally { removeTemporaryDirectory(directory); }
});
