import type { MnemoraConfig } from "./index.js";
import type { ExtractionResult, NodeType } from "./types.js";
import { normalizeTemporalEvidence, type TemporalEvidence } from "./temporal.js";
import type { RelationshipType } from "./relationships.js";

export interface ExtractOptions { signal?: AbortSignal }

export interface Extractor {
  extract(text: string, source?: string, options?: ExtractOptions): Promise<ExtractionResult>;
}

class InvalidResponseError extends Error {
  readonly code = "INVALID_RESPONSE";

  constructor() {
    super("LLM extraction returned invalid JSON");
    this.name = "InvalidResponseError";
  }
}

export class DeepSeekExtractor implements Extractor {
  constructor(private readonly config: Required<NonNullable<MnemoraConfig["llm"]>>) {}

  async extract(text: string, _source?: string, options?: ExtractOptions): Promise<ExtractionResult> {
    if (!this.config.apiKey) throw new Error("DeepSeek apiKey is required for kg_ingest extraction");
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: extractionSystemPrompt },
          { role: "user", content: text }
        ]
      }),
      signal: options?.signal
    });
    if (!response.ok) throw new Error(`LLM extraction failed: ${response.status}`);
    const json = await boundedResponseJson(response, 1024 * 1024) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM extraction returned no content");
    try {
      return retainSourceGroundedFallbackRelations(normalizeExtraction(JSON.parse(content)), text);
    } catch (error) {
      if (error instanceof SyntaxError) throw new InvalidResponseError();
      throw error;
    }
  }
}

async function boundedResponseJson(response: Response, maximum: number): Promise<unknown> {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new InvalidResponseError();
  if (!response.body?.getReader) {
    try { return await response.json(); } catch { throw new InvalidResponseError(); }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new InvalidResponseError(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof InvalidResponseError) throw error;
    throw new InvalidResponseError();
  }
}

export function createExtractor(config: MnemoraConfig, override?: Extractor): Extractor {
  if (override) return override;
  return new DeepSeekExtractor({
    apiKey: config.llm?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
    baseURL: config.llm?.baseURL ?? "https://api.deepseek.com/v1",
    model: config.llm?.model ?? "deepseek-chat"
  });
}

export function normalizeExtraction(value: unknown): ExtractionResult {
  if (!value || typeof value !== "object") return { entities: [], relations: [] };
  const raw = value as { entities?: unknown; relations?: unknown; relationships?: unknown; suggested_duplicates?: unknown };
  const rawRelations = Array.isArray(raw.relations) ? raw.relations : raw.relationships;
  return {
    entities: Array.isArray(raw.entities) ? raw.entities.flatMap(normalizeEntity) : [],
    relations: Array.isArray(rawRelations) ? rawRelations.flatMap(normalizeRelation) : [],
    suggested_duplicates: Array.isArray(raw.suggested_duplicates) ? raw.suggested_duplicates as ExtractionResult["suggested_duplicates"] : undefined
  };
}

const nodeTypes = new Set(["person", "company", "product", "technology", "concept", "industry", "fund", "policy", "portfolio"]);
const relationTypes = new Set<RelationshipType>([
  "works_at", "invested_in", "supplies", "supplies_product", "supplied_to", "competes_with",
  "uses", "develops", "owns", "partners_with", "in_portfolio", "related_to"
]);

const nodeTypeAliases = new Map<string, NodeType>([
  ["human", "person"],
  ["individual", "person"],
  ["organization", "company"],
  ["organisation", "company"],
  ["business", "company"],
  ["corporation", "company"],
  ["software", "product"],
  ["service", "product"],
  ["tool", "product"],
  ["app", "product"],
  ["application", "product"],
  ["framework", "technology"],
  ["language", "technology"],
  ["database", "technology"],
  ["methodology", "concept"],
  ["market", "industry"],
  ["sector", "industry"],
  ["regulation", "policy"],
  ["law", "policy"],
  ["holding", "portfolio"]
]);

