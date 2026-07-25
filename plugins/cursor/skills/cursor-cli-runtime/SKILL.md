---
name: cursor-cli-runtime
description: Internal helper contract for calling the cursor-companion runtime from Claude Code
user-invocable: false
---

# Cursor Runtime

Use this skill only inside the `cursor:cursor-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task [flags] -- "<prompt>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `agent` / `cursor-agent` strings, or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `cursor:cursor-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to a write-capable Cursor run. Add `--read-only` only when the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- If `--workspace` is omitted, companion uses `process.cwd()`. Never point workspace at the user home directory or Desktop/Downloads.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control. Strip `--wait` before calling `task`. For long-running work preferred in background, pass `--background` through to companion `task`.
- If the forwarded request includes `--model`, `--read-only`, or `--workspace`, pass them through to `task`.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Cursor cannot be invoked, return nothing.
