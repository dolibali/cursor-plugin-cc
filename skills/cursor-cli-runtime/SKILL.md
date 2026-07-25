---
name: cursor-cli-runtime
description: >-
  Delegate work to the local Cursor Agent CLI via cursor-companion
  (setup/task/status/result/cancel). Use when the user asks to call Cursor CLI,
  agent/cursor-agent, $cursor-cli-runtime, offload bounded or long-running
  coding/UI/test work to Cursor for speed or quota, or run delegated E2E via
  companion --mode e2e. Prefer companion over hand-rolled agent strings.
---

# Cursor CLI Runtime

Delegate tasks from **Codex** (or other agents) to the local Cursor Agent CLI.

Primary entrypoint is the companion helper — not a long hand-rolled `agent` command, and not deprecated Codex `/prompts:`.

## How to invoke (Codex)

1. `$cursor-cli-runtime` plus the task description
2. `/skills` → select `cursor-cli-runtime`
3. Natural language: "use Cursor to … / delegate to Cursor …"
4. Call companion directly (below)

## Companion path

Prefer:

```bash
COMPANION=$(node -e 'const c=require("fs").readFileSync(require("path").join(require("os").homedir(),".cursor/cursor-companion/config.json"),"utf8"); process.stdout.write(JSON.parse(c).companionScript||"")')
# fallback after install-skills.sh:
# COMPANION="<repo>/scripts/cursor-companion.mjs"
```

If not installed yet, run `./scripts/install-skills.sh` from the repo.

## When to use

- User asks for Cursor CLI / agent / headless delegation
- Bounded medium/low-difficulty edits, repetitive mechanical changes, long-running tests/E2E
- When offloading saves parent-session tokens or quota

Before autonomous delegation, briefly tell the user you will use Cursor and state the **target code directory**.

## Hard rules

### Workspace

`--workspace` must be an **absolute path to the target code directory**. When omitted, companion defaults to `process.cwd()` (still validated). Never use the user home directory, `Desktop`/`Downloads`, or an unrelated default folder. Never omit workspace while starting from the wrong cwd.

### Model

- **Leave `--model` unset by default** (Cursor CLI default / `auto`)
- Override priority: CLI `--model` > env `CURSOR_COMPANION_MODEL` > `~/.cursor/cursor-companion/config.json` `model`
- Set default model: `node "$COMPANION" setup --set-model <slug>`; clear with `--set-model -`
- Do not invent slugs; when unsure run `agent --list-models` (see [models.md](models.md))

### Parent wait (Codex)

Use **one** `shell_command` that invokes companion, with `timeout_ms` ≥ the foreground/Runner ceiling (default **10800000** = 3h).

- Wait until the **process exits**; early completion returns immediately
- **Do not** use short `exec_command` + empty `write_stdin` polling (burns tokens)
- Do not read heartbeats/logs while waiting; after exit read stdout or `result`

### Thin forward

Tighten a narrow prompt → **one** companion `task` → report the result as-is. Do not re-implement the task locally. Do not poll `status` mid-wait unless the user asks about a background job.

### Worker guard

If `CURSOR_DELEGATED_WORKER=1` or `CURSOR_DELEGATION_DEPTH>=1`: this process is already the Worker. Do not nest another `agent` / companion delegation.

## Commands

```bash
node "$COMPANION" setup --json

# Simple task (write-capable by default; workspace defaults to cwd)
node "$COMPANION" task --workspace <abs> -- "<prompt>"
node "$COMPANION" task -- "<prompt>"

# Read-only
node "$COMPANION" task --workspace <abs> --read-only -- "<prompt>"

# Explicit model
node "$COMPANION" task --workspace <abs> --model <slug> -- "<prompt>"

# Background jobs
node "$COMPANION" task --workspace <abs> --background -- "<prompt>"
node "$COMPANION" status --workspace <abs>
node "$COMPANION" result --workspace <abs> [job-id]
node "$COMPANION" cancel --workspace <abs> [job-id]

# E2E / delegated tests (see references)
node "$COMPANION" task --mode e2e \
  --workspace <abs-git> \
  --prompt-file <abs> \
  --artifact-dir <abs-outside-repo> \
  --required-check <id>
```

Simple-task contract: [references/general-task-contract.md](references/general-task-contract.md)  
Delegated-test contract: [references/delegated-test-contract.md](references/delegated-test-contract.md)

## Result handling

- Preserve companion status / exitCode / summary structure
- On failure, do not switch to a local rewrite in the parent agent; report failure and stop
- On setup/auth failure, guide: `node "$COMPANION" setup` and `agent login`

## Safety

- Never echo API keys
- Simple tasks are write-capable by default; use `--read-only` when the user wants read-only
- Always pin the correct `--workspace` (or a correct project cwd)
