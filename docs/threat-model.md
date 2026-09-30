# Memory-poisoning threat model

Reviewed: 2026-09-30. Scope: Mnemora v1.31.9 source and built-in presentations.

## Assets and attacker capabilities

Protect the current task, scope isolation, source/lifecycle validity and host
instruction authority. An attacker may control visible content at an explicitly
ingested URL, imported/provider document text, quoted material in user-authored
messages, or text produced by a compromised extraction/summarization model.
That content may persist across sessions and later become relevant to retrieval.
It may claim to be a system instruction, demand a tool call, fabricate a
verification status, or repeatedly advertise itself to manipulate ranking.

The attacker is not assumed to control the local SQLite files, plugin code,
operator confirmations, host configuration or registered presentation adapters.
Those are separate administrative/supply-chain boundaries. Direct host user
messages retain their host-supplied role; this guard concerns stored projections.

## Boundaries and controls

| Boundary | Existing control and remaining risk |
| --- | --- |
| URL/provider input → ingestion | Explicit intake, bounded fetch and URL/redirect network checks; excluded HTML elements and `hidden`/`aria-hidden` attributes are filtered. CSS-hidden content and visible instructions may remain data. Network validation does not certify document meaning. |
| Source → extraction | The provider request uses a fixed system instruction and a separate source message. Source text or source labels cannot set request roles. A model can still output fabricated or poisoned extraction results. |
| Extraction → storage | Canonical scope/provenance, source anchors and verification workflow remain distinct from model confidence. Storing a claim does not establish its truth or authorize its delivery. Automatic after-turn extraction is scoped to eligible user-chat material; it is not blanket extraction of every tool/web response. |
| Storage → automatic context | Admission checks scope, dependencies, verification, delivery governance and final ordinary-recall budget. Rejected/forgotten records cannot be restored by assertions in their body. Manual audit/search may still show withheld content. |
| Eligible text → built-in projection | `sanitizeMemoryForContext` normalizes Unicode, removes hidden controls, neutralizes reserved Mnemora tags and quotes recognized speaker-role lines. Applied to ordinary recall, summary assembly/transcript rewrite and built-in reasoning body/reference fields. Original records remain available for audit. |
| Presentation → host actions | Reference envelopes are non-authoritative. Oversized reasoning presentations fail the existing UTF-8 byte contract without emitting a partial envelope; governed delivery tries smaller candidate prefixes and audits budget withholding if none fits. Canonical identifiers remain complete. Host permissions and action approvals must remain independent of retrieved text. |

Summary assembly and transcript rewrite use system-role messages for host
compatibility; ordinary recall is a system-prompt addition. We therefore do not
claim that memory is absent from a provider's system transport slot. The
structural invariant is that source text cannot create Mnemora-owned envelopes
or provider message roles, and remains inside the generated reference region.
An operator-confirmed procedure is still reference content, not host policy.

## Adversarial regression evidence

`tests/fixtures/memory-poisoning.json` carries inert canaries for nested wrapper
breakout, forged authority and Unicode/hidden-control role spoofing.
`tests/memory-poisoning.test.mjs` checks URL → poisoned extraction → storage →
verification → automatic recall, capture → automatic recall, persisted
summary → database reopen → assembly, model summary → transcript rewrite,
all three built-in reasoning adapters, fixed extraction request roles, raw audit
preservation and oversized-presentation rejection. Sources remain visible as
quoted reference data; the tests do not require deleting suspicious sentences.

Existing trusted-context, correction-impact and reasoning governance regressions
cover rejected evidence, forgotten summary descendants, scope separation and
disabled delivery. URL-ingestion tests cover fetch isolation. These are
deterministic software contracts, not measured prompt-injection resistance or
proof that an extraction model will refuse an embedded command.

## Residual risk and follow-up

Natural-language instructions without recognizable delimiters still reach the
model as reference text. The normalizer is not a comprehensive Unicode
confusable detector, a semantic poison classifier, or a model sandbox. HTML
entity strings retained by existing compaction escaping are readable evidence;
the model may interpret their meaning despite the absence of literal tags.
Custom host adapters must preserve equivalent boundaries independently.

Ranking/embedding manipulation, plausible false facts and multi-session trust
laundering need authorized model-based adversarial evaluation. Measure actual
injected text and downstream behavior under fixed host tool permissions; keep
this separate from task-resume efficacy and synthetic contract counts. Incident
response should disable automatic delivery for the affected scope and use the
review/correction/forgetting flows with their previews and confirmations, then
verify descendants and projections. Do not repair incidents by editing a live
production database or granting retrieved content additional authority.

## Primary guidance

OWASP describes document poisoning across the ingestion-to-generation pipeline
and recommends isolation, context boundaries and downstream enforcement:
[RAG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html).
Provider guidance recommends tool-result transport for third-party content and
layered controls, a stronger transport separation than Mnemora's current host
system-message/prompt-addition interfaces provide:
[Anthropic prompt-injection guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks).
These inform the threat model; the implementation and tests above are the
repository-specific evidence.
