export const integrationSchemaSql = `
CREATE TABLE IF NOT EXISTS kg_integration_status (
  provider TEXT PRIMARY KEY,
  detected_version TEXT,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unavailable')),
  warning_code TEXT,
  last_probe_at INTEGER NOT NULL
);
`;

export const integrationOptionalRestoreTables = ["kg_integration_status"] as const;
