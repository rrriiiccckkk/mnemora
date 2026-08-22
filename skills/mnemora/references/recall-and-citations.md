# Recall and citations

`kg_memory { operation: "corpus_search", query: "..." }` returns only bounded
logical citations such as `memory/preferences.md:L4-L18`, a source category, a
snippet, and a `mnemora://` context reference. It never returns the configured
workspace root.

Corpus results are reference material, not graph evidence. They do not enter
automatic recall, confidence scoring, belief formation, extraction, or prompt
injection. Treat citations as material to inspect and reason about, not as
trusted user facts without the normal evidence/admission path.