const relationTypeAliases = new Map<string, RelationshipType>([
  ["works_for", "works_at"],
  ["employed_by", "works_at"],
  ["employee_of", "works_at"],
  ["invests_in", "invested_in"],
  ["investment_in", "invested_in"],
  ["supplier_of", "supplies"],
  ["provides", "supplies"],
  ["provides_product", "supplies_product"],
  ["product_supplied_to", "supplied_to"],
  ["customer_of", "supplied_to"],
  ["competitor_of", "competes_with"],
  ["competes", "competes_with"],
  ["uses_technology", "uses"],
  ["built_by", "develops"],
  ["builds", "develops"],
  ["developed", "develops"],
  ["owned_by", "owns"],
  ["partner_of", "partners_with"],
  ["partnered_with", "partners_with"],
  ["portfolio_company_of", "in_portfolio"],
  ["part_of_portfolio", "in_portfolio"],
  ["related", "related_to"]
]);

function normalizeEntity(value: unknown): ExtractionResult["entities"] {
  if (!value || typeof value !== "object") return [];
  const entity = value as Record<string, unknown>;
  const name = firstString(entity.name, entity.entity, entity.label, entity.title);
  const type = normalizeNodeType(firstString(entity.type, entity.entity_type, entity.category, entity.kind));
  if (!name || !type || isOperationalArtifactName(name)) return [];
  const confidence = normalizeConfidence(entity.confidence);
  if (!Number.isFinite(confidence)) return [];
  return [{
    name,
    type,
    description: typeof entity.description === "string" ? entity.description : "",
    aliases: Array.isArray(entity.aliases) ? entity.aliases.filter((alias): alias is string => typeof alias === "string") : [],
    confidence,
    evidence_span: firstString(entity.evidence_span, entity.evidence, entity.quote, entity.source_text) ?? "",
    ...normalizedTemporalFields(entity)
  }];
}

/** Files, scripts, generated configuration, and scheduler labels describe the
 * agent's working surface, not durable world knowledge.  They belong in the
 * journal/artifact layers and must not become misleading product nodes. */
function isOperationalArtifactName(name: string): boolean {
  const value = name.trim().normalize("NFKC").toLowerCase();
  if (!value || /[\\/]/.test(value)) return true;
  // Technology names commonly use a dot as part of their proper name. Keep
  // this deliberately short: the normal artifact guard still rejects arbitrary
  // file-like values such as `build.js` or `AGENTS.md`.
  if (["node.js", "next.js", "react.js"].includes(value)) return false;
  if (/\.(?:md|mdx|txt|json|ya?ml|toml|ini|cfg|conf|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|sql|csv|log)$/i.test(value)) return true;
  if (/^(?:agents|skills?|memory|soul|tools?|heartbeat|learnings?|hot)\.md$/i.test(value)) return true;
  return /^(?:daily|weekly|monthly|hourly|log|health|plugin|sepa)[-_](?:check|scan|job|update|sync|report)$/i.test(value);
}

function normalizeRelation(value: unknown): ExtractionResult["relations"] {
  if (!value || typeof value !== "object") return [];
  const relation = value as Record<string, unknown>;
  const source = firstString(relation.source, relation.subject, relation.from, relation.source_entity, relation.head);
  const target = firstString(relation.target, relation.object, relation.to, relation.target_entity, relation.tail);
  const type = normalizeRelationType(firstString(relation.type, relation.relation, relation.relationship, relation.predicate));
  if (!source || !target || !type) return [];
  const confidence = normalizeConfidence(relation.confidence);
  if (!Number.isFinite(confidence)) return [];
  return [{
    source,
    target,
    type,
    confidence,
    evidence_span: firstString(relation.evidence_span, relation.evidence, relation.quote, relation.source_text) ?? "",
    edge_props: relation.edge_props && typeof relation.edge_props === "object" && !Array.isArray(relation.edge_props)
      ? relation.edge_props as Record<string, unknown>
      : {},
    ...normalizedTemporalFields(relation)
  }];
}

/** `related_to` is the extractor's last-resort predicate. A provider must
 * quote a contiguous span from the supplied source before it can persist it.
 * The store also requires a non-empty span for any direct ingestion path. */
