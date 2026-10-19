// openclaw/plugin-sdk/memory-core-host-engine-embeddings ships without a
// declaration file; declare only what src/host-embeddings.ts uses, matching
// EmbeddingProviderAdapter in openclaw's plugin-entry types.
declare module "openclaw/plugin-sdk/memory-core-host-engine-embeddings" {
  export interface MemoryEmbeddingProviderAdapter {
    id: string;
    defaultModel?: string;
    transport?: "local" | "remote";
    create(options: unknown): Promise<{ provider: unknown | null; runtime?: unknown }>;
  }
  export function getMemoryEmbeddingProvider(id: string, cfg?: unknown): MemoryEmbeddingProviderAdapter | undefined;
}
