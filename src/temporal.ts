export interface TemporalEvidence {
  valid_from: number | null;
  valid_to: number | null;
  temporal_confidence: number | null;
}

type TemporalInput = { valid_from?: unknown; valid_to?: unknown; temporal_confidence?: unknown };
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeTime(value: unknown, endpoint: "from" | "to"): number | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (dateOnly.test(value)) {
    const parsed = Date.parse(`${value}T${endpoint === "from" ? "00:00:00.000" : "23:59:59.999"}Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : undefined;
  }
  if (!timestamp.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeTemporalEvidence(input: TemporalInput): TemporalEvidence | undefined {
  const valid_from = normalizeTime(input.valid_from, "from");
  const valid_to = normalizeTime(input.valid_to, "to");
  if (valid_from === undefined || valid_to === undefined || (valid_from != null && valid_to != null && valid_from > valid_to)) return undefined;
  const rawConfidence = input.temporal_confidence;
  if (rawConfidence != null && (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence))) return undefined;
  const temporal_confidence = rawConfidence == null ? null : Math.max(0, Math.min(1, rawConfidence));
  return { valid_from, valid_to, temporal_confidence };
}

export function intervalsOverlap(a: Pick<TemporalEvidence, "valid_from" | "valid_to">, b: Pick<TemporalEvidence, "valid_from" | "valid_to">): boolean {
  return (a.valid_to ?? Number.POSITIVE_INFINITY) >= (b.valid_from ?? Number.NEGATIVE_INFINITY) &&
    (b.valid_to ?? Number.POSITIVE_INFINITY) >= (a.valid_from ?? Number.NEGATIVE_INFINITY);
}

export function isCurrentlyApplicable(interval: Pick<TemporalEvidence, "valid_from" | "valid_to">, now = Date.now()): boolean {
  return (interval.valid_from == null || interval.valid_from <= now) && (interval.valid_to == null || interval.valid_to >= now);
}

export function recencyScore(input: { reference_time: number | null }, now = Date.now(), halfLifeDays = 90): number {
  if (input.reference_time == null || !Number.isFinite(input.reference_time)) return .5;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 90;
  const ageDays = Math.max(0, now - input.reference_time) / 86400000;
  return Math.max(0, Math.min(1, 2 ** (-ageDays / halfLife)));
}
