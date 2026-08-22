import type { RecallMetadataFilter, RecallMetadataPrefix, RetrievalIntent, RetrievalIntentCategory } from "./types.js";

export interface QueryRoutingOptions {
  enabled?: boolean;
  tagPrefix?: boolean;
  queryExpansion?: boolean;
  intentRouting?: boolean;
  identifierHints?: boolean;
}

export interface RecallQueryPlan {
  query: string;
  alternates: string[];
  tags: string[];
  intent: RetrievalIntent;
  /** Exact metadata selectors used by lexical-only prefix queries. */
  metadataFilters?: RecallMetadataFilter[];
  /** Exact identifiers which must occur in the selected local document. */
  mustContain?: string[];
  /** Prefix queries never enter semantic recall. */
  lexicalOnly?: true;
  /** `scope:` is an authorization constraint, never a scope selector. */
  scopeConstraint?: string;
  /** Derived category used for bounded local boosts and collection depth. */
  category?: RetrievalIntentCategory;
}

const boundedText = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, 512);
const normalizeTag = (value: string) => value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_.:-]+/gu, "").slice(0, 64);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const validScope = (value: string) => /^[a-z0-9][a-z0-9._:-]{0,79}$/u.test(value);
const prefixKeys: Record<RecallMetadataPrefix, readonly string[]> = {
  proj: ["proj", "project", "project_id", "projectid"],
  env: ["env", "environment", "environment_id", "environmentid"],
  team: ["team", "team_id", "teamid"]
};

/** Metadata key aliases are deliberately fixed; arbitrary JSON paths are not
 * accepted as query input. */
export function metadataKeys(prefix: RecallMetadataPrefix): readonly string[] { return prefixKeys[prefix]; }

const normalizePrefixValue = (value: string) => value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_.:-]+/gu, "").slice(0, 64);

const prefixPattern = /(?:^|\s)(proj|env|team|scope):([\p{L}\p{N}_.:-]{1,64})(?=\s|$)/gu;
// Keep ordinary technical identifiers (for example DATABASE_URL) useful for
// lexical recall, but never turn labels that look like credentials into
// embedding/lexical alternates.  The middle-word forms matter here:
// DEPLOYMENT_KEY and PRIVATE_SIGNING_KEY are common names that the compact
// DEPLOY_KEY / PRIVATE_KEY patterns do not cover.
const sensitiveIdentifier = /(?:ACCESS_?(?:KEY|TOKEN)|API_?KEY|AUTH(?:ORIZATION)?|CREDENTIALS?|DEPLOY(?:MENT)?_?KEY|ENCRYPT(?:ION)?_?KEY|PASSWORD|PRIVATE(?:_[A-Z0-9]+)*_?KEY|SECRET|SIGN(?:ING)?_?KEY|TOKEN)/iu;

/** Stable technical identifiers are useful lexical recall anchors, but secret
 * labels are never turned into a retrieval alternate. */
export function safeIdentifierHints(input: string): string[] {
  const values = input.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return unique(values.filter(value => value.length <= 96 && !sensitiveIdentifier.test(value))).slice(0, 4);
}

/** The bounded map mirrors common bilingual memory vocabulary without model
 * calls. It intentionally produces at most four alternates at the plan edge. */
const bilingualSynonyms: ReadonlyArray<readonly [string, string]> = [
  ["ai", "人工智能"], ["llm", "大模型"], ["chip", "芯片"], ["semiconductor", "半导体"],
  ["crash", "崩溃"], ["error", "错误"], ["incident", "故障"], ["outage", "宕机"], ["down", "挂了"],
  ["decision", "决策"], ["preference", "偏好"], ["deploy", "部署"], ["release", "发布"],
  ["rollback", "回滚"], ["database", "数据库"], ["fix", "修复"]
];

/**
 * A deliberately small, opt-in query plan. It does not call a model or infer
 * user facts: alternate terms are a documented bilingual convenience only.
 */
