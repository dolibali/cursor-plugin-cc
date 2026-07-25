---
description: Check whether the local Cursor Agent CLI is ready
argument-hint: "[--json] [--set-model <slug|->]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If the agent binary is missing, tell the user to install Cursor Agent CLI (`agent` / `cursor-agent`) and ensure it is on PATH.
- If the agent is installed but not authenticated, preserve the guidance to run `agent login`.
- Do not install OpenAI Codex. This plugin delegates to Cursor, not Codex.
