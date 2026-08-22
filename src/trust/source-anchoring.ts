import { canonicalizeIngestionSource } from "../ingestion.js";
import { normalizeScope } from "../scope.js";
import type { KgObservation } from "../types.js";
import { SourceAnchorRepository } from "./repository.js";
import type { ExternalSourceRef, SourceAnchorWriteResult } from "./types.js";

export interface SourceAnchoringServiceOptions {
  repository: SourceAnchorRepository;
  snapshotMaxBytes: number;
  now?: () => number;
}

/** Captures Mnemora-local evidence now; provider resolution is deliberately deferred. */
export class SourceAnchoringService {
  private readonly now: () => number;
  constructor(private readonly options: SourceAnchoringServiceOptions) { this.now = options.now ?? Date.now; }

  anchorIngestion(input: { scope: string; source: string; text: string; observations: readonly KgObservation[]; externalRef?: ExternalSourceRef }): SourceAnchorWriteResult {
    const source = canonicalizeIngestionSource(input.source, "manual");
    return this.options.repository.createPendingAnchors({
      scope: normalizeScope(input.scope), source, text: input.text,
      claims: input.observations.map(observation => ({ id: observation.id, quote: observation.quote, extractionConfidence: observation.confidence })),
      snapshotMaxBytes: this.options.snapshotMaxBytes,
      capturedAt: this.now(), externalRef: input.externalRef ?? publicLocator(source)
    });
  }
}

/** URL locators are supplied by Mnemora's public ingest path, with no network request. */
function publicLocator(source: string): ExternalSourceRef | undefined {
  if (!source.startsWith("url:")) return undefined;
  const externalId = source.slice(4);
  try {
    const url = new URL(externalId);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return { provider: "url", externalId: url.toString() };
  } catch { return undefined; }
}
