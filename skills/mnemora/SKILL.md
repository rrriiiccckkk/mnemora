---
name: mnemora
description: Safely operate Mnemora evidence-first memory, canonical corpus, and context diagnostics.
---

# Mnemora operator guide

Use Mnemora as the local, evidence-first memory authority. Keep source
citations, scope boundaries, and preview/confirm workflows intact. Do not use
this skill to read another plugin's private database or to invent facts.

## Daily operations

- Use `/mnemora status` for a read-only runtime summary.
- Use `/mnemora doctor` to see whether the optional canonical corpus is ready.
- Use `kg_memory` with `corpus_status` or `corpus_search` for source-citable
  workspace material. Corpus search is not automatic prompt injection.
- When an opaque `MNEMORA_TOOL_RESULT` reference appears in an assembled
  context, use `kg_memory` `artifact_read` with its exact ID and same scope.
  Keep each read bounded; never infer a host path or try to reopen a truncated
  tool result from the filesystem.
- Use existing `kg_memory` lifecycle, import, and graph review operations for
  governed changes. Respect their preview/confirm requirement.

## Canonical corpus boundary

The corpus is disabled by default and only reads the configured local
workspace. It keeps a separate cache of bounded chunks from `MEMORY.md`,
`memory/**/*.md`, and explicit optional session/dreaming directories. It never
creates graph observations, memories, beliefs, or prompt attachments.

If `workspaceBoundary.userMdExclusive.enabled` is true, `USER.md` remains an
externally managed canonical profile file: never ingest or copy it into the
corpus. Do not write it from Mnemora.

Keep configuration changes explicit and reversible. Before a high-impact
operation, inspect the preview, retain the returned preview hash, and pass the
required confirmation only after review.
