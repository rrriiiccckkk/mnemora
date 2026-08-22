import { isLowInformationAutomaticInput } from "./cognition/pre-admission.js";

/** Opt-in policy for deterministic automatic-extraction input selection. */
export type AutomaticInputQualityMode = "off" | "shadow" | "enforce";

export type AutomaticInputQualityReason = "low_information" | "agent_denial";

export interface AutomaticInputQualityPlan {
  action: "extract" | "skip";
  text: string;
  truncated: boolean;
  sourceSegments: number;
  selectedSegments: number;
  droppedSegments: number;
  highSignalSegments: number;
  reasonCodes: AutomaticInputQualityReason[];
}

export interface AutomaticInputQualityOptions {
  maxChars: number;
  maxSegments: number;
}

interface Segment {
  index: number;
  text: string;
  highSignal: boolean;
}

const shorten = (text: string, size: number): string =>
  text.length <= size ? text : size <= 1 ? "…".slice(0, size) : `${text.slice(0, size - 1)}…`;

/**
 * This is deliberately narrow because automatic extraction accepts only
 * user-authored content. It recognizes generic model-refusal boilerplate, not
 * ordinary statements about a user's access, permissions, or circumstances.
 */
function isGenericAgentDenial(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  return /^(?:as an ai(?: language model)?,? )?i (?:cannot|can't|do not|don't|am unable to) (?:access|browse|retrieve|open) (?:(?:that|this)(?: (?:link|url|website|web|content))?|the (?:link|url|website|web|internet)|external (?:links?|websites?|content))\.?$/u.test(normalized)
    || /^(?:作为(?:一个)?ai(?:助手|模型)?[，,]?\s*)?我(?:无法|不能|不可以)访问(?:这个|该|外部)?(?:链接|网址|网站|网页|互联网|内容)。?$/u.test(value.trim());
}

function isHighSignal(value: string): boolean {
  return /\b(?:correction|correct(?:ing|ion)?|i\s+(?:have\s+)?decided|my\s+decision|i\s+prefer|changed\s+my\s+mind|instead)\b/iu.test(value)
    || /(?:更正|修正|改为|改成|已决定|我决定|偏好|不再|取代|以后)/u.test(value);
}

/**
 * Produces a bounded, deterministic plan without a provider call or a write.
 * It never semantically rewrites a segment. High-signal segments receive the
 * budget before ordinary segments, so a late correction cannot be crowded out
 * by earlier background context.
 */
export function planAutomaticExtractionInput(value: string, options: AutomaticInputQualityOptions): AutomaticInputQualityPlan {
  const source = value.trim();
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const maxSegments = Math.min(32, Math.max(1, Math.floor(options.maxSegments)));
  if (!source || maxChars === 0) return { action: "skip", text: "", truncated: source.length > 0, sourceSegments: source ? 1 : 0, selectedSegments: 0, droppedSegments: source ? 1 : 0, highSignalSegments: 0, reasonCodes: [] };

  const rawSegments = source.split(/(?:\r?\n){2,}|(?<=[.!?。！？])\s+/u).map(text => text.trim()).filter(Boolean);
  const reasons = new Set<AutomaticInputQualityReason>();
  const eligible: Segment[] = [];
  for (const [index, text] of rawSegments.entries()) {
    if (isLowInformationAutomaticInput(text)) {
      reasons.add("low_information");
      continue;
    }
    if (isGenericAgentDenial(text)) {
      reasons.add("agent_denial");
      continue;
    }
    eligible.push({ index, text, highSignal: isHighSignal(text) });
  }

  const prioritised = [...eligible]
    .sort((left, right) => Number(right.highSignal) - Number(left.highSignal) || left.index - right.index)
    .slice(0, maxSegments);
  const highSignalSegments = prioritised.filter(segment => segment.highSignal).length;
  let remaining = maxChars;
  const selected: Array<Segment & { rendered: string }> = [];
  let truncated = prioritised.length !== rawSegments.length;
  for (const segment of prioritised) {
    const separator = selected.length ? "\n\n" : "";
    const available = remaining - separator.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const rendered = shorten(segment.text, available);
    selected.push({ ...segment, rendered });
    remaining -= separator.length + rendered.length;
    if (rendered.length < segment.text.length) {
      truncated = true;
      break;
    }
  }
  const text = selected
    .sort((left, right) => left.index - right.index)
    .map((segment, index) => `${index ? "\n\n" : ""}${segment.rendered}`)
    .join("");
  const selectedSegments = selected.length;
  return {
    action: text ? "extract" : "skip",
    text,
    truncated,
    sourceSegments: rawSegments.length,
    selectedSegments,
    droppedSegments: Math.max(0, rawSegments.length - selectedSegments),
    highSignalSegments,
    reasonCodes: [...reasons].sort()
  };
}
