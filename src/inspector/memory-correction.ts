import { randomBytes as systemRandomBytes } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { MemoryImpactService, type MemoryImpactPreview } from "../correction/impact-service.js";
import { normalizeScope } from "../scope.js";

export type MemoryCorrectionKind = "event" | "artifact" | "episode" | "summary";
export interface MemoryCorrectionPreview {
  kind: "memory_correction";
  phase: "preview";
  preview_token: string;
  scope: string;
  target: { kind: MemoryCorrectionKind };
  affected: MemoryImpactPreview["counts"];
}
export interface MemoryCorrectionResult {
  kind: "memory_correction";
  phase: "confirm";
  forgotten: true;
  scope: string;
  target: { kind: MemoryCorrectionKind };
  affected: MemoryImpactPreview["counts"];
}

type PendingCorrection = {
  scope: string;
  kind: MemoryCorrectionKind;
  id: string;
  previewHash: string;
  expiresAt: number;
};

const kinds = new Set<MemoryCorrectionKind>(["event", "artifact", "episode", "summary"]);

/**
 * Turns the correction service's deterministic impact hash into a short-lived,
 * single-use Inspector confirmation. Callers receive only counts, never the
 * dependent IDs used to calculate the impact.
 */
export class InspectorMemoryCorrectionService {
  private readonly impact: MemoryImpactService;
  private readonly pending = new Map<string, PendingCorrection>();
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly ttlMs: number;

  constructor(options: { db: DatabaseSyncInstance; now?: () => number; randomBytes?: (size: number) => Buffer; ttlMs?: number }) {
    this.impact = new MemoryImpactService(options.db);
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? systemRandomBytes;
    this.ttlMs = Math.min(15 * 60_000, Math.max(30_000, Math.trunc(options.ttlMs ?? 5 * 60_000)));
  }

  preview(input: { scope?: string; kind: MemoryCorrectionKind; id: string }): MemoryCorrectionPreview {
    const scope = normalizeScope(input.scope, "default"), id = input.id.trim().slice(0, 512);
    if (!kinds.has(input.kind) || !id) throw new Error("invalid_memory_correction");
    const impact = this.impact.preview({ scope, kind: input.kind, id });
    this.removeExpired();
    const token = this.token();
    this.pending.set(token, { scope, kind: input.kind, id, previewHash: impact.previewHash, expiresAt: this.now() + this.ttlMs });
    return { kind: "memory_correction", phase: "preview", preview_token: token, scope, target: { kind: input.kind }, affected: impact.counts };
  }

  confirm(input: { preview_token: string }): MemoryCorrectionResult {
    this.removeExpired();
    const pending = this.pending.get(input.preview_token);
    this.pending.delete(input.preview_token);
    if (!pending) throw new Error("invalid_memory_correction_preview");
    const current = this.impact.preview(pending);
    if (current.previewHash !== pending.previewHash) throw new Error("stale_memory_correction_preview");
    const result = this.impact.forget({ ...pending, previewHash: pending.previewHash, confirm: true });
    return { kind: "memory_correction", phase: "confirm", forgotten: true, scope: result.scope, target: { kind: pending.kind }, affected: result.counts };
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(token);
  }

  private token(): string {
    const value = this.randomBytes(32);
    if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error("entropy_unavailable");
    return `memory-correction:${value.toString("base64url")}`;
  }
}
