# Recall quality

This page records how automatic recall is measured and what changed in the
1.33 recall rewrite. It measures retrieval only: whether the memory injected
into the prompt contains the evidence needed to answer. It does not measure
end-to-end answer accuracy, which also depends on the reading model.

## Method

`scripts/evaluate-longmemeval.mjs` runs the real automatic path on
[LongMemEval_S](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
(500 questions, about 50 sessions and 115K tokens of history each):

1. A fresh database receives every haystack session through
   `MnemoraContextEngine.ingestBatch()` with the README configuration
   (`conversationJournal`, `contextEngine`, `episodicMemory`,
   `unifiedRetrieval` with `tokenBudget: 800`, `maxItems: 8`).
2. `assemble()` is called with the question as the prompt.
3. Rendered `provenance_refs` are mapped back to dataset sessions and turns.
4. A same-budget SQLite FTS5 bm25 baseline runs over the identical messages
   (800 tokens, 20 tokens overhead per item, at most 8 items).

Metrics over the 470 answerable questions:

- **session hit**: at least one injected record comes from an answer session;
- **turn hit**: at least one injected record is a turn labelled `has_answer`;
- **empty**: nothing was injected.

```sh
curl -L -o /tmp/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
npm run build
npm run eval:longmemeval -- /tmp/longmemeval_s_cleaned.json
```

No model or network calls are made by the evaluation itself.

## Results

| Build | Session hit | Turn hit | Empty | Mean injected tokens |
|---|---|---|---|---|
| 1.32.18 | 9.8% | 5.5% | 24.7% | 329 |
| 1.33 recall rewrite | **93.8%** | **83.2%** | 0.2% | 616 |
| bm25 baseline (same budget) | 94.9% | 81.5% | 0% | 776 |

A random draw with the same number of items as 1.32.18 injected scores 7.8%
session hit, so the old ranking was close to random.

By question type (session hit, 1.33 / bm25): knowledge-update 100% / 100%,
multi-session 95.9% / 96.7%, single-session-assistant 100% / 100%,
single-session-preference 56.7% / 70.0%, single-session-user 100% / 100%,
temporal-reasoning 91.3% / 91.3%.

`assemble()` median latency on these databases: 47 ms before, 16 ms after.

## What changed

- **Ranking uses the query.** Candidate scores previously used a constant
  relevance base of 1, so ranking depended only on role, freshness and source
  authority, and ties fell back to UUID order. Scores now include bm25
  relevance (journal) and content-term coverage (all kinds).
- **Ranked journal index.** Schema v86 adds a chunked FTS5 index over live
  `normalized_text`, built with Intl word segmentation so Chinese text is
  tokenised into words, plus English and Chinese stopwords. Previously every
  query word, including "how", "is" and "什么", ran as a raw substring match
  and only the newest 40 rows per word were kept.
- **Long messages.** Messages are indexed in overlapping chunks and excerpted
  around the matching chunk. Previously only the first 1200 characters were
  visible, so facts later in a long message were never recalled.
- **Forgetting purges the index.** Triggers delete chunk and FTS rows when an
  event is deleted, tombstoned or redacted; restore rebuilds the index.

## Known limits

- **Abstention.** When the answer is not in history, recall still injects the
  best lexical matches (30/30 abstention questions). A calibrated relevance
  floor is the next step.
- **Preference questions** trail bm25 (56.7% vs 70.0%): they are phrased
  indirectly ("any tips for…") and need semantic matching. Hybrid retrieval
  with local embeddings is the planned remedy.
- **Lexical only.** This evaluation does not enable embeddings, LLM
  extraction or summaries.
- LongMemEval_S favours lexical retrieval; the bm25 baseline is a floor to
  beat, not a target.