export function planRecallQuery(input: string, options: QueryRoutingOptions | undefined = {}): RecallQueryPlan {
  const original = boundedText(input);
  if (!options.enabled) return { query: original, alternates: [], tags: [], intent: "general" };
  const tags: string[] = [];
  const metadataFilters: RecallMetadataFilter[] = [];
  const mustContain: string[] = [];
  let scopeConstraint: string | undefined;
  let routedPrefix = false;
  let queryText = options.tagPrefix === false ? original : original.replace(/(?:^|\s)tag:([\p{L}\p{N}_.:-]{1,64})/gu, (_whole, value: string) => {
    const tag = normalizeTag(value); if (tag) tags.push(tag); return " ";
  });
  queryText = boundedText(queryText.replace(prefixPattern, (_whole, rawPrefix: string, rawValue: string) => {
    const value = normalizePrefixValue(rawValue), prefix = rawPrefix.toLocaleLowerCase() as RecallMetadataPrefix | "scope";
    if (!value) return " ";
    routedPrefix = true;
    if (prefix === "scope") {
      // Keep an invalid value as a non-matching constraint so malformed scope
      // prefixes fail closed instead of silently turning into a broad query.
      scopeConstraint = validScope(value) ? value : `invalid:${value}`;
    } else {
      mustContain.push(value);
      if (prefix === "proj" || prefix === "env" || prefix === "team") metadataFilters.push({ prefix, value });
    }
    return " ";
  }));
  const query = queryText;
  const alternates: string[] = [];
  if (options.queryExpansion !== false) {
    const normalized = query.toLocaleLowerCase();
    for (const [from, to] of bilingualSynonyms) {
      if (normalized.includes(from)) alternates.push(boundedText(query.replace(new RegExp(from, "ig"), to)));
      if (normalized.includes(to.toLocaleLowerCase())) alternates.push(boundedText(query.replace(new RegExp(to, "ig"), from)));
    }
  }
  if (options.identifierHints !== false) alternates.push(...safeIdentifierHints(query));
  const intent: RetrievalIntent = options.intentRouting === false ? "general"
    : /\b(previous|earlier|history|we said|last time)\b|之前|刚才|前面|历史|聊天记录/u.test(query) ? "exact_history"
      : /\b(decision|incident|outcome|postmortem)\b|决策|故障|复盘|结果/u.test(query) ? "prior_episode"
        : /\b(file|document|attachment|artifact)\b|文件|文档|附件/u.test(query) ? "artifact"
          : /^(?:who|what|when|where|which)\b|^(?:谁|什么|何时|哪里|哪个)/u.test(query) ? "structured_fact" : "general";
  const category: RetrievalIntentCategory | undefined = options.intentRouting === false ? undefined
    : /\b(preference|prefer|like|likes|dislike|want|偏好|喜欢|不喜欢|倾向)\b|偏好|喜欢|不喜欢/u.test(query) ? "preference"
      : /\b(decision|decide|choose|chosen|option|决策|决定|选择|方案)\b|决策|决定|选择|方案/u.test(query) ? "decision"
        : /\b(entity|company|person|organization|供应商|公司|人物|实体)\b|供应商|公司|人物|实体/u.test(query) ? "entity"
          : /\b(event|incident|outage|crash|error|history|故障|事故|宕机|崩溃|历史|事件)\b|故障|事故|宕机|崩溃|历史|事件/u.test(query) ? "event"
            : /\b(fact|facts|where|when|who|what|事实)\b|事实|谁|什么|何时|哪里/u.test(query) ? "fact" : undefined;
  // Identifier hints are independently bounded to four.  Preserve all four
  // through the final plan instead of applying an accidental second cap.
  const plan: RecallQueryPlan = { query, alternates: unique(alternates).filter(value => value && value !== query).slice(0, 4), tags: unique(tags).slice(0, 4), intent };
  if (metadataFilters.length) plan.metadataFilters = metadataFilters.slice(0, 4);
  if (mustContain.length) plan.mustContain = unique(mustContain).slice(0, 4);
  if (routedPrefix) plan.lexicalOnly = true;
  if (scopeConstraint) plan.scopeConstraint = scopeConstraint;
  if (category) plan.category = category;
  return plan;
}

/** Memory metadata is scalar by contract. `tag`, `tags`, and `category` may
 * contain comma/space-delimited labels; all requested tags must be present. */
export function memoryMatchesTags(metadata: Record<string, string | number | boolean | null> | undefined, tags: readonly string[]): boolean {
  if (!tags.length) return true;
  const values = [metadata?.tag, metadata?.tags, metadata?.category]
    .filter((value): value is string => typeof value === "string")
    .flatMap(value => value.split(/[\s,;|]+/u).map(normalizeTag));
  return tags.every(tag => values.includes(tag));
}

/** Exact, case-insensitive scalar metadata matching for supported prefixes. */
export function memoryMatchesMetadataFilters(metadata: Record<string, string | number | boolean | null> | undefined, filters: readonly RecallMetadataFilter[]): boolean {
  if (!filters.length) return true;
  return filters.every(filter => metadataKeys(filter.prefix).some(key => {
    const value = metadata?.[key];
    return (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && String(value).trim().toLocaleLowerCase() === filter.value;
  }));
}

/** Prefix identifiers are exact local lexical anchors, not broad text hints. */
export function textContainsAll(value: string, required: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return required.every(item => normalized.includes(item.toLocaleLowerCase()));
}
