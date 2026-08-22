import type { EmbeddingConfig } from "./index.js";
import type { KgNode } from "./types.js";
import { MEMORY_CHUNK_EMBEDDING_INPUT_VERSION } from "./memory.js";

export interface EmbeddingIdentity { provider: string; model: string; dimensions: number }
export interface EmbeddingResult { identity: EmbeddingIdentity; vectors: number[][] }
export interface Embedder { embed(inputs: string[], signal?: AbortSignal): Promise<EmbeddingResult> }

export const normalizeEmbeddingVector = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("invalid embedding vectors: expected finite, non-empty vectors");
  }
  const magnitude = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("invalid embedding vectors: zero magnitude");
  return value.map((item) => item / magnitude);
};

const normalizeVectors = (value: unknown, count: number): number[][] => {
  if (!Array.isArray(value) || value.length !== count || count === 0) {
    throw new Error("invalid embedding vectors: count mismatch");
  }
  const vectors = value.map(normalizeEmbeddingVector);
  if (vectors.some((vector) => vector.length !== vectors[0].length)) {
    throw new Error("invalid embedding vectors: inconsistent dimensions");
  }
  return vectors;
};

export class OllamaEmbedder implements Embedder {
  constructor(private readonly config: EmbeddingConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async embed(inputs: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    const response = await this.fetchImpl(`${this.config.baseURL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({ model: this.config.model, input: inputs, truncate: true })
    });
    if (!response.ok) throw new Error(`embedding request failed: ${response.status}`);
    let body: { embeddings?: unknown };
    try {
      body = await response.json() as { embeddings?: unknown };
    } catch {
      throw new Error("invalid embedding response: JSON");
    }
    const vectors = normalizeVectors(body.embeddings, inputs.length);
    return { identity: { provider: "ollama", model: this.config.model, dimensions: vectors[0].length }, vectors };
  }
}

export const createEmbedder = (config: EmbeddingConfig): Embedder => new OllamaEmbedder(config);

export const embeddingInputVersion = "node-v1";
export const embeddingInput = (node: Pick<KgNode, "type" | "name" | "description" | "aliases">) =>
  [`type: ${node.type}`, `name: ${node.name}`, node.description && `description: ${node.description}`,
    node.aliases.length && `aliases: ${node.aliases.join(", ")}`].filter(Boolean).join("\n");

export { MEMORY_CHUNK_EMBEDDING_INPUT_VERSION };
export const memoryChunkEmbeddingInput = (title: string, content: string) =>
  [`memory document: ${title}`, content].filter(Boolean).join("\n");

export const encodeEmbedding = (vector: number[]): Uint8Array => {
  const normalized = normalizeEmbeddingVector(vector);
  const bytes = new Uint8Array(normalized.length * 4);
  const view = new DataView(bytes.buffer);
  normalized.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
};

export const decodeEmbedding = (bytes: Uint8Array, dimensions: number): number[] => {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || bytes.byteLength !== dimensions * 4) {
    throw new Error("invalid embedding byte length for dimensions");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("invalid embedding vector: non-finite value");
  return vector;
};

export const cosineSimilarity = (left: number[], right: number[]): number => {
  if (left.length !== right.length) throw new Error("embedding dimensions do not match");
  const a = normalizeEmbeddingVector(left);
  const b = normalizeEmbeddingVector(right);
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
};
