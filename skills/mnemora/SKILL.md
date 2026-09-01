---
name: mnemora
description: Safely inspect, explain, and configure Mnemora evidence-first memory, ContextEngine, retrieval, and governed cognition.
---

# Mnemora operator guide

Use Mnemora as the local, evidence-first memory authority. Keep source
citations, scope boundaries, and preview/confirm workflows intact. Do not use
this skill to read another plugin's private database or to invent facts.

## Configuration requests

Use this skill when the user asks what a Mnemora setting does, wants a setup
review, or asks for a configuration change. Read
[configuration.md](references/configuration.md) before proposing a config
change. It captures the current public configuration contract and the
dependencies that are easy to miss.

Start from the active host configuration and any read-only Mnemora status that
is available. Do not infer an enabled feature from an installed plugin, an
existing database, or a command-line default. Redact API keys, tokens, local
workspace paths, and session identifiers from any summary.

Make the smallest configuration patch that meets the stated goal. State which
behavior becomes active, what remains disabled, and how to verify the result.
Never select the host ContextEngine slot, remove another memory plugin, enable
model-backed work, or change a scope without the user's explicit request.

Configuration is not a substitute for review: `shadowMode` is telemetry on
some services, not a universal dry-run. In particular,
`unifiedRetrieval.shadowMode` records redacted metrics **after** a normal
automatic attachment attempt. Keep `unifiedRetrieval.enabled` false when the
user wants observation with no prompt attachment.

When the user requests an actual edit, modify only the Mnemora entry and the
explicitly requested host slot. Validate against the packaged schema; preserve
unknown host-level settings and do not replace the surrounding configuration
object. A config proposal, explanation, or status report is read-only and
does not authorize an edit.

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
