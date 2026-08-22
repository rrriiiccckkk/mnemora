import { createHash } from "node:crypto";

export const MEMORY_CHUNK_EMBEDDING_INPUT_VERSION = "memory-chunk-v1";
export const MEMORY_CHUNK_CHARS = 1600;
export const MEMORY_CHUNK_OVERLAP_CHARS = 200;

export interface MemoryChunkSeed {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  content_hash: string;
}

/**
 * Stable, local-only chunks keep semantic retrieval bounded and make the
 * matching excerpt meaningful even when a memory document is long.  The
 * boundary prefers whitespace and sentence punctuation but never drops text.
 */
export function chunkMemoryDocument(documentId: string, content: string): MemoryChunkSeed[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const chunks: MemoryChunkSeed[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + MEMORY_CHUNK_CHARS);
    if (end < normalized.length) {
      const floor = start + Math.floor(MEMORY_CHUNK_CHARS * .55);
      const boundary = Math.max(
        normalized.lastIndexOf("\n", end),
        normalized.lastIndexOf("。", end),
        normalized.lastIndexOf(".", end),
        normalized.lastIndexOf(" ", end)
      );
      if (boundary >= floor) end = boundary + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) {
      const contentHash = createHash("sha256").update(chunk).digest("hex");
      const ordinal = chunks.length;
      chunks.push({
        id: `memorychunk:${createHash("sha256").update(`${documentId}\0${ordinal}\0${contentHash}`).digest("hex").slice(0, 24)}`,
        document_id: documentId,
        ordinal,
        content: chunk,
        content_hash: contentHash
      });
    }
    if (end >= normalized.length) break;
    start = Math.max(end - MEMORY_CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}
