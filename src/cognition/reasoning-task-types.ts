/**
 * Small, deterministic vocabulary bridge for ReasoningMemory applicability.
 * Stored memories predate this taxonomy, so aliases are normalized at query
 * time as well as on new writes.  No existing strategy or evidence is
 * rewritten during migration.
 */
export type CanonicalReasoningTaskType =
  | "database_migration"
  | "deployment"
  | "destructive_operation"
  | "security_operation"
  | "financial_operation"
  | "software_debugging"
  | "investment_analysis"
  | "third_party_integration"
  | "structured_reporting"
  | "research_analysis";

const aliases: Readonly<Record<string, CanonicalReasoningTaskType>> = {
  database_migration: "database_migration", migration: "database_migration", migrate: "database_migration",
  deployment: "deployment", deploy: "deployment", rollout: "deployment",
  destructive_operation: "destructive_operation", destructive: "destructive_operation", deletion: "destructive_operation",
  security_operation: "security_operation", security: "security_operation",
  financial_operation: "financial_operation", payment: "financial_operation", transfer: "financial_operation",
  software_debugging: "software_debugging", debugging: "software_debugging", debug: "software_debugging",
  investment_analysis: "investment_analysis", investment: "investment_analysis", market_analysis: "investment_analysis", "market-analysis": "investment_analysis", trading: "investment_analysis",
  third_party_integration: "third_party_integration", integration: "third_party_integration", api_integration: "third_party_integration",
  structured_reporting: "structured_reporting", report: "structured_reporting", reporting: "structured_reporting",
  research_analysis: "research_analysis", research: "research_analysis"
};

const classifications: ReadonlyArray<readonly [CanonicalReasoningTaskType, readonly string[]]> = [
  // A repair task can mention a later deployment. Prefer the concrete repair
  // activity over that surrounding lifecycle word when only one task type can
  // be passed through the public ContextEngine input.
  ["software_debugging", ["debug", "bug", "regression", "stack trace", "调试", "报错", "故障", "回归"]],
  ["database_migration", ["migration", "migrate", "schema", "ddl", "数据库迁移", "迁移", "模式变更"]],
  ["deployment", ["deploy", "deployment", "rollout", "发布", "部署", "上线"]],
  ["destructive_operation", ["delete", "deletion", "drop table", "erase", "删除", "清空", "删库"]],
  ["security_operation", ["security", "credential", "permission", "vulnerability", "安全", "凭据", "权限", "漏洞"]],
  ["financial_operation", ["payment", "transfer", "financial transaction", "付款", "支付", "转账"]],
  ["investment_analysis", ["investment", "market analysis", "portfolio", "trading", "股票", "投资", "市场分析", "交易"]],
  ["third_party_integration", ["integration", "third-party", "third party", "webhook", "api", "集成", "第三方", "接口"]],
  ["structured_reporting", ["report", "brief", "reporting", "报告", "汇报", "简报"]],
  ["research_analysis", ["research", "investigate", "analysis", "调研", "研究", "分析"]]
];

export function reasoningTaskType(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(value.trim())) return undefined;
  const normalized = value.trim().toLowerCase();
  return aliases[normalized] ?? normalized;
}

export function classifyReasoningTask(query: string): CanonicalReasoningTaskType | undefined {
  const normalized = query.toLowerCase();
  return classifications.find(([, terms]) => terms.some(term => normalized.includes(term)))?.[0];
}

export function isHighRiskReasoningOperation(query: string): boolean {
  return /\b(production|deploy(?:ment)?|migration|migrate|delete|deletion|drop|security|credential|permission|payment|transfer|rollback)\b|生产|部署|发布|迁移|删除|清空|安全|凭据|权限|支付|转账|回滚/i.test(query);
}
