import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface ArtifactMetadata { artifact_id: string; kind: "backup" | "recovery"; path: string; sha256: string; integrity: "ok"; graph_revision: number; created_at: number; }
export interface ArtifactHealth {
  status: "healthy" | "degraded" | "unavailable";
  artifacts: { backups: number; recovery_points: number; available: number; missing: number };
  latest_created_at: number | null;
}

export class ArtifactRegistry {
  readonly directory: string;
  private readonly manifest: string;
  private readonly artifacts = new Map<string, ArtifactMetadata>();
  constructor(directory: string, options: { create?: boolean } = {}) {
    this.directory = resolve(directory); this.manifest = join(this.directory, ".mnemora-artifacts.json");
    if (options.create !== false) mkdirSync(this.directory, { recursive: true });
    this.load();
  }
  register(metadata: ArtifactMetadata): void {
    const path = resolve(metadata.path);
    if (!path.startsWith(this.directory + sep)) throw new Error("invalid_artifact");
    this.artifacts.set(metadata.artifact_id, { ...metadata, path });
    this.persist();
  }
  resolve(id: string): ArtifactMetadata { const value = this.artifacts.get(id); if (!value) throw new Error("artifact_not_found"); return { ...value }; }
  list(): ArtifactMetadata[] { return [...this.artifacts.values()].map(value => ({ ...value })); }
  health(): ArtifactHealth {
    if (!existsSync(this.directory)) return { status: "unavailable", artifacts: { backups: 0, recovery_points: 0, available: 0, missing: 0 }, latest_created_at: null };
    let backups = 0, recovery_points = 0, available = 0, missing = 0, latest_created_at: number | null = null;
    for (const artifact of this.artifacts.values()) {
      if (artifact.kind === "backup") backups++; else recovery_points++;
      if (latest_created_at == null || artifact.created_at > latest_created_at) latest_created_at = artifact.created_at;
      try { if (statSync(artifact.path).size > 0) available++; else missing++; } catch { missing++; }
    }
    return { status: missing ? "degraded" : "healthy", artifacts: { backups, recovery_points, available, missing }, latest_created_at };
  }

  private load(): void {
    if (!existsSync(this.manifest)) return;
    try {
      const bytes = readFileSync(this.manifest); if (bytes.byteLength > 1024 * 1024) return;
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!record(value) || value.version !== 1 || !Array.isArray(value.artifacts) || value.artifacts.length > 1000) return;
      for (const item of value.artifacts) {
        if (!record(item) || !validArtifact(item)) continue;
        const artifact = item as { artifact_id: string; kind: "backup" | "recovery"; file: string; sha256: string; graph_revision: number; created_at: number };
        const path = resolve(this.directory, artifact.file);
        if (!path.startsWith(this.directory + sep)) continue;
        this.artifacts.set(artifact.artifact_id, { artifact_id: artifact.artifact_id, kind: artifact.kind, path, sha256: artifact.sha256, integrity: "ok", graph_revision: artifact.graph_revision, created_at: artifact.created_at });
      }
    } catch { /* A corrupt local manifest must not block a read-only health check. */ }
  }
  private persist(): void {
    const artifacts = [...this.artifacts.values()].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)).map(item => ({ artifact_id: item.artifact_id, kind: item.kind, file: basename(item.path), sha256: item.sha256, graph_revision: item.graph_revision, created_at: item.created_at }));
    writeFileSync(this.manifest, JSON.stringify({ version: 1, artifacts }), { encoding: "utf8", mode: 0o600 });
  }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validArtifact(value: Record<string, unknown>): value is { artifact_id: string; kind: "backup" | "recovery"; file: string; sha256: string; graph_revision: number; created_at: number } {
  const graphRevision = value.graph_revision, createdAt = value.created_at;
  return Object.keys(value).sort().join("\0") === ["artifact_id", "kind", "file", "sha256", "graph_revision", "created_at"].sort().join("\0")
    && typeof value.artifact_id === "string" && /^artifact:[A-Za-z0-9_-]{1,200}$/.test(value.artifact_id)
    && (value.kind === "backup" || value.kind === "recovery") && typeof value.file === "string" && /^\.[A-Za-z0-9_-]{1,200}\.sqlite$/.test(value.file)
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && typeof graphRevision === "number" && Number.isSafeInteger(graphRevision) && graphRevision >= 0
    && typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0;
}
