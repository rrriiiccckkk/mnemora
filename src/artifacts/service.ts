import type { MnemoraConfig } from "../index.js";
import { ArtifactRepository } from "./repository.js";
import type { JournalPart } from "../journal/types.js";

export class ArtifactOffloadService {
  constructor(private readonly config: MnemoraConfig, private readonly openGraph: () => import("../tools.js").Mnemora) {}
  part(scope: string, sourceEventId: string | undefined, content: string): JournalPart[] {
    if (!this.config.artifacts?.enabled || content.length <= this.config.artifacts.inlineThresholdChars!) return [{ type: "text", text: content }];
    const graph = this.openGraph(); try { const policy = this.config.conversationJournal!; const artifact = new ArtifactRepository(graph.store.db, { maxInlineChars: this.config.artifacts.maxArtifactBytes!, maxEventBytes: this.config.artifacts.maxArtifactBytes!, sensitiveContentPolicy: policy.sensitiveContentPolicy! }).put({ scope, sourceEventId, kind: "conversation_text", content }); return [{ type: "artifact_ref", artifactId: artifact.id, preview: new ArtifactRepository(graph.store.db, { maxInlineChars: 1, maxEventBytes: 1, sensitiveContentPolicy: "redact" }).placeholder(artifact), byteLength: artifact.byteLength }]; } finally { graph.close(); }
  }
}
