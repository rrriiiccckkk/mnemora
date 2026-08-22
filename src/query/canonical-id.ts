const CANONICAL_ID_MAX_LENGTH = 160;
const canonicalId = /^[a-z][a-z0-9_-]{0,30}:[A-Za-z0-9-][A-Za-z0-9._~-]{0,127}$/;

export function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && value.length <= CANONICAL_ID_MAX_LENGTH && canonicalId.test(value);
}
