import type { DatabaseSyncInstance } from "@photostructure/sqlite";

export interface DatabaseRecoveryOptions {
  db: DatabaseSyncInstance;
  optionalNewTables: readonly string[];
  rebuildDerivedData(): void;
}

/**
 * Atomically copy a portable SQLite backup into an already-migrated database.
 * The caller supplies schema compatibility and derived-cache rebuilding so
 * this service never owns graph or memory mutation policy.
 */
export class DatabaseRecoveryService {
  constructor(private readonly options: DatabaseRecoveryOptions) {}

  replaceFrom(sourcePath: string): void {
    const { db } = this.options;
    const attached = "restore_source";
    db.prepare(`ATTACH DATABASE ? AS ${attached}`).run(sourcePath);
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      const sourceTables = new Set((db.prepare(`SELECT name FROM ${attached}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kg_nodes_fts%' AND name NOT LIKE 'kg_memory_documents_fts%' AND name NOT LIKE 'kg_memory_chunks_fts%' AND name NOT LIKE 'mnemora_corpus_chunks_fts%'`).all() as Array<{ name: string }>).map(row => row.name));
      const targetTables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kg_nodes_fts%' AND name NOT LIKE 'kg_memory_documents_fts%' AND name NOT LIKE 'kg_memory_chunks_fts%' AND name NOT LIKE 'mnemora_corpus_chunks_fts%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
      const optionalNewTables = new Set(this.options.optionalNewTables);
      if (targetTables.some(name => !optionalNewTables.has(name) && !sourceTables.has(name))) throw new Error("incompatible_schema");
      db.exec("BEGIN IMMEDIATE");
      for (const name of targetTables) {
        const quoted = quoteIdentifier(name);
        db.exec(`DELETE FROM main.${quoted}`);
        if (!sourceTables.has(name)) continue;
        const sourceColumns = new Set((db.prepare(`PRAGMA ${attached}.table_info(${quoted})`).all() as Array<{ name: string }>).map(row => row.name));
        const targetColumns = (db.prepare(`PRAGMA main.table_info(${quoted})`).all() as Array<{ name: string }>).map(row => row.name);
        const columns = targetColumns.filter(column => sourceColumns.has(column));
        if (!columns.length) throw new Error("incompatible_schema");
        const names = columns.map(quoteIdentifier).join(",");
        db.exec(`INSERT INTO main.${quoted}(${names}) SELECT ${names} FROM ${attached}.${quoted}`);
      }
      const now = Date.now();
      db.prepare("INSERT OR IGNORE INTO main.kg_scopes(id,created_at,updated_at) VALUES('default',?,?)").run(now, now);
      db.prepare("INSERT OR IGNORE INTO main.kg_scopes(id,created_at,updated_at) SELECT DISTINCT scope,?,? FROM main.kg_observations WHERE typeof(scope)='text' AND scope<>''").run(now, now);
      this.options.rebuildDerivedData();
      db.exec("DELETE FROM main.kg_nodes_fts; INSERT INTO main.kg_nodes_fts(id,name,description,aliases) SELECT id,name,description,aliases FROM main.kg_nodes WHERE deleted_at IS NULL");
      db.exec("DELETE FROM main.kg_memory_documents_fts; INSERT INTO main.kg_memory_documents_fts(id,title,content) SELECT id,title,content FROM main.kg_memory_documents");
      db.exec("DELETE FROM main.kg_memory_chunks_fts; INSERT INTO main.kg_memory_chunks_fts(id,content) SELECT id,content FROM main.kg_memory_chunks");
      db.exec("DELETE FROM main.mnemora_corpus_chunks_fts; INSERT INTO main.mnemora_corpus_chunks_fts(id,content) SELECT id,content FROM main.mnemora_corpus_chunks");
      db.exec("COMMIT");
    } catch {
      try { db.exec("ROLLBACK"); } catch { /* transaction may not have begun */ }
      throw new Error("restore_failed");
    } finally {
      try { db.exec(`DETACH DATABASE ${attached}`); }
      finally { db.exec("PRAGMA foreign_keys=ON"); }
    }
  }
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
