export const MAX_QUERY_QUESTION_CODE_POINTS = 4000;

export function boundedQueryQuestion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("invalid_plan");
  let codePoints = 0;
  for (const _codePoint of value) if (++codePoints > MAX_QUERY_QUESTION_CODE_POINTS) throw new Error("invalid_plan");
  return value;
}
