# Recall quality

This page records how automatic recall is measured and what changed in the
1.33 recall rewrite and the 1.34 semantic and relevance work. Most of it measures retrieval: whether the memory injected
into the prompt contains the evidence needed to answer. The
[answer accuracy](#answer-accuracy-v135) section adds an end-to-end run with a
reading model and a judge.

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

No model or network calls are made by the evaluation itself, unless semantic
recall is enabled with `MNEMORA_EVAL_EMBED_MODEL=<ollama model>` (optionally
`MNEMORA_EVAL_EMBED_URL`), which embeds through a local Ollama endpoint.
A range argument (`start:end`) and an output file allow sharded runs:
`npm run eval:longmemeval -- data.json 0:50 out.jsonl`.

Since 1.34 (benchmark id `longmemeval-s-retrieval-v2`) every question also runs
two negative probes on the same database, to measure attachment when the
answer is absent:

- **foreign question**: the question of another test case
  (`all[(i + 167) % n]`), whose evidence is not in this history;
- **off-topic prompt**: one of 14 fixed task prompts (coding, arithmetic,
  translation, greetings).

The reported rate is the share of probes for which anything was attached.

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

### 1.34

| Configuration | Session hit | Turn hit | Preference (session) | Foreign question attached | Off-topic attached |
|---|---|---|---|---|---|
| 1.33.0 (500) | 93.8% | 83.2% | 56.7% | 90.6% | — |
| 1.34 lexical, default (500) | 93.6% | 82.6% | 53.3% | 90.6% | 78.4% |
| 1.34 lexical, `minQueryMatch: 0.15` (500) ² | 92.6% | 82.3% | 53.3% | 81.8% | 71.6% |
| 1.34 lexical, 60-question subset ¹ | 72.4% | 65.5% | 53.3% | 85.0% | 75.0% |
| 1.34 with `all-minilm`, 60-question subset ¹ | 82.8% | 70.7% | 73.3% | 66.7% | 33.3% |

¹ All 30 preference questions plus 30 random others (fixed seed).
² Measured with an earlier build whose ranking also used stemmed matching.

On the subset, the 28 answerable non-preference questions score 92.9% session
hit and 82.1% turn hit in both lexical and semantic runs; the gain is entirely
in preference questions (session 53.3% → 73.3%, turn 50.0% → 60.0%). Mean
attached tokens fall from 612 to 454 because fewer unrelated records pass.
No answerable question lost its evidence; the three answerable questions with
nothing attached were also misses lexically.

Findings:

- **A lexical floor alone is a poor trade.** On lexical evidence only, a 0.15
  floor removed about 9 points of foreign-question attachment at a cost of
  about 1 point of session hit. Foreign questions in LongMemEval share
  vocabulary with the history (same users, same topics), so word overlap
  cannot tell them apart. The floor therefore defaults to 0 without
  embeddings.
- **Semantic evidence is the real lever.** With embeddings, a lexical hit must
  also be among the prompt's nearest embedded records (cosine at least
  `gateSimilarity`, default 0.2; since 1.36 this gates the packet, not each
  record, see below), and a record that shares no word with the
  prompt is attached at cosine at least `minSimilarity` (default 0.45).
  Preference questions are phrased indirectly ("any tips for…"), and semantic
  matching is what finds them.
- **Thresholds are model-specific.** Best-match cosine quartiles with
  `all-minilm` were 0.39 / 0.51 / 0.62 for the question's own evidence,
  0.25 / 0.31 / 0.36 for foreign questions and 0.19 / 0.26 / 0.31 for off-topic
  prompts. Other models have other distributions; recalibrate with this script.
- **Stemming stays out of ranking.** Stemmed term coverage in the ranking
  signal lowered session hit by 0.8 points and raised foreign-question
  attachment by 3 points, so ranking uses exact words; the floor and the
  knowledge-update link use stems.
- **Knowledge updates.** Earlier records on the same topic now carry
  `newer_related`. The latest answer session is attached for 98.6% of
  knowledge-update questions. The annotation uses a little budget: in 3 of 470
  questions one fewer record fitted, which accounts for the 0.6-point turn-hit
  difference from 1.33.
