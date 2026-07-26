# General Task Contract

Use for simple Cursor delegations (UI tweaks, mechanical edits, bounded fixes) via `cursor-companion task` (default mode `simple`).

## Parent

1. Resolve the absolute target code directory (`--workspace`).
2. Write a narrow prompt: goal, done criteria, constraints, out-of-scope.
3. Send a visible parent-conversation update immediately before the blocking
   tool call. Say that Cursor is starting, summarize the delegated task, and
   state the configured maximum wait.
4. Run **one** blocking shell:

```bash
node "$COMPANION" task --workspace <abs> [--add-dir <abs>]... \
  [--sandbox enabled|disabled] -- "<prompt>"
```

5. Set tool `timeout_ms` ≥ companion foreground ceiling (default 3h). Do not poll.
6. Report companion/agent stdout to the user. Do not re-implement the task locally on failure unless the user asks.

For a follow-up on the same goal, pass the prior job explicitly and provide only
the incremental context:

```bash
node "$COMPANION" task --workspace <same-abs> \
  --resume-job <prior-job-id-or-unique-prefix> -- "<incremental prompt>"
```

Resume creates a new job and process, requires matching workspace roots,
sandbox, model, and read-only state, and fails if Cursor does not restore the
expected session.

## Defaults

- Write-capable (`--force` under the hood) unless `--read-only`
- Sandboxed by default; use repeated `--add-dir` for cross-repository work
- Unrestricted host access only when the caller explicitly passes `--sandbox disabled`
- Model unset unless user/config/env specifies one
- No git commit/push/reset by the Worker unless the user explicitly requested that in the prompt (still prefer not to)

## Background

```bash
node "$COMPANION" task --workspace <abs> --background -- "<prompt>"
node "$COMPANION" status --workspace <abs>
node "$COMPANION" result --workspace <abs>
```

Use background only when the user asks or the task is clearly long-running.
Concurrent jobs are supported, including in one workspace. Preserve each job
ID; when more than one job is active, cancellation requires an explicit ID.
