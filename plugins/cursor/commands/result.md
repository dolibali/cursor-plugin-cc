---
description: Show the stored final output for a finished Cursor companion job in this repository
argument-hint: "[job-id] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" result --workspace "$PWD" $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- stdout / result payload
- File paths exactly as reported
- Any error messages
- Follow-up commands such as `/cursor:status <id>` and `/cursor:rescue`
