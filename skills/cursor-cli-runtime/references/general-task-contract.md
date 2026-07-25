# General Task Contract

Use for simple Cursor delegations (UI tweaks, mechanical edits, bounded fixes) via `cursor-companion task` (default mode `simple`).

## Parent

1. Resolve the absolute target code directory (`--workspace`).
2. Write a narrow prompt: goal, done criteria, constraints, out-of-scope.
3. Run **one** blocking shell:

```bash
node "$COMPANION" task --workspace <abs> -- "<prompt>"
```

4. Set tool `timeout_ms` ≥ companion foreground ceiling (default 3h). Do not poll.
5. Report companion/agent stdout to the user. Do not re-implement the task locally on failure unless the user asks.

## Defaults

- Write-capable (`--force` under the hood) unless `--read-only`
- Model unset unless user/config/env specifies one
- No git commit/push/reset by the Worker unless the user explicitly requested that in the prompt (still prefer not to)

## Background

```bash
node "$COMPANION" task --workspace <abs> --background -- "<prompt>"
node "$COMPANION" status --workspace <abs>
node "$COMPANION" result --workspace <abs>
```

Use background only when the user asks or the task is clearly long-running.
