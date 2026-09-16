# Mnemora

Mnemora is a local-first runtime that preserves evidence-backed memory across
agent sessions. Its automatic context must remain distinct from manual search
and from stored, but not yet trusted, material.

## Language

**Automatic context admission**:
The single decision boundary that determines whether a stored record may enter
an Agent's prompt. It evaluates scope, source and lifecycle validity, evidence
status, delivery governance, and the final rendered budget.
_Avoid_: Recall result, stored memory, search hit

**Manual retrieval**:
A read-only operator or agent lookup that may expose withheld material for
inspection but does not itself authorize prompt injection.
_Avoid_: Automatic context, delivery

**Derived summary**:
A source-linked projection of events or lower-level summaries. It remains
injectable only while every dependency in its evidence graph remains valid.
_Avoid_: Original evidence, independent memory

**Reasoning delivery**:
The governed runtime path that may append an admitted ReasoningMemory strategy
after its configured scope, calibration, readiness, cadence, and circuit rules
have allowed it.
_Avoid_: Strategy storage, ordinary retrieval
