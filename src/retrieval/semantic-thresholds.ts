/**
 * Semantic recall thresholds by embedding model.
 *
 * Cosine distributions differ a lot between models: on the same Chinese
 * history the best match of an unrelated prompt is about 0.29 with an English
 * model on English text, 0.45 with paraphrase-multilingual-MiniLM and 0.54
 * with bge-small-zh. One pair of thresholds cannot fit them all, so models
 * calibrated with `scripts/calibrate-semantic.mjs` carry their own pair
 * (docs/recall-quality.md, "Chinese and multilingual calibration"). Values the
 * operator sets always win; unknown models get the all-MiniLM pair.
 */
export interface SemanticThresholds {
  /** Cosine at which a record that shares no word with the prompt is attached. */
  minSimilarity: number;
  /** Cosine floor of the semantic neighbourhood that opens the packet. */
  gateSimilarity: number;
  /** Vectors carry no meaning for text outside English; skip semantic recall for it. */
  englishOnly: boolean;
  /** Whether the pair comes from a calibration of this model. */
  calibrated: boolean;
}

interface CalibratedModel { names: readonly string[]; minSimilarity: number; gateSimilarity: number; englishOnly?: boolean }

const CALIBRATED: readonly CalibratedModel[] = [
  // LongMemEval_S, English: evidence / foreign / off-topic best-match medians 0.47 / 0.36 / 0.29.
  // On Chinese text it ranks evidence 42nd at the median and attaches memory to every off-topic prompt.
  { names: ["all-minilm", "all-minilm-l6-v2"], minSimilarity: .45, gateSimilarity: .2, englishOnly: true },
  // Chinese LongMemEval (48 LLM-translated questions): medians 0.61 / 0.49 / 0.45.
  { names: ["paraphrase-multilingual-minilm-l12-v2", "multilingual-minilm"], minSimilarity: .65, gateSimilarity: .3 },
  // Chinese LongMemEval: medians 0.61 / 0.56 / 0.54.
  { names: ["bge-small-zh-v1.5", "bge-small-zh"], minSimilarity: .6, gateSimilarity: .45 },
  // Ollama `paraphrase-multilingual` (mpnet-base-v2), 24 of the Chinese questions: medians 0.68 / 0.55 / 0.50. Provisional.
  { names: ["paraphrase-multilingual", "paraphrase-multilingual-mpnet-base-v2"], minSimilarity: .65, gateSimilarity: .35 },
];

const DEFAULT: CalibratedModel = CALIBRATED[0]!;

/** Lower-cased model name without an Ollama `:tag` or a `vendor/` prefix. */
export function embeddingModelKey(model: string | undefined): string {
  const name = String(model ?? "").trim().toLowerCase();
  const base = name.slice(name.lastIndexOf("/") + 1);
  const colon = base.indexOf(":");
  return colon > 0 ? base.slice(0, colon) : base;
}

export function semanticThresholds(model: string | undefined, explicit: { minSimilarity?: number; gateSimilarity?: number } = {}): SemanticThresholds {
  const key = embeddingModelKey(model);
  const known = CALIBRATED.find(entry => entry.names.includes(key));
  const base = known ?? DEFAULT;
  return {
    minSimilarity: Number.isFinite(explicit.minSimilarity) ? explicit.minSimilarity! : base.minSimilarity,
    gateSimilarity: Number.isFinite(explicit.gateSimilarity) ? explicit.gateSimilarity! : base.gateSimilarity,
    englishOnly: known?.englishOnly === true,
    calibrated: known !== undefined,
  };
}

const NON_LATIN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Devanagari}]/u;

/** Whether an English-only model should sit this prompt out. */
export function outsideModelLanguage(thresholds: Pick<SemanticThresholds, "englishOnly">, text: string): boolean {
  return thresholds.englishOnly && NON_LATIN.test(text);
}
