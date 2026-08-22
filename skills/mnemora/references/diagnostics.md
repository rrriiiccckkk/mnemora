# Diagnostics

Use `/mnemora doctor` first. `corpus configuration_required` means corpus is
enabled but lacks a readable explicit `workspaceRoot`; it does not fall back to
home, OpenClaw, or another plugin's storage.

Use `/mnemora corpus sync` for an explicit bounded refresh. The response reports
aggregate indexed, unchanged, removed, and skipped counts only. A skipped file
may be too large, unreadable, outside the root, a link, or excluded by the
`USER.md` boundary. Do not weaken limits merely to make diagnostics quiet.