function retainSourceGroundedFallbackRelations(result: ExtractionResult, sourceText: string): ExtractionResult {
  const source = sourceText.normalize("NFKC");
  return {
    ...result,
    relations: result.relations.filter((relation) => relation.type !== "related_to" || (relation.evidence_span.trim().length > 0 && source.includes(relation.evidence_span.normalize("NFKC"))))
  };
}

function normalizedTemporalFields(value: Record<string, unknown>): Partial<TemporalEvidence> {
  const hasTemporalField = ["valid_from", "valid_to", "temporal_confidence"].some((key) => Object.hasOwn(value, key));
  if (!hasTemporalField) return {};
  return normalizeTemporalEvidence(value) ?? {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeNodeType(value: string | undefined): NodeType | undefined {
  if (!value) return undefined;
  const normalized = normalizeTypeToken(value);
  if (nodeTypes.has(normalized)) return normalized as NodeType;
  return nodeTypeAliases.get(normalized);
}

function normalizeRelationType(value: string | undefined): RelationshipType | undefined {
  if (!value) return undefined;
  const normalized = normalizeTypeToken(value);
  if (relationTypes.has(normalized as RelationshipType)) return normalized as RelationshipType;
  return relationTypeAliases.get(normalized);
}

function normalizeTypeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeConfidence(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0.5;
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : Number.NaN;
}

/**
 * Extraction system prompt for the LLM extractor.
 *
 * The prompt names the exact entity/relation types and field names expected by
 * normalizeExtraction. The normalizer still repairs common LLM variants such as
 * subject/predicate/object, but the preferred contract stays strict JSON.
 */
const extractionSystemPrompt = `You extract named entities and relationships from user text into strict JSON.

## Entity Types (use ONLY these)
- person: an individual human
- company: a business, corporation, or organization
- product: a software product, service, tool, or application
- technology: a programming language, framework, protocol, database, or technical concept
- concept: an abstract idea, methodology, or approach
- industry: a market sector or industry vertical
- fund: an investment fund or financial vehicle
- policy: a regulation, law, or government policy
- portfolio: an investment portfolio or holding

## Relation Types (use ONLY these)
- works_at: a person works for a company
- invested_in: an entity invested capital in another
- supplies: a company supplies to another company
- supplies_product: a company supplies a specific product
- supplied_to: a product is supplied to a company
- competes_with: two entities compete
- uses: a person or company uses a technology, product, or service; do not relabel a person as a company merely to fit this relation
- develops: an entity develops or builds a product/technology
- owns: an entity owns another entity
- partners_with: two entities partner or collaborate
- in_portfolio: an entity is part of a portfolio
- related_to: an explicit relationship supported by a direct quoted span when no specific type fits; otherwise omit the edge

## JSON Schema (strict - field names MUST match)
Each entity must include name, type, description, aliases, confidence (a number from 0 to 1), evidence_span, valid_from, valid_to, and temporal_confidence.
Each relation must include source, target, type, confidence (a number from 0 to 1), evidence_span, valid_from, valid_to, and temporal_confidence.

## Rules
- Return format: {"entities":[...], "relations":[...]}
- Only extract facts with direct textual evidence
- Do not create entities for filenames, scripts, configuration files, prompt files, cron/scheduler job labels, or generic agent infrastructure. These are operational artifacts, not knowledge-graph entities.
- Calibrate confidence: use 0.90-0.95 only for an explicit, unambiguous statement with a direct quote; use 0.70-0.85 for a direct statement with limited detail; use 0.50-0.65 only when the fact is explicit but scope is incomplete. Do not assign the same confidence by default.
- Set temporal fields only when the text explicitly states validity dates. Use YYYY-MM-DD or ISO 8601 with timezone; never infer dates. Otherwise use null
- Co-occurrence alone is not a relationship; never create an edge merely because two entities appear in the same text
- related_to is a last resort. If a specific semantic relationship cannot be identified from a direct quoted span, do not emit an edge. Co-occurrence, vague association, and inferred relevance are never related_to.
- Do NOT convert questions, hypotheticals, plans, or guesses into facts
- If no explicit facts exist, return {"entities":[],"relations":[]}
- For chains like "A supplies product X to B", prefer: A supplies_product X and X supplied_to B`;
