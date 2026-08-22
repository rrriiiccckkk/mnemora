# Session lifecycle

Mnemora owns no legacy `before_prompt_build` or `agent_end` hook. If selected
as OpenClaw's ContextEngine, its documented ContextEngine lifecycle is the only
prompt/capture producer. Without that opt-in, the plugin remains manual-only.

The `/mnemora` command and corpus cache add no capture lifecycle and no prompt
producer. Keep the ContextEngine selection, corpus indexing, and graph/memory
admission as separate decisions.
