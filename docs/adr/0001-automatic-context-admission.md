# Automatic context has one admission boundary

Status: accepted

Automatic prompt context is admitted through one policy boundary, rather than
being implied by a successful search. The boundary enforces scope, source and
lifecycle validity, claim verification, ReasoningMemory delivery governance,
and the budget of the final rendered envelope. Manual retrieval remains
read-only and may expose withheld records for audit. This deliberately keeps
storage admission separate from prompt delivery, so a rejected claim, a
forgotten summary dependency, or an admitted-but-undeliverable strategy cannot
re-enter the agent context through another collector.