- **Chinese compound words.** Adjacent single Han characters left by word
  segmentation are joined into bigrams, so a prompt such as "帮我订餐" matches
  "订餐" in history; previously such prompts could attach nothing.

Fixed regression probes for these cases (Chinese under noise, a fact deep in a
long message, injected role lines, cross-agent isolation, knowledge updates and
an unrelated prompt) run in `scripts/benchmark-recall-probes.mjs` as part of
`npm run verify`.

## Answer accuracy (v1.35)

`scripts/evaluate-longmemeval-qa.mjs` (`npm run eval:longmemeval-qa`) runs
LongMemEval_S end to end. Each question is answered three ways by the same
reading model, which sees only the question, the question date and the
attached history:

- **none**: no history.
- **bm25**: the same-budget SQLite FTS5 baseline (800 tokens, 8 items, whole
  messages, speaker and time per item).
- **Mnemora**: the `systemPromptAddition` from `assemble()`, README
  configuration, lexical only (no embedding model).

Sessions are ingested with their dataset timestamps, and each question runs
with the clock set to its question date. A judge grades each answer with the
official LongMemEval prompts per question type. Reader and judge:
`mimo-v2.6-pro`, thinking disabled, temperature 0. The reader prompt is
LongMemEval's generation prompt plus "Answer concisely. If the history does
not contain the information needed, say so." Contexts are built first without
any API call; the answer phase is resumable.

| Question type | n | none | bm25 | Mnemora before | Mnemora v1.35 |
|---|---:|---:|---:|---:|---:|
| **All** | 500 | 7.6% | 67.8% | 59.0% | **72.6%** |
| single-session-user | 64 | 0% | 90.6% | 87.5% | 92.2% |
| single-session-assistant | 56 | 12.5% | 91.1% | 51.8% | 91.1% |
| single-session-preference | 30 | 0% | 40.0% | 43.3% | 43.3% |
| multi-session | 121 | 0% | 41.3% | 33.1% | 48.8% |
| temporal-reasoning | 127 | 0.8% | 63.0% | 54.3% | 68.5% |
| knowledge-update | 72 | 0% | 83.3% | 84.7% | 90.3% |
| abstention | 30 | 100% | 93.3% | 90.0% | 96.7% |
| Mean context tokens | | 0 | 774 | 543 | 672 |

"Before" is main after the v1.35 timestamp change and before the fixes below;
the none and bm25 arms are from the same run. The v1.35 column is one clean
rerun of the Mnemora arm, all 500 questions, on contexts built by the final
code. An earlier v1.35 build (before the multi-session work below) scored
70.6% overall and 42.1% on multi-session.

Reading of the numbers:

- Mnemora is 4.8 points above the bm25 baseline overall (72.6% vs 67.8%)
  with 13% fewer context tokens, and at or above it on every question type.
  At n=500 a gap under about 4 points is within noise; per-type gaps of one
  or two questions are noise too. Rerunning identical contexts moved single
  types by one or two questions.
- It is clearly ahead on knowledge updates (`newer_related`), temporal
  reasoning and multi-session questions.
