# Mnemora development trial — 2026-10-07

Baseline: origin/main `805e3f5`, Mnemora 1.32.5; installed daily host OpenClaw
2026.9.8. Changes live in branch `codex/mnemora-dogfood`; the original detached
checkout and its earlier local changes are preserved.

## Actual repair

The pinned official-plugin gate inherited the caller environment. A child-process
preload sentinel was observed before the repair and absent afterward. Both build
and validate now use one private empty config and state directory with an explicit
environment allowlist. The newer pinned CLI already passed its metadata rejection
check with a malformed outer config; this repair addresses environment coupling,
not a claimed metadata regression. Regression tests cover both isolation and
preservation of the caller config.

## Bounded trial

The independent host used `project:mnemora`, a separate database, unified and
reasoning shadow telemetry, and reasoning delivery disabled. No daily config,
scope or memory database was changed. Public stateless daily Gateway inference
used xiaomi-coding / mimo-v2.6-pro without copying credentials.

The first session recorded the actual OFG_CONFIG_ISOLATION decision. Two initial
journal events survived restart with unchanged IDs. A fresh session received the
decision through retrieval, and the real model correctly recalled the dedicated
config and credential isolation requirements. The independent trial Gateway was stopped after each run; the daily Gateway
remained running. A second successful run verified parent-owned fixture cleanup.
The test root `mnemora-tests-c4Z6t6` was removed after worker exit. Bounded private
reports are retained under `.dogfood/f9cf7b4d-f1c6-4c21-9809-276132795991`;
they contain only this development task. The earlier operational trial remains
in the system temporary `mnemora-dogfood-Vbc6zw` directory.

This validates integration, persistence and cross-session recall. It does not
establish a development-speed improvement, reasoning efficacy or token savings.
The proxy usage values are synthetic and cannot support cost measurements.

## Validation

Node 24.21.0 full verification passed with one build: 1078 unit tests passed,
zero failed; one Windows-only ACL case skipped on macOS. All 13 script benchmark
commands passed, as did 17 task-resume evaluation/comparison/preregistration
tests, plugin validation, smoke, pinned compatibility and release consistency.
Twenty targeted environment/temporary-fixture regressions also passed. Installed
OpenClaw 2026.9.8 synthetic integration and two real-model trials passed.

## Release preparation

Version metadata and a 1.32.6 release draft are prepared. Publication requires
successful Linux and Windows CI on the final release commit. No tag, publication
or replacement of the daily installed plugin has been performed.
