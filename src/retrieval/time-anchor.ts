/**
 * Relative-date handling for automatic recall. Pure functions, no I/O.
 *
 * Journal records carry when they were recorded, not when the event they
 * mention happened, and prompts often locate the evidence by time alone
 * ("what did I buy 10 days ago"), sharing no topical word with it. Two
 * deterministic aids follow:
 *
 * - `parseTimeAnchor` turns a time phrase in the prompt into a window of
 *   recording times, so retrieval can prefer records from that window and
 *   leave the phrase's words ("days", "ago", "saturday") out of matching.
 * - `relativeDateNotes` resolves relative dates inside a record against its
 *   recording time ("three weeks ago" recorded on 2023-05-25 ≈ 2023-05-04),
 *   rendered as packet metadata, never by rewriting the quoted text.
 *
 * Days are local calendar days of the process. Windows are deliberately wide:
 * people say "two weeks ago" for anything from ten to eighteen days.
 */

const DAY = 86_400_000;

const EN_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, "a couple of": 2, "couple of": 2, "a few": 3, few: 3, several: 3 };
const ZH_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 几: 3 };
const EN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const ZH_WEEKDAYS: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

const VAGUE_COUNT = /^(?:a few|few|several)$/iu;
const EN_COUNT = String.raw`(\d{1,3}|a couple of|couple of|a few|few|several|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

export interface TimeAnchor {
  /** Inclusive start of the recording-time window, epoch ms. */
  from: number;
  /** Exclusive end of the recording-time window, epoch ms. */
  to: number;
  /** The matched phrase, as written in the prompt. */
  phrase: string;
}

const startOfDay = (time: number) => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
const addDays = (day: number, days: number) => { const date = new Date(day); date.setDate(date.getDate() + days); return date.getTime(); };
/** Monday = 0 … Sunday = 6. */
const weekday = (day: number) => (new Date(day).getDay() + 6) % 7;
const enCount = (value: string) => /^\d+$/u.test(value) ? Number(value) : EN_NUMBERS[value.toLowerCase()] ?? NaN;
const zhCount = (value: string) => {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.length === 2 && value[0] === "十") return 10 + (ZH_DIGITS[value[1]!] ?? NaN);
  if (value.length === 2 && value[1] === "十") return (ZH_DIGITS[value[0]!] ?? NaN) * 10;
  return ZH_DIGITS[value] ?? NaN;
};

/** Center and tolerance, in days, of "N units ago". */
function agoWindow(today: number, count: number, unit: "day" | "week" | "month" | "year"): [number, number] | undefined {
  if (!Number.isFinite(count) || count < 1 || count > 120) return undefined;
  const days = unit === "day" ? count : unit === "week" ? 7 * count : unit === "month" ? 30 * count : 365 * count;
  const tolerance = unit === "day" ? Math.max(1, Math.ceil(count / 4)) : unit === "week" ? Math.min(7, 2 + count) : unit === "month" ? Math.min(21, 7 + 3 * count) : 45;
  const center = addDays(today, -days);
  return [addDays(center, -tolerance), addDays(center, tolerance + 1)];
}

/** Most recent given weekday strictly before today. */
const lastWeekday = (today: number, target: number) => addDays(today, -(((weekday(today) - target + 7) % 7) || 7));

const window = (from: number, to: number, phrase: string): TimeAnchor | undefined => from < to ? { from, to, phrase } : undefined;

/** The first relative time phrase in `query`, as a window of recording times. */
export function parseTimeAnchor(query: string, now: number, maxChars = 512): TimeAnchor | undefined {
  if (!query || !Number.isFinite(now)) return undefined;
  const text = query.slice(0, maxChars);
  const today = startOfDay(now);
  let match: RegExpMatchArray | null;

  if ((match = text.match(new RegExp(String.raw`\b${EN_COUNT}\s+(day|week|month|year)s?\s+ago\b`, "iu")))) {
    const range = agoWindow(today, enCount(match[1]!), match[2]!.toLowerCase() as "day");
    if (range) return window(range[0], range[1], match[0]);
  }
  if ((match = text.match(/(\d{1,3}|[一两二三四五六七八九十几]{1,2})\s*(?:个)?\s*(天|日|周|星期|礼拜|月|年)(?:之|以)?前/u))) {
    const unit = match[2] === "天" || match[2] === "日" ? "day" : match[2] === "月" ? "month" : match[2] === "年" ? "year" : "week";
    const range = agoWindow(today, zhCount(match[1]!), unit);
    if (range) return window(range[0], range[1], match[0]);
  }
  if ((match = text.match(/\b(the day before yesterday)\b|前天/iu))) return window(addDays(today, -3), addDays(today, -1), match[0]);
  if ((match = text.match(/\byesterday\b|昨天|昨晚/iu))) return window(addDays(today, -2), today, match[0]);
  if ((match = text.match(/\blast (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu))) {
    const day = lastWeekday(today, EN_WEEKDAYS.indexOf(match[1]!.toLowerCase()));
    return window(addDays(day, -1), addDays(day, 2), match[0]);
  }
  if ((match = text.match(/上(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u))) {
    const monday = addDays(today, -weekday(today));
    const day = addDays(monday, -7 + ZH_WEEKDAYS[match[1]!]!);
    return window(addDays(day, -1), addDays(day, 2), match[0]);
  }
  if ((match = text.match(/\b(?:last|this past|the past) weekend\b|上(?:个)?周末/iu))) {
    const saturday = lastWeekday(today, 5);
    return window(addDays(saturday, -1), addDays(saturday, 3), match[0]);
  }
  if ((match = text.match(/\b(?:this past|the past|past) (?:week|few days)\b|最近几天|这几天/iu))) return window(addDays(today, -8), addDays(today, 1), match[0]);
  if ((match = text.match(/\blast week\b|上(?:个)?(?:周|星期|礼拜)/iu))) {
    const monday = addDays(today, -weekday(today));
    return window(addDays(monday, -8), addDays(monday, 1), match[0]);
  }
  if ((match = text.match(/\blast month\b|上(?:个)?月/iu))) {
    const date = new Date(today); date.setDate(1);
    const first = date.getTime(); date.setMonth(date.getMonth() - 1);
    return window(addDays(date.getTime(), -3), addDays(first, 3), match[0]);
  }
  return undefined;
}

/** `query` without the anchor phrase, so its words do not count as topic. */
export const withoutTimeAnchor = (query: string, anchor: TimeAnchor | undefined) => anchor ? query.replace(anchor.phrase, " ").replace(/\s+/gu, " ").trim() : query;

const isoDay = (day: number) => {
  const date = new Date(day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/**
 * Point-like relative dates in `text`, resolved against `recordedAt`, as
 * `phrase≈YYYY-MM-DD`. At most four, in text order, each phrase once.
 */
export function relativeDateNotes(text: string, recordedAt: number): string[] {
  if (!text || !Number.isFinite(recordedAt) || recordedAt <= 0) return [];
  const day = startOfDay(recordedAt);
  const notes: Array<[number, string]> = [];
  const seen = new Set<string>();
  const add = (index: number, phrase: string, date: number) => {
    const key = phrase.toLowerCase();
    if (seen.has(key) || !Number.isFinite(date)) return;
    seen.add(key);
    notes.push([index, `${phrase.replace(/[\s,;=]+/gu, " ").trim()}≈${isoDay(date)}`]);
  };
  const sample = text.slice(0, 8000);
  for (const match of sample.matchAll(new RegExp(String.raw`\b${EN_COUNT}\s+(day|week|month|year)s?\s+ago\b`, "giu"))) {
    const count = enCount(match[1]!), unit = match[2]!.toLowerCase();
    // "a few weeks ago" is a window, not a date; resolving it would invent one.
    if (!Number.isFinite(count) || count < 1 || count > 120 || VAGUE_COUNT.test(match[1]!)) continue;
    if (unit === "day" || unit === "week") add(match.index!, match[0], addDays(day, -(unit === "day" ? count : 7 * count)));
    else { const date = new Date(day); if (unit === "month") date.setMonth(date.getMonth() - count); else date.setFullYear(date.getFullYear() - count); add(match.index!, match[0], date.getTime()); }
  }
  for (const match of sample.matchAll(new RegExp(String.raw`\bin\s+${EN_COUNT}\s+(day|week)s?\b`, "giu"))) {
    const count = enCount(match[1]!);
    if (Number.isFinite(count) && count >= 1 && count <= 60 && !VAGUE_COUNT.test(match[1]!)) add(match.index!, match[0], addDays(day, match[2]!.toLowerCase() === "day" ? count : 7 * count));
  }
  for (const match of sample.matchAll(/\b(the day before yesterday|yesterday|tomorrow)\b/giu)) add(match.index!, match[0], addDays(day, match[1]!.toLowerCase() === "tomorrow" ? 1 : match[1]!.toLowerCase() === "yesterday" ? -1 : -2));
  // "next/this Saturday" is ambiguous (this week's or the following one), so
  // only the past form is resolved.
  for (const match of sample.matchAll(/\blast (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu)) add(match.index!, match[0], lastWeekday(day, EN_WEEKDAYS.indexOf(match[1]!.toLowerCase())));
  for (const match of sample.matchAll(/(\d{1,3}|[一两二三四五六七八九十几]{1,2})\s*(?:个)?\s*(天|周|星期|月)(?:之|以)?前/gu)) {
    const count = zhCount(match[1]!);
    if (!Number.isFinite(count) || count < 1 || count > 120 || match[1] === "几") continue;
    if (match[2] === "月") { const date = new Date(day); date.setMonth(date.getMonth() - count); add(match.index!, match[0], date.getTime()); }
    else add(match.index!, match[0], addDays(day, -(match[2] === "天" ? count : 7 * count)));
  }
  for (const match of sample.matchAll(/前天|昨天|明天|后天/gu)) add(match.index!, match[0], addDays(day, { 前天: -2, 昨天: -1, 明天: 1, 后天: 2 }[match[0]]!));
  // 上周三 / 这周三 / 下周三 name a calendar week, unlike the English forms.
  for (const match of sample.matchAll(/(上|这|下)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/gu)) {
    const monday = addDays(day, -weekday(day));
    add(match.index!, match[0], addDays(monday, (match[1] === "上" ? -7 : match[1] === "下" ? 7 : 0) + ZH_WEEKDAYS[match[2]!]!));
  }
  return notes.sort((a, b) => a[0] - b[0]).slice(0, 4).map(([, note]) => note);
}

/**
 * Windows of the events a record mentions ("I cleaned them last month"),
 * resolved against its recording time with the same tolerances as a prompt.
 * A record recorded today about last month belongs to last month.
 */
export function mentionSpans(text: string, recordedAt: number, limit = 4): TimeAnchor[] {
  if (!text || !Number.isFinite(recordedAt) || recordedAt <= 0) return [];
  const spans: TimeAnchor[] = [];
  let rest = text.slice(0, 8000);
  while (spans.length < limit) {
    const span = parseTimeAnchor(rest, recordedAt, 8000);
    if (!span) break;
    spans.push(span);
    rest = rest.replace(span.phrase, " ");
  }
  return spans;
}

/** Whether a record belongs to `window`: recorded in it, or mentioning an event in it. */
export function recordInWindow(window: TimeAnchor, recordedAt: number, text: string): boolean {
  if (recordedAt >= window.from && recordedAt < window.to) return true;
  return mentionSpans(text, recordedAt).some(span => span.from < window.to && span.to > window.from);
}
