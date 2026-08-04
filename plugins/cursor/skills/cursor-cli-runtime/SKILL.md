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

In Codex, the blocking unit is the outer `functions.exec` call, not merely the
Cursor process. If `tools.exec_command` returns a `session_id`, drain that
terminal inside the same JavaScript evaluation. Do not return the session ID to
the parent model and issue later `write_stdin` calls; each such return wakes the
model, rereads context, and spends tokens without advancing the task. The
internal drain loop below is transport handling within one model-visible call,
not parent-level polling:

```javascript
// @exec: {"yield_time_ms": 3610000, "max_output_tokens": 8000}
// Set the pragma above to the effective timeoutMs plus cleanup grace.
let result = await tools.exec_command({
  cmd,
  workdir,
  yield_time_ms: 30000,
  max_output_tokens: 8000,
})
let output = result.output || ""
while (result.session_id !== undefined) {
  result = await tools.write_stdin({
    session_id: result.session_id,
    chars: "",
    yield_time_ms: 300000,
    max_output_tokens: 8000,
  })
  output = `${output}${result.output || ""}`.slice(-64000)
}
text(output)
```

Do not call `yield_control`, emit intermediate output, or wake the parent only
to post elapsed-time updates while this loop is active. The visible update sent
immediately before delegation covers the wait. If the outer tool cannot remain
blocked for the effective deadline, use `--background` from the start instead
of switching to model-visible polling.

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

After any Cursor task finishes, inspect changes introduced by that task before replying. Use the diff and compact task result to decide whether each change is justified; keep reasonable changes, correct or revert unreasonable ones, and run the smallest affected check when the decision changes code.

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

### E2E rerun cost policy

Treat validation and repair passes for one development goal as one runtime
session. A new artifact directory is required for evidence isolation, but it
does not by itself require rebuilding the product, recreating the profile, or
relaunching the application.

- Test, external fixture, locator, or runner-only changes reuse the already
  verified runtime artifact and the existing profile/window. Rerun the
  affected test directly. A fixture bundled into the runtime artifact follows
  the product-bundle rule below.
- Product bundle changes rebuild or reinstall once, then reload the existing
  profile/window. Do not repeat first-run bootstrap or recreate unrelated
  test state.
- Runtime, dependency, or service changes rebuild only the affected artifact
  when the repository runner supports that boundary; relaunch only when the
  loaded process cannot observe the change.
- Before repeating a long command, compare its relevant inputs with the last
  successful invocation. Do not run an identical build or package command when
  those inputs have not changed.
- Batch known repairs before the next expensive GUI pass. A test-only repair
  must not trigger a product rebuild, and a product repair must not trigger a
  fresh profile unless the profile itself is the failure.

This policy changes setup and rerun scope only. It does not shorten the
acceptance flow or interrupt a long-running application/model scenario; the
delegated test still completes the user-visible flow defined by its checks.

## Recursion guard

When `CURSOR_DELEGATED_WORKER=1` or `CURSOR_DELEGATION_DEPTH>=1`, execute the
task directly. Never invoke Cursor, companion, or the delegated-test Runner
again.

For Claude's `cursor:cursor-rescue` subagent, act as a thin forwarder: issue one
companion `task` command, preserve `--workspace`, repeated `--add-dir`,
`--sandbox`, `--read-only`, and `--model`, and return stdout unchanged.
