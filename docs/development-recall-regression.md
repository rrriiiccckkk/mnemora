# Explicit task identifier recall regression

Observed after installation of 1.32.7 during a fresh-session project recall check.
The operational project journal retained all prior events, but the model returned
the earlier 1.32.6 release commit for a question about RELEASE_V1327. This was a
retrieval failure, not a reported loss of stored events.

## Diagnosis

A bounded inspection of the authorized project database found the correct
1.32.7 completion in storage. At the configured 1500-token budget it was omitted
from the packet, while shorter generic historical records remained. At 8000
tokens the completion was present. This larger diagnostic budget was not applied
to either the daily Gateway or the persistent project configuration.

Long conversation records were down-weighted independently of exact task
identifier relevance. Journal substring search was case-sensitive even though
lexical expansion lowercases terms. A first fix passed local retrieval checks,
but an installed-host-shaped regression exposed an additional problem: MMR
could move the task completion behind generic history, and final packet trimming
then dropped the task evidence.

## Focused correction

- Journal search performs case-insensitive ASCII literal matching within the
  existing exact scope and bounded limits.
- Safe explicit technical identifiers exempt matching conversation records from
  the length-only penalty. Secret-like labels remain excluded from this signal.
- Automatic selection diversifies exact task matches before generic matches,
  preserving their priority through final packet packing. Authority/confidence
  are not changed and ordinary admission remains in force.

Three synthetic retrieval regressions cover detailed completion records competing
with short history, lowercase task identifiers, foreign scopes, identifier-prefix
lookalikes, confidence floors and secret labels. A selection regression checks
that task priority survives diversification without changing candidate scores.
The original failing regression failed before the patch and passed afterward.

## End-to-end evidence

`node scripts/test-openclaw-host.mjs --dogfood --task-recall` passed with the
installed OpenClaw 2026.9.8 host and real stateless daily model inference. Its
independent fixture contains only synthetic release notes. Both fresh sessions
identified CURRENT_COMMIT_42; the second used a lowercase task identifier after
Gateway restart. Model requests retained the completion within the 1500-token
limit and excluded FOREIGN_COMMIT_42. Journal capture and restart ID preservation
also passed. The parent removed its native fixture after worker exit.

The earlier failing host check correctly withheld a guessed commit; its observed
failure led to the final selection fix. Private bounded diagnostic reports remain
in ignored local directories. No daily configuration, plugin installation,
reasoning delivery policy or daily memory database was changed.

## Final validation and installed runtime

Targeted checks passed all 35 tests. Full verification passed 1084 tests with
zero failures and one Windows-only ACL check skipped on macOS, plus all 13 script
benchmarks, 17 task-resume checks and plugin/release consistency gates.

A concise verified release checkpoint was written through the existing project
memory entry. A new session on the installed 1.32.7 runtime then correctly recalled
1.32.7 and its final commit, 0912e4a, instead of historical 1.32.6. This checkpoint
allows the current trial to continue; it does not deploy the source correction.
The source correction is included in v1.32.8; upgrading the installed plugin is
a separate deployment step.
