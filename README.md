# cursor-plugin-cc

Delegate work to the local [Cursor Agent CLI](https://cursor.com) (`agent` / `cursor-agent`) from **Codex** (skill + companion) or **Claude Code** (slash commands + rescue).

Inspired by [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) companion / job patterns and `*-cli-runtime` naming. Product direction is **parent agent → Cursor CLI** (not Claude → Codex App Server).

## Requirements

- Node.js ≥ 18.18
- Cursor Agent CLI on PATH (`agent` or `cursor-agent`), with `agent login` completed

## Install for Codex

```bash
git clone https://github.com/dolibali/cursor-plugin-cc.git
cd cursor-plugin-cc
./scripts/install-skills.sh
```

This will:

- Symlink `skills/cursor-cli-runtime` into `~/.codex/skills/` and `~/.agents/skills/`
- Write `companionScript` into `~/.cursor/cursor-companion/config.json`

**Keep the clone path stable** — install uses symlinks into the repo.

Start a **new** Codex turn, then:

1. `$cursor-cli-runtime` + task text  
2. `/skills` → `cursor-cli-runtime`  
3. Natural language: "use Cursor …"

Codex cannot register custom `/cursor:*` slashes; the skill is the entrypoint.

## Install for Claude Code

```bash
/plugin marketplace add dolibali/cursor-plugin-cc
# or local path:
# /plugin marketplace add /path/to/cursor-plugin-cc
/plugin install cursor@dolibali-cursor
/reload-plugins
/cursor:setup
```

Then:

```bash
/cursor:rescue fix the flaky test
/cursor:rescue --background investigate the regression
/cursor:status
/cursor:result
/cursor:cancel
```

Slash commands call the same `scripts/cursor-companion.mjs` as Codex.

## Usage (companion CLI)

```bash
node /path/to/cursor-plugin-cc/scripts/cursor-companion.mjs setup --json

node .../cursor-companion.mjs task --workspace /abs/code -- "Fix the flaky test"
# --workspace defaults to process.cwd() when omitted
node .../cursor-companion.mjs task -- "Fix the flaky test"

node .../cursor-companion.mjs task --workspace /abs/code --background -- "long job"
node .../cursor-companion.mjs status --workspace /abs/code
node .../cursor-companion.mjs result --workspace /abs/code
```

### Model

Leave `--model` unset by default (Cursor CLI default / `auto`).

```bash
node .../cursor-companion.mjs setup --set-model cursor-grok-4.5-high-fast
node .../cursor-companion.mjs setup --set-model -   # clear
# or: export CURSOR_COMPANION_MODEL=...
```

### E2E / delegated tests

```bash
node .../cursor-companion.mjs task --mode e2e \
  --workspace /abs/git \
  --prompt-file /abs/prompt.md \
  --artifact-dir /abs/artifacts-outside-repo \
  --required-check my-check
```

See `skills/cursor-cli-runtime/references/delegated-test-contract.md`.

### Parent wait (Codex)

One `shell_command`, `timeout_ms` ≥ 3h ceiling, wait until exit. Do not poll with empty `write_stdin`.

## Tests

```bash
npm test
```

## Version

0.2.0 — Claude Code marketplace / `/cursor:*` / `cursor-rescue` added; Codex skill remains the primary install path.
