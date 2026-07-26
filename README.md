# cursor-plugin-cc

Delegate work from Codex or Claude Code to the local
[Cursor Agent CLI](https://cursor.com) (`agent` / `cursor-agent`).

The companion/job structure is inspired by
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), while this
project runs Cursor CLI directly and includes a generic autonomous E2E runner.

## Requirements

- Node.js 18.18 or newer
- Cursor Agent CLI on `PATH`
- `agent login` completed
- A Cursor CLI version supporting `--sandbox`

## Codex installation

```bash
git clone https://github.com/dolibali/cursor-plugin-cc.git
cd cursor-plugin-cc
./scripts/install-skills.sh
```

The installer links the bundled `cursor-cli-runtime` skill into both
`~/.codex/skills` and `~/.agents/skills`, then records the bundled companion
path in `~/.cursor/cursor-companion/config.json`.

Existing real files or directories are never deleted. Use `--replace-link` to
replace an older symlink, `--dry-run` to preview, and
`./scripts/uninstall-skills.sh` to remove links owned by this checkout.

Start a new Codex turn, then invoke `$cursor-cli-runtime` or ask Codex to use
Cursor.

## Claude Code installation

```bash
/plugin marketplace add dolibali/cursor-plugin-cc
/plugin install cursor@dolibali-cursor
/reload-plugins
/cursor:setup
```

Available commands are `/cursor:rescue`, `/cursor:setup`, `/cursor:status`,
`/cursor:result`, and `/cursor:cancel`.

## Companion

```bash
COMPANION=plugins/cursor/scripts/cursor-companion.mjs

node "$COMPANION" setup --json
node "$COMPANION" task --workspace /abs/repo -- "Fix the failing test"
node "$COMPANION" task --workspace /abs/repo --read-only -- "Investigate the failure"
node "$COMPANION" task --workspace /abs/repo --background -- "Run the long migration"
```

### Multiple workspaces

Declare every writable project explicitly:

```bash
node "$COMPANION" task \
  --workspace /abs/frontend \
  --add-dir /abs/backend \
  --add-dir /abs/shared \
  -- "Update the cross-repository contract and tests"
```

The companion does not infer or expose a common parent directory.

### Sandbox

`--sandbox enabled` is the default. It keeps Cursor writes inside the declared
workspace roots and system temporary storage.

```bash
# Explicit unrestricted host access
node "$COMPANION" task \
  --workspace /abs/repo \
  --sandbox disabled \
  -- "Perform the requested host-level integration"
```

Sandbox mode never falls back to unrestricted access. Use
`--sandbox disabled` only when the caller intentionally accepts host-wide
access.

### Delegated E2E

```bash
node "$COMPANION" task --mode e2e \
  --workspace /abs/git-repo \
  --add-dir /abs/second-git-repo \
  --prompt-file /abs/task.md \
  --artifact-dir /tmp/cursor-e2e-artifacts \
  --required-check package \
  --required-check gui
```

Artifacts must be under the system temporary directory and outside every
workspace. See the delegated-test contract bundled with the runtime skill.

## Tests

```bash
npm test
```

The real Cursor smoke test is deliberately separate because it installs the
current Codex skill links and consumes one real Cursor request:

```bash
npm run test:live:codex
```

It installs this checkout, creates a temporary Git repository, asks Cursor to
write one deterministic file, verifies `task`, `status`, and `result`, and
retains compact artifacts under the system temporary directory.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