- Preference questions (n=30) are low for both arms and noisy.
- Multi-session questions are still the weakest type (48.8%). Their
  evidence is on average 2.7 user turns in different sessions, and many of
  those turns share no word with the question ("doctors" vs "my
  dermatologist"), which word matching cannot find.
- One reader call in an intermediate run was refused by the provider's
  safety filter. The script now treats such a refusal as a failed call and
  leaves the question for a rerun; the final run had none.
- The cost was about 6,400 API calls (first run 3,000, two full Mnemora
  reruns of 1,000 each, and targeted reruns of changed questions while
  iterating), about 3.1M prompt and 0.15M completion tokens.

The run found these retrieval problems, all fixed in v1.35:

1. **Freshness gated admission.** The 0.35 admission floor applied to a score
   that includes freshness, so a record more than about a year old that
   answered the question could be dropped. Freshness now only ranks.
2. **Length gated admission.** Excerpts longer than 500 characters were
   down-weighted by up to 0.47 before the same floor, so long assistant
   answers rarely passed it. Length now only ranks.
3. **No speaker.** Recalled turns did not say who spoke, so the reader could
   not tell "you recommended" from "I asked". Conversation events now carry
   `role=user|assistant`.
4. **Repeated citations.** Each item repeated its ref as `provenance_refs`
   and `source` (about 60 tokens per item). The ref is now written once;
   `provenance_refs` appears only when it adds another record.
5. **Wrapper not budgeted.** Retrieval filled the budget without the packet
   wrapper, so final packing dropped the last admitted record. The wrapper is
   now charged during retrieval.

Prompts that look back at what the assistant said get their own handling.
They are recognised by past tense or an explicit look-back: "what did you
recommend", "our previous conversation", "you could remind me",
"你之前推荐", "你说过". A new request such as "can you recommend a hotel?" does
not count. For these prompts:

- The assistant reply that followed each of the three best-matching user
  turns is attached (`reply_to_match`). The question usually shares more
  words with the prompt than the answer does.
- Assistant turns are not demoted, are ranked above the user's question, and
  are excerpted up to 2,400 characters instead of 1,180. A long reply is
  excerpted at the window with the most rarity-weighted query terms.
- A long assistant turn that does not fit is shortened to the remaining
  budget instead of skipped. Applied to every prompt, this cost
  multi-session answers, so it stays limited to these prompts.

Multi-session work (aggregate prompts and the header):

- **Compact header.** The per-record header was a third of every packet
  (216 characters on average). A conversation turn's kind is in its ref, and
  its authority and confidence follow from who spoke, so those three fields
  are written only when they differ from the default (`role=user`:
  `user_explicit`, 1.00; `role=assistant`: `source_linked`, 0.80).
- **Aggregate prompts** ("how many", "in total", "the most", "一共", "多少")
  admit records from a score of 0.25 instead of 0.35. Each fact of a count
  sits in one sentence of a long turn and matches weakly. Evidence-turn
  coverage on multi-session rose from 60.4% to 64.1%, and abstention
  questions gained about 25 tokens of attached context with no change in
  abstention accuracy. Floors of 0.20 and 0.15 added nothing further.
  Assistant turns rank at 0.85 for these prompts, since the facts asked
  about are the user's own.
- Tried and dropped: shorter excerpts for aggregate prompts (cut the
  sentence that held the fact; coverage fell), and one-record-per-session
  ordering (more distinct sessions, but they were the wrong ones).
- **Semantic recall, as gated in 1.35, did not help here.** On 99
  answerable multi-session questions with `all-minilm`, evidence-turn
  coverage was 54.2% semantic vs 59.0% lexical; the semantic gate dropped
  lexical hits that held evidence. 1.36 changes the gate (next section).

## Semantic gate on the packet (1.36)

In 1.34 and 1.35, with embeddings on, every lexical hit outside the prompt's
semantic neighbourhood (the nearest embedded records above
`gateSimilarity`) was dropped, and a 0.15 term-match floor applied to each
record. That is what made foreign and off-topic prompts attach less, but it
also dropped evidence: a fact asked about in aggregate ("how many doctors
did I visit") often sits in a turn the embedding places far from the prompt.

Since 1.36 the neighbourhood and the 0.15 floor decide whether memory is
attached at all. If at least one record passes them (or is semantically
close, or carries an exact identifier), every lexical hit is judged on its
own words, as without embeddings; otherwise nothing is attached. Simply
dropping the gate was measured too: it recalled as much, but attached memory
for 100% of foreign and 90% of off-topic prompts.

Measured with `all-minilm`, 800-token budget. Multi-session (121 answerable
and 12 abstention questions), end-to-end QA with the same reader and judge
as above:

| | bm25 | Lexical | Semantic, record gate (1.35) | Semantic, packet gate (1.36) |
|---|---:|---:|---:|---:|
| Multi-session accuracy | 41.3% | 48.8% | 47.9% | **56.2%** |
| Abstention accuracy (n=12) | 83.3% | 91.7% | 100% | 100% |
| Evidence-turn coverage | 52.6% | 64.1% | 57.9% | 66.3% |
| Mean context tokens | 772 | 697 | 550 | 686 |

Retrieval eval (`npm run eval:longmemeval`) on the 163 questions with indices
70–232 (multi-session and preference), with a borrowed foreign question and
an off-topic prompt per question:

| | Lexical | Record gate | Packet gate | No gate |
|---|---:|---:|---:|---:|
| Session hit, answerable | 91.4% | 91.4% | 93.4% | 95.4% |
| Foreign question attaches memory | 100% | 55.2% | 55.2% | 100% |
| Off-topic prompt attaches memory | 90.8% | 33.1% | 33.1% | 90.2% |

On a sample of the other types (35 single-session-user, 32
single-session-assistant, 50 temporal-reasoning and 40 knowledge-update
questions), the packet gate's evidence-turn hits were equal to or above the
record gate on every type (user 31 vs 29, assistant 26 vs 26, temporal 46 vs
46, knowledge update 40 vs 40), and foreign and off-topic attachment was
identical (60.5% and 35.7%). Lexical recall is still slightly ahead on
single-session turns (user 32, assistant 28, temporal 47): turning
embeddings on remains a trade of a little single-session recall for
precision and for indirectly phrased questions.

The evaluation embedding service cached vectors by text, so repeated runs
over the same histories only embedded the prompts.

## Chinese and multilingual calibration (1.36)

Semantic thresholds are cosine values, and cosine distributions differ a lot
between models. Calibration used two community Chinese translations of
LongMemEval_S ([longmemeval-zh](https://github.com/Sanderhoff-alt/longmemeval-zh),
MIT): 48 questions translated by an LLM (8 per type) for calibration, and 48
other answerable questions from the full machine translation (Argos) for
validation. `npm run eval:calibrate-semantic` embeds each history the way
Mnemora does and records the best cosine of three prompts: the question
against its own evidence turns, a borrowed foreign question, and an
off-topic prompt (Chinese prompts for Chinese data).

Best-match cosine, 25th / 50th / 75th percentile:

| Model, data | Evidence | Foreign question | Off-topic | Evidence rank, median |
|---|---|---|---|---:|
| `all-minilm`, English (same 48) | 0.35 / 0.47 / 0.57 | 0.31 / 0.36 / 0.42 | 0.24 / 0.29 / 0.36 | 3 |
| `all-minilm`, Chinese | 0.58 / 0.68 / 0.75 | 0.76 / 0.78 / 0.82 | 0.71 / 0.75 / 0.84 | 42 |
| `paraphrase-multilingual-MiniLM-L12-v2`, Chinese | 0.49 / 0.61 / 0.70 | 0.43 / 0.49 / 0.55 | 0.37 / 0.45 / 0.50 | 1 |
| `bge-small-zh-v1.5`, Chinese | 0.53 / 0.61 / 0.69 | 0.52 / 0.56 / 0.59 | 0.50 / 0.54 / 0.56 | 2 |
| `paraphrase-multilingual` (mpnet), Chinese, 24 questions | 0.58 / 0.68 / 0.73 | 0.52 / 0.55 / 0.58 | 0.45 / 0.50 / 0.54 | 1 |

- The English model is meaningless on Chinese: unrelated prompts score above
  the evidence. Prompts in non-Latin script now skip semantic recall with it
  (an English-only flag in the model table).
- Both Chinese-capable models rank the evidence first or second, but on a
  higher baseline: at the English default of 0.45, two thirds of foreign
  questions (multilingual MiniLM) or nearly all (bge) pass `minSimilarity`.
  At 0.6, foreign questions pass for 12% (multilingual MiniLM) and 23% (bge)
  against 17% for English at 0.45, and 54% and 56% of evidence is above the
  threshold against 52% for English.
- The final pairs were chosen on the retrieval eval, to match the foreign
  and off-topic attachment of English with `all-minilm` (55% and 33% on
  indices 70–232): multilingual MiniLM needed 0.65 for that, bge 0.6.

Retrieval eval, 800-token budget (calibration set / validation set):

| | Session hit | Evidence-turn hit | Foreign attaches | Off-topic attaches |
|---|---|---|---|---|
| Lexical only | 93.8% / 91.7% | 72.9% / 70.8% | 97.9% / 95.8% | 81.2% / 77.1% |
| `all-minilm`, 0.45 / 0.2, before 1.36 | 93.8% / – | 68.8% / – | 95.8% / – | 100% / – |
| `all-minilm`, 1.36 (skips Chinese prompts) | 93.8% / – | 72.9% / – | 97.9% / – | 81.2% / – |
| multilingual MiniLM, 0.45 / 0.2 | 97.9% / 95.8% | 85.4% / 77.1% | 81.2% / 85.4% | 58.3% / 54.2% |
| multilingual MiniLM, **0.65 / 0.3** | 93.8% / 91.7% | 79.2% / 75.0% | 56.2% / 50.0% | 31.2% / 27.1% |
| `bge-small-zh-v1.5`, 0.45 / 0.2 | 100% / 95.8% | 87.5% / 79.2% | 95.8% / 97.9% | 87.5% / 89.6% |
| `bge-small-zh-v1.5`, **0.6 / 0.45** | 97.9% / 95.8% | 83.3% / 79.2% | 56.2% / 58.3% | 27.1% / 31.2% |

The calibrated pairs (bold) are now the defaults for those models when the
thresholds are not set. On the validation set they hold: bge keeps all of
its recall while foreign and off-topic attachment fall from 98% and 90% to
58% and 31%. Other grid points on the calibration set, multilingual MiniLM:
0.6 / 0.3 gave 79.2% evidence-turn hit with 56.2% / 37.5% attachment, and
0.6 / 0.4 gave 75.0% with 41.7% / 20.8%; bge 0.65 / 0.5 gave 72.9% with
41.7% / 20.8%.

`paraphrase-multilingual` (Ollama's mpnet-base-v2) embeds about four times
slower on CPU and was calibrated on 24 of the questions only, without the
validation set. On those 24, with the same retrieval eval: lexical 75.0%
evidence-turn hit with 100% / 87.5% foreign / off-topic attachment;
multilingual MiniLM 87.5% with 50.0% / 37.5%; bge 83.3% with 62.5% / 37.5%;
mpnet at **0.65 / 0.35** 83.3% with 50.0% / 33.3% (0.6 / 0.35 gave the same
recall with 54.2% / 33.3%; 0.65 / 0.3 87.5% with 54.2% / 45.8%). Its pair is
provisional.

Limits: 48 questions per set (one question is about 2 points); the
validation questions are machine translated and read less naturally; no
end-to-end QA run in Chinese yet; `bge-m3`, the most common multilingual
model on Ollama, was too slow to embed on the evaluation machine (CPU only)
and is not calibrated.

The recognition patterns were tuned on LongMemEval_S. They match 54 of its
56 assistant questions and none of the other 444, but they are English and
Chinese phrasings only and may miss other wordings.

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

- **Abstention.** When the answer is not in history, recall still attaches the
  closest records for all 30 abstention questions, with or without
  embeddings: they are on the same topic by construction. The reading model
  must recognise that the attached memory does not answer the question.
- **Preference questions** without embeddings still trail bm25 (53.3% vs
  70.0%).
- **Semantic results are a 60-question sample** with one English model.
  Chinese and mixed-language history need a multilingual model, which has not
  been calibrated here.
- The retrieval evaluation does not enable LLM extraction or summaries. The
  answer-accuracy run uses one reading model and one judge; another model
  may rank the arms differently.
- LongMemEval_S favours lexical retrieval; the bm25 baseline is a floor to
  beat, not a target.
