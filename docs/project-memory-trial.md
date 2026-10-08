# Persistent Mnemora project memory trial

The active local entry is `npm run dev:memory` in the development worktree.
The preserved workspace root also delegates through
`node scripts/project-memory.mjs`. The installed 1.32.6 plugin is used by a
separate on-demand Gateway. Project database/config/state stay under the ignored
`.dogfood/project-mnemora` directory. This is operational project memory, not a
test fixture. The daily Gateway provides stateless inference only.

## Actual task ledger

| Task | Actual work | Recall evidence | Status |
| --- | --- | --- | --- |
| OFG_CONFIG_ISOLATION | Isolated official build/validate environment and config; regression tests; published 1.32.6 after exact-commit Linux/Windows CI | Earlier independent trial retrieved the decision across sessions | Completed before persistent setup; not evidence of persistent entry |
| PROJECT_ENTRY | Added persistent on-demand entry, installed-plugin snapshot, exclusive lock, bounded CLI input, local Codex handoff and development guidance | A separate invocation/fresh session recalled database retention, tool boundary and outstanding full regression without repeating the prior note | Completed locally |
| TASK_IDENTIFIER_RECALL | Diagnosed a stale release response after the 1.32.7 upgrade; fixed task-specific length weighting, case matching and final selection priority | Synthetic reproduction plus real-model host restart/lowercase recall check passed | Full verification passed: 1084 tests passed, one platform skip; included in v1.32.8; installed-runtime upgrade remains separate |

For PROJECT_ENTRY the first process captured two events, exited and released its
lock. The next invocation used the same project database with a fresh session;
the event count rose to four and the model correctly recalled the earlier note.
The model did not claim the outstanding checks had passed. A third invocation successfully captured two additional events (six total),
preserved every earlier event ID, and verified journal IDs again after Gateway
shutdown. Its answer correctly separated the completed first regression from
checks still in progress. A concurrent status
invocation was rejected while the first request held its lock. Root delegation
also returned the existing four events without a model call.

This avoided restating one development background note. No elapsed-time or
monetary saving has been measured. Proxy usage values are synthetic. Assistant
answers are reference material, not independently verified code or test results.

## Continue the trial

Complete 3–5 genuine development tasks before assessing efficiency. For each,
ask a focused question at task start, perform actual code/test work in Codex,
then submit a concise verified-result note. Record missing, wrong or irrelevant
recall and any operations actually avoided. Convert consequential failures into
bounded synthetic regression tests. Do not manufacture tasks or treat repeated
questions about one task as separate completed tasks.

Reasoning delivery remains disabled. Unified recall is enabled with telemetry;
shadow does not suppress ordinary memory attachment. This entry has no code
editing or tool execution capability through the text-only stateless interface.

## Final local validation

Node 24 full verification passed on the final code: 1080 unit tests passed,
zero failed, one Windows-specific ACL case skipped on macOS. All script
benchmarks and the 17 task-resume evaluations passed, as did plugin validation,
smoke, pinned compatibility and version consistency. Eighteen targeted entry
and temporary-directory tests passed. Installed OpenClaw 2026.9.8 synthetic
host integration passed. Three genuine project adviser calls used installed
Mnemora 1.32.6 and the daily stateless xiaomi-coding / mimo-v2.6-pro model,
preserved six events, and released the lock between independent processes.
The final call exercised the new capture/preservation/shutdown assertions.

The workspace-root delegating entry is local-only, preserving the original
older checkout and its changes. Portable implementation and documentation are
committed in the active development worktree. The daily installed plugin and
memory policy are unchanged.

See [task identifier regression evidence](development-recall-regression.md) for the
observed failure, bounded diagnosis and corrected host check.
