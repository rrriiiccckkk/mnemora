import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { IntegrationStatusRecord, ProviderCapabilities } from "./types.js";

const health = new Set(["healthy", "degraded", "unavailable"]);
const warningCodes = new Set(["unavailable", "timeout", "cancelled", "output_too_large", "invalid_response", "not_found", "not_in_search_window", "operation_failed"]);
const providerId = /^[a-z][a-z0-9-]{0,79}$/;

/** Mnemora-owned metadata only: never stores provider output, paths, or source content. */
export class IntegrationStatusRepository {
  constructor(private readonly db: DatabaseSyncInstance) {}

  save(input: Omit<IntegrationStatusRecord, "last_probe_at"> & { last_probe_at?: number }): IntegrationStatusRecord {
    const normalized = normalize(input, input.last_probe_at ?? Date.now());
    this.db.prepare(`INSERT INTO kg_integration_status(provider,detected_version,capabilities_json,status,warning_code,last_probe_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET detected_version=excluded.detected_version,capabilities_json=excluded.capabilities_json,status=excluded.status,warning_code=excluded.warning_code,last_probe_at=excluded.last_probe_at`)
      .run(normalized.provider, normalized.detected_version, JSON.stringify(normalized.capabilities), normalized.status, normalized.warning_code, normalized.last_probe_at);
    return normalized;
  }

  get(provider: string): IntegrationStatusRecord | undefined {
    if (!providerId.test(provider)) return undefined;
    const row = this.db.prepare("SELECT provider,detected_version,capabilities_json,status,warning_code,last_probe_at FROM kg_integration_status WHERE provider=?").get(provider) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try { return normalize({ provider: String(row.provider), detected_version: nullableString(row.detected_version, 120), capabilities: JSON.parse(String(row.capabilities_json)), status: String(row.status), warning_code: nullableString(row.warning_code, 80) }, finiteTime(row.last_probe_at)); }
    catch { return undefined; }
  }

  list(): IntegrationStatusRecord[] {
    const rows = this.db.prepare("SELECT provider,detected_version,capabilities_json,status,warning_code,last_probe_at FROM kg_integration_status ORDER BY provider ASC").all() as Record<string, unknown>[];
    return rows.flatMap(row => {
      try { return [normalize({ provider: String(row.provider), detected_version: nullableString(row.detected_version, 120), capabilities: JSON.parse(String(row.capabilities_json)), status: String(row.status), warning_code: nullableString(row.warning_code, 80) }, finiteTime(row.last_probe_at))]; }
      catch { return []; }
    });
  }
}

function normalize(value: { provider: string; detected_version: string | null; capabilities: ProviderCapabilities; status: string; warning_code: string | null }, lastProbeAt: number): IntegrationStatusRecord {
  if (!providerId.test(value.provider) || !health.has(value.status)) throw new Error("invalid_integration_status");
  const capabilities = normalizeCapabilities(value.capabilities, value.provider);
  const warning = value.warning_code == null ? null : warningCodes.has(value.warning_code) ? value.warning_code as IntegrationStatusRecord["warning_code"] : null;
  return { provider: value.provider, detected_version: nullableString(value.detected_version, 120), capabilities, status: value.status as IntegrationStatusRecord["status"], warning_code: warning, last_probe_at: finiteTime(lastProbeAt) };
}
export function normalizeCapabilities(value: unknown, provider = "lossless-claw"): ProviderCapabilities {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const boolean = (key: keyof ProviderCapabilities) => row[key] === true;
  return {
    providerId: provider, ...(nullableString(row.detectedVersion, 120) ? { detectedVersion: nullableString(row.detectedVersion, 120)! } : {}),
    searchSources: boolean("searchSources"), resolveRawSource: boolean("resolveRawSource"), resolveSummaryLineage: boolean("resolveSummaryLineage"), stableExternalIds: boolean("stableExternalIds"), returnsContentHash: boolean("returnsContentHash"), returnsScores: boolean("returnsScores"), supportsAbortSignal: boolean("supportsAbortSignal")
  };
}
function nullableString(value: unknown, maximum: number): string | null { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : null; }
function finiteTime(value: unknown): number { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0; }
