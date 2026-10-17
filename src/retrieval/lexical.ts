/**
 * Shared lexical primitives for ranked local recall.
 *
 * Journal recall previously matched every query word as a raw substring and
 * kept the newest rows, so generic words ("how", "is", "什么") decided what was
 * injected. These helpers give one deterministic tokenisation for indexing and
 * querying: Intl word segmentation (so CJK text is split into words), a small
 * English/Chinese stopword list, and an FTS5 MATCH expression built only from
 * content-bearing terms.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const HAN = /\p{Script=Han}/u;

/** Function words that carry no retrieval signal in either language. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing", "done", "down", "during", "each", "else", "ever", "every", "few", "for", "from", "further", "get", "got", "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "let", "like", "made", "make", "many", "may", "me", "might", "mine", "more", "most", "much", "must", "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "one", "only", "or", "other", "our", "ours", "out", "over", "own", "please", "same", "shall", "she", "should", "so", "some", "such", "tell", "than", "that", "the", "their", "theirs", "them", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "us", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "would", "yes", "yet", "you", "your", "yours", "yourself",
  "im", "ive", "id", "ill", "dont", "didnt", "doesnt", "isnt", "wasnt", "cant", "wont",
  // Chinese
  "的", "了", "和", "是", "在", "我", "你", "他", "她", "它", "们", "我们", "你们", "他们", "这", "那", "这个", "那个", "这些", "那些", "什么", "怎么", "怎样", "如何", "为什么", "哪", "哪个", "哪些", "哪里", "多少", "几", "吗", "呢", "吧", "啊", "呀", "也", "都", "就", "还", "又", "很", "太", "要", "会", "能", "可以", "想", "对", "把", "被", "给", "跟", "与", "或", "或者", "以及", "一个", "一下", "一些", "有", "没有", "不", "没", "请", "帮", "帮我", "告诉", "知道", "现在", "之前", "以前", "时候", "一直", "已经"
]);

/** Lowercased word-like segments, in order. */
export function segmentWords(value: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(value.normalize("NFKC").toLowerCase())) {
    if (part.isWordLike) out.push(part.segment.replace(/['’]/gu, ""));
  }
  return out.filter(Boolean);
}

/** Space-separated form stored in the FTS index (CJK words become tokens). */
export function indexText(value: string): string {
  return segmentWords(value).join(" ");
}

/**
 * ICU's dictionary misses many compounds ("订餐" segments as 订|餐). Adjacent
 * single Han characters that are not stopwords are joined into overlapping
 * bigrams so the compound stays a searchable unit; a lone character is kept.
 */
export function joinHanSingles(words: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else for (let index = 0; index + 1 < run.length; index++) out.push(run[index] + run[index + 1]);
    run = [];
  };
  for (const word of words) {
    if (word.length === 1 && HAN.test(word) && !STOPWORDS.has(word)) { run.push(word); continue; }
    flush();
    out.push(word);
  }
  flush();
  return out;
}

/** Content-bearing query terms used for ranking and anchor checks. */
export function contentTerms(query: string, limit = 16): string[] {
  const terms: string[] = [];
  for (const word of joinHanSingles(segmentWords(query))) {
    if (STOPWORDS.has(word)) continue;
    if (!HAN.test(word) && word.length < 2) continue;
    if (!terms.includes(word)) terms.push(word);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** FTS5 MATCH expression: OR over quoted terms so bm25 ranks by coverage and rarity. */
export function ftsMatchExpression(terms: readonly string[]): string | undefined {
  // Each term is segmented exactly as indexed text is, so a joined Han bigram
  // ("订餐") becomes the adjacent-token phrase "订 餐".
  const quoted = terms.map(term => indexText(term.replace(/"/gu, ""))).filter(Boolean).map(term => `"${term}"`);
  return quoted.length ? quoted.join(" OR ") : undefined;
}

const SUFFIXES = ["ingly", "edly", "ing", "ed", "es", "s", "ly", "er", "est"];
/**
 * Light suffix stripping so "graduated" matches "graduate". The FTS index uses
 * the porter stemmer; match checks must not be stricter than the index or a
 * record found by an inflected form would look unrelated to the query.
 */
export function lightStem(word: string): string {
  if (!/^[a-z]+$/u.test(word)) return word;
  let stem = word;
  for (const suffix of SUFFIXES) if (stem.length > suffix.length + 2 && stem.endsWith(suffix)) { stem = stem.slice(0, -suffix.length); break; }
  // "graduate"/"graduated" and "live"/"lives" share a stem once a final e goes.
  return stem.length > 3 && stem.endsWith("e") ? stem.slice(0, -1) : stem;
}

/**
 * Query terms that appear in the text, in query order. `stem` also accepts
 * inflected forms; ranking uses exact words (measured: stemming the ranking
 * signal lowered LongMemEval recall), the relevance floor uses stems so a
 * record found by the porter index is not judged unrelated.
 */
export function matchedTerms(value: string, terms: readonly string[], stem = false): string[] {
  if (!terms.length) return [];
  const normalize = stem ? lightStem : (word: string) => word;
  const words = new Set(segmentWords(value).map(normalize));
  const haystack = value.normalize("NFKC").toLowerCase();
  return terms.filter(term => words.has(normalize(term)) || (HAN.test(term) && haystack.includes(term)));
}

/** Fraction of query terms that appear in the text (0..1), exact words. */
export function termCoverage(value: string, terms: readonly string[]): number {
  return terms.length ? matchedTerms(value, terms).length / terms.length : 0;
}

/**
 * Rarity-weighted share of query terms matched (0..1). A record that shares
 * only a common word ("time", "work") with the query scores low; one that
 * shares the query's rare, specific terms scores high. Unknown weights count 1.
 */
export function weightedCoverage(value: string, terms: readonly string[], weights: ReadonlyMap<string, number>): number {
  if (!terms.length) return 0;
  const weight = (term: string) => weights.get(term) ?? 1;
  const total = terms.reduce((sum, term) => sum + weight(term), 0);
  if (!(total > 0)) return 0;
  return matchedTerms(value, terms, true).reduce((sum, term) => sum + weight(term), 0) / total;
}

export interface TextChunk { ordinal: number; start: number; end: number; text: string }

/**
 * Overlapping character windows so a fact late in a long message remains
 * independently searchable and can be excerpted around its match.
 */
export function chunkText(value: string, size = 700, overlap = 150): TextChunk[] {
  if (value.length <= size) return [{ ordinal: 0, start: 0, end: value.length, text: value }];
  const chunks: TextChunk[] = [];
  let start = 0, ordinal = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    if (end < value.length) {
      const boundary = value.lastIndexOf(" ", end);
      if (boundary > start + size / 2) end = boundary;
    }
    chunks.push({ ordinal: ordinal++, start, end, text: value.slice(start, end) });
    if (end >= value.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Excerpt around a character window, bounded to `maximum` characters. */
export function excerptAround(value: string, start: number, end: number, maximum = 1200): string {
  if (value.length <= maximum) return value;
  const span = Math.max(0, end - start);
  const pad = Math.max(0, Math.floor((maximum - Math.min(span, maximum)) / 2));
  let from = Math.max(0, start - pad);
  const to = Math.min(value.length, from + maximum);
  from = Math.max(0, to - maximum);
  return `${from > 0 ? "…" : ""}${value.slice(from, to).trim()}${to < value.length ? "…" : ""}`;
}
