import type { EmbeddingConfig } from "../index.js";
import type { GraphologyStore } from "../store.js";

export type EmbeddingFailureCategory = "timeout" | "provider" | "invalid_response" | "persistence" | "unknown";
export interface EmbeddingHealthStatus {
  configured: boolean;
  state: "disabled" | "unobserved" | "healthy" | "degraded";
  provider?: string;
  model?: string;
  last_success_at?: number;
  last_failure_at?: number;
  last_failure_category?: EmbeddingFailureCategory;
  fallback: { hybrid: "lexical_on_unavailable"; semantic: "bounded_error" };
}

interface StoredHealth {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureCategory?: EmbeddingFailureCategory;
}

const fallback = { hybrid: "lexical_on_unavailable", semantic: "bounded_error" } as const;

/**
 * Persist only local, categorical embedding outcomes. This deliberately does
 * not probe a provider, retain an endpoint, or store provider response text.
 */
export class EmbeddingHealthRepository {
  constructor(private readonly store: GraphologyStore, private readonly now: () => number = Date.now) {}

  recordSuccess(config: EmbeddingConfig): void {
    if (!config.enabled) return;
    const current = this.load(config);
    this.save(config, { ...current, lastSuccessAt: this.now() });
  }

  recordFailure(config: EmbeddingConfig, category: EmbeddingFailureCategory): void {
    if (!config.enabled) return;
    const current = this.load(config);
    this.save(config, { ...current, lastFailureAt: this.now(), lastFailureCategory: category });
  }

  status(config: EmbeddingConfig): EmbeddingHealthStatus {
    if (!config.enabled) return { configured: false, state: "disabled", fallback };
    const current = this.load(config), success = current.lastSuccessAt, failure = current.lastFailureAt;
    const state = failure != null && (success == null || failure >= success) ? "degraded" : success != null ? "healthy" : "unobserved";
    return {
      configured: true, state, provider: config.provider, model: config.model,
      ...(success == null ? {} : { last_success_at: success }),
      ...(failure == null ? {} : { last_failure_at: failure }),
      ...(current.lastFailureCategory == null ? {} : { last_failure_category: current.lastFailureCategory }),
      fallback
    };
  }

  private load(config: EmbeddingConfig): StoredHealth {
    const row = this.store.db.prepare("SELECT value FROM kg_maintenance_state WHERE key=?").get(key(config)) as { value?: string } | undefined;
    if (!row?.value) return {};
    try {
      const value = JSON.parse(row.value) as StoredHealth;
      return {
        ...(Number.isFinite(value.lastSuccessAt) ? { lastSuccessAt: Math.trunc(value.lastSuccessAt!) } : {}),
        ...(Number.isFinite(value.lastFailureAt) ? { lastFailureAt: Math.trunc(value.lastFailureAt!) } : {}),
        ...(value.lastFailureCategory && ["timeout", "provider", "invalid_response", "persistence", "unknown"].includes(value.lastFailureCategory) ? { lastFailureCategory: value.lastFailureCategory } : {})
      };
    } catch { return {}; }
  }

  private save(config: EmbeddingConfig, value: StoredHealth): void {
    const now = this.now();
    this.store.db.prepare("INSERT INTO kg_maintenance_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(key(config), JSON.stringify(value), now);
  }
}

const key = (config: EmbeddingConfig) => `embedding_health:${config.provider}:${config.model}`;
