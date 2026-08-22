import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import type { ExtractionResult } from "./types.js";

export const INGESTION_FINGERPRINT_VERSION = "v2";
export const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_ITEMS = 50;

export function normalizeIngestionText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

/**
 * Source labels are provenance metadata, not trusted input.  Batch ingestion
 * deliberately accepts a per-item failure, so a malformed non-string label
 * must fall back safely instead of aborting the whole batch.
 */
export function canonicalizeIngestionSource(source?: unknown, fallback = "manual"): string {
  let value = (typeof source === "string" ? source.trim().slice(0, 256) : "") || fallback;
  if (isAbsolute(value) || win32.isAbsolute(value)) value = "redacted-path";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `manual:${value}`;
}

export function fingerprintIngestion(text: string, source: string): string {
  return createHash("sha256").update(`${INGESTION_FINGERPRINT_VERSION}\0${canonicalizeIngestionSource(source)}\0${normalizeIngestionText(text)}`).digest("hex");
}

export function fingerprintExtractedTemporal(inputFingerprint: string, extraction: ExtractionResult): string {
  const facts = [
    ...extraction.entities.map((item) => temporalFact("entity", item.name, item.type, item)),
    ...extraction.relations.map((item) => temporalFact("relation", item.source, `${item.type}:${item.target}`, item))
  ].filter((item): item is NonNullable<typeof item> => item != null).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(`${INGESTION_FINGERPRINT_VERSION}\0${inputFingerprint}\0${JSON.stringify(facts)}`).digest("hex");
}

function temporalFact(kind: string, subject: string, predicate: string, item: { valid_from?: string | number | null; valid_to?: string | number | null; temporal_confidence?: number | null }) {
  if (item.valid_from == null && item.valid_to == null && item.temporal_confidence == null) return null;
  return [kind, subject, predicate, item.valid_from ?? null, item.valid_to ?? null, item.temporal_confidence ?? null] as const;
}
