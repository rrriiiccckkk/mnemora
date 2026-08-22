import { DatabaseSync } from "@photostructure/sqlite";
import { statSync } from "node:fs";
import { SUPPORTED_SCHEMA_VERSION } from "../schema.js";

export { SUPPORTED_SCHEMA_VERSION };

export function inspectDatabaseCompatibility(path: string): { compatible: true; schema_version: number } {
  try {
    if (statSync(path).size <= 0) throw new Error();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (integrity.integrity_check !== "ok") throw new Error();
      const version = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
      if (!Number.isSafeInteger(version) || version < 0) throw new Error();
      if (version > SUPPORTED_SCHEMA_VERSION) throw new Error("unsupported_schema");
      const state = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='kg_graph_state'").get();
      if (!state) throw new Error();
      return { compatible: true, schema_version: version };
    } finally { db.close(); }
  } catch (error) { if (error instanceof Error && error.message === "unsupported_schema") throw error; throw new Error("invalid_artifact"); }
}
