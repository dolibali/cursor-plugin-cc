---
description: Show active and recent Cursor companion jobs for this repository
argument-hint: "[job-id] [--all] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" status --workspace "$PWD" $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output compactly.
- Preserve actionable fields including job ID, status, model, workspace, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
