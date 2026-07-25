---
description: Cancel an active background Cursor companion job in this repository
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" cancel --workspace "$PWD" $ARGUMENTS`
