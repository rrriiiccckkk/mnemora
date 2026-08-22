import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { MnemoraConfig } from "../index.js";
import type { JournalEvent } from "../journal/types.js";
import { normalizeScope } from "../scope.js";
import { ArtifactRepository } from "./repository.js";

type HostMessage = { id?: unknown; role?: string; content?: unknown; [key: string]: unknown };

type StoredToolArtifact = { entryId: string; id: string; contentHash: string; byteLength: number };

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Preserves a public host tool-result string before a later ContextEngine
 * assembly replaces it with an opaque reference. This never reads a tool
 * input, a file path, or a host transcript store: it only handles the string
 * already delivered through the public ContextEngine lifecycle.
 */
export class ToolPayloadArtifactService {
  constructor(private readonly config: MnemoraConfig, private readonly db: DatabaseSyncInstance) {}

  archiveCaptured(scope: string, events: readonly JournalEvent[], messages: readonly HostMessage[]): number {
    if (!this.enabled()) return 0;
    const repository = new ArtifactRepository(this.db, this.policy());
    let archived = 0;
    for (let index = 0; index < Math.min(events.length, messages.length); index++) {
      const event = events[index], payload = toolPayload(messages[index]);
      if (!event || event.contextDomain !== "tool" || payload == null || !this.qualifies(payload)) continue;
      try {
        repository.put({ scope, sourceEventId: event.id, kind: "tool_result", content: payload });
        archived++;
      } catch {
        // Capture is already durable. A supplemental archive must never turn a
        // completed host turn into an error or make a later prompt lossy.
      }
    }
    return archived;
  }

  project(scope: string, sessionId: string, messages: readonly HostMessage[]): HostMessage[] {
    if (!this.enabled() || !messages.length) return [...messages];
    const references = this.references(scope, sessionId);
    if (!references.size) return [...messages];
    return messages.map(message => {
      if (!isTool(message) || typeof message.id !== "string") return message;
      const reference = references.get(message.id.trim()), payload = toolPayload(message);
      // A stub is safe only when the archive is byte-for-byte the public tool
      // string. Redaction, a size limit, or an unknown content shape leaves
      // the host message untouched rather than claiming recoverability.
      if (!reference || payload == null || !this.qualifies(payload) || digest(payload) !== reference.contentHash) return message;
      return { ...message, content: `[MNEMORA_TOOL_RESULT artifact_id="${reference.id}" source_linked="true" authority="untrusted_tool_output" byte_length="${reference.byteLength}"]\nLarge tool output is archived locally. If details are required, use kg_memory artifact_read with this exact ID and the same scope; reads are bounded.\n[/MNEMORA_TOOL_RESULT]` };
    });
  }

  private enabled(): boolean { return this.config.artifacts?.enabled === true && this.config.artifacts.toolPayloads?.enabled === true; }

  private qualifies(payload: string): boolean {
    return payload.length > this.config.artifacts!.inlineThresholdChars! && Buffer.byteLength(payload, "utf8") <= this.config.artifacts!.maxArtifactBytes!;
  }

  private policy() {
    const artifacts = this.config.artifacts!, journal = this.config.conversationJournal!;
    // Artifact storage has its own explicit byte ceiling. Reusing the smaller
    // Journal inline cap here would silently make a hash-matched replacement
    // impossible for the very payloads this feature is meant to preserve.
    return { maxInlineChars: artifacts.maxArtifactBytes!, maxEventBytes: artifacts.maxArtifactBytes! + 256, sensitiveContentPolicy: journal.sensitiveContentPolicy! } as const;
  }

  private references(scope: string, sessionId: string): Map<string, StoredToolArtifact> {
    const rows = this.db.prepare(`SELECT link.entry_id AS entry_id,artifact.id AS id,artifact.content_hash AS content_hash,artifact.byte_length AS byte_length
      FROM mnemora_host_message_links AS link
      JOIN mnemora_conversation_events AS event ON event.id=link.event_id AND event.scope=link.scope
      JOIN mnemora_artifacts AS artifact ON artifact.source_event_id=event.id AND artifact.scope=event.scope
      WHERE event.scope=? AND event.session_id=? AND event.context_domain='tool'
        AND artifact.kind='tool_result' AND artifact.deleted_at IS NULL
      ORDER BY artifact.created_at DESC,artifact.id DESC LIMIT 512`).all(normalizeScope(scope), sessionId) as Array<Record<string, unknown>>;
    const result = new Map<string, StoredToolArtifact>();
    for (const row of rows) {
      const entryId = typeof row.entry_id === "string" ? row.entry_id : "";
      const id = typeof row.id === "string" ? row.id : "";
      const contentHash = typeof row.content_hash === "string" ? row.content_hash : "";
      const byteLength = Number(row.byte_length);
      if (entryId && id && /^[a-f0-9]{64}$/i.test(contentHash) && Number.isSafeInteger(byteLength) && byteLength >= 0 && !result.has(entryId)) result.set(entryId, { entryId, id, contentHash, byteLength });
    }
    return result;
  }
}

function isTool(message: HostMessage): boolean { return message.role?.toLowerCase() === "tool"; }

/** Structured/multi-modal payloads remain host-owned. Serializing them here
 * would introduce an unbounded second parser at a trust boundary. */
function toolPayload(message: HostMessage): string | undefined { return isTool(message) && typeof message.content === "string" ? message.content : undefined; }
