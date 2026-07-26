---
name: cursor-cli-runtime
description: >-
  Delegate work to the local Cursor Agent CLI through cursor-companion
  (setup/task/status/result/cancel). Use whenever the user asks to call Cursor,
  agent/cursor-agent, offload coding or tests, run autonomous delegated E2E, or
  continue a Cursor background job. Prefer this runtime over hand-written
  Cursor CLI commands.
---

# Cursor CLI Runtime

Use the installed companion instead of constructing a direct `agent` command:

```bash
COMPANION=$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");const c=JSON.parse(fs.readFileSync(p.join(os.homedir(),".cursor/cursor-companion/config.json"),"utf8"));process.stdout.write(c.companionScript||"")')
```

If it is not installed, run `./scripts/install-skills.sh` from the plugin
checkout. Run `node "$COMPANION" setup --json` before a foreground delegation
to read availability, login, sandbox support, and the effective
`timeout.timeoutMs`.

## Delegation

Before delegation, state the target directory. Give Cursor a bounded prompt
with the goal, acceptance criteria, constraints, and out-of-scope behavior.

```bash
# Write-capable, sandboxed by default
node "$COMPANION" task --workspace <absolute-root> -- "<prompt>"

# Read-only
node "$COMPANION" task --workspace <absolute-root> --read-only -- "<prompt>"

# Multiple explicit roots
node "$COMPANION" task --workspace <primary> \
  --add-dir <additional> --add-dir <additional> -- "<prompt>"

# Explicit unrestricted host access
node "$COMPANION" task --workspace <absolute-root> \
  --sandbox disabled -- "<prompt>"
```

Use `--sandbox disabled` only when the user explicitly requests unrestricted
access or the task demonstrably requires writes outside every declared root.
Never disable sandbox merely because a task spans repositories; use repeated
`--add-dir`. Sandbox mode must fail closed when unsupported.

Leave `--model` unset in task commands to use the effective selection.
Selection priority is CLI, environment, global config, then `auto`. Fresh
installations store `auto` in the global config. See [models.md](models.md) only
when a specific model is requested.

## Waiting and background jobs

Immediately before every foreground `task` invocation that may block, send the
user a visible progress update in the parent conversation. State that Cursor is
starting, name the delegated task category, and give the configured maximum
wait from `setup --json`, formatted for readability. For example: "Starting
Cursor for isolated GUI validation; this call will wait for completion and may
take up to 4 hours." Send this update before the shell/tool call; companion
stdout is not a substitute. Do not add this announcement for short `status`,
`result`, or `cancel` commands.

For a foreground task, make one blocking companion call. When the shell tool
accepts an execution timeout, set it to the effective `timeoutMs` plus a short
process-cleanup grace; never set it lower than the companion deadline. When
waiting through a persistent terminal session, keep that session open and let
the companion be the only timeout authority. Do not poll stdin or heartbeat
artifacts.

If the host shell has a hard maximum below the effective timeout, start the
task with `--background`, return the job ID, and use explicit `status`,
`result`, or `cancel` commands later. Never shorten the Cursor task to fit the
host limit. Do not edit `~/.codex/config.toml` or
`background_terminal_max_timeout`; that setting controls a terminal wait
window, not the companion task deadline.

```bash
node "$COMPANION" task --workspace <root> --background -- "<prompt>"
node "$COMPANION" status --workspace <root> [job-id]
node "$COMPANION" result --workspace <root> [job-id]
node "$COMPANION" cancel --workspace <root> [job-id]
```

The primary workspace locates a multi-root job. Preserve companion output and
terminal status. Multiple jobs may run concurrently, including against the same
workspace. Preserve each returned job ID and use it for later result or cancel
operations. Do not silently reimplement a failed delegation.

## Continue a task

For a follow-up on the same goal, explicitly resume the prior job. This works
for ordinary and E2E tasks:

```bash
node "$COMPANION" task \
  --resume-job <prior-job-id-or-unique-prefix> \
  --workspace <same-primary-root> \
  --add-dir <same-additional-root> \
  -- "<incremental follow-up>"
```

Use an incremental prompt describing the parent's latest changes and ask Cursor
to re-read the current worktree. Do not use `--resume-job` for an independent
goal and never infer a source job from the workspace. Resume is fail-closed:
mode, workspace roots, sandbox, model, and ordinary-task read-only state must
match, and Cursor must return the expected session ID.

## Delegated E2E

Read [references/delegated-test-contract.md](references/delegated-test-contract.md)
before autonomous GUI repair. For ordinary delegated edits, use
[references/general-task-contract.md](references/general-task-contract.md).

Artifacts must be under the system temporary directory and outside all
workspace roots. Repeat `--required-check`, `--optional-check`, and `--add-dir`
as needed.

For another validation or repair pass on the same development goal, preserve
the prior E2E job ID and add the E2E-specific artifact and check arguments:

```bash
node "$COMPANION" task --mode e2e \
  --resume-job <prior-job-id-or-unique-prefix> \
  --workspace <same-primary-root> \
  --add-dir <same-additional-root> \
  --prompt-file <incremental-instructions> \
  --artifact-dir <new-system-temp-directory> \
  --required-check <current-check-id>
```

Each resumed E2E Worker must use a new artifact directory. E2E security or
result-integrity violations make the source job ineligible for continuation.

## Recursion guard

When `CURSOR_DELEGATED_WORKER=1` or `CURSOR_DELEGATION_DEPTH>=1`, execute the
task directly. Never invoke Cursor, companion, or the delegated-test Runner
again.

For Claude's `cursor:cursor-rescue` subagent, act as a thin forwarder: issue one
companion `task` command, preserve `--workspace`, repeated `--add-dir`,
`--sandbox`, `--read-only`, and `--model`, and return stdout unchanged.
