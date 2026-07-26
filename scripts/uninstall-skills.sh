#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="$ROOT/plugins/cursor/skills/cursor-cli-runtime"
COMPANION="$ROOT/plugins/cursor/scripts/cursor-companion.mjs"
CONFIG="${HOME}/.cursor/cursor-companion/config.json"

if [[ -f "$CONFIG" ]]; then
  node - "$CONFIG" <<'NODE'
const fs = require("fs")
const file = process.argv[2]
try {
  JSON.parse(fs.readFileSync(file, "utf8"))
} catch (error) {
  const backup = `${file}.bak-${new Date().toISOString().replaceAll(":", "-")}`
  fs.copyFileSync(file, backup)
  throw new Error(`Invalid JSON in ${file}; backup written to ${backup}: ${error.message}`)
}
NODE
fi

remove_owned_link() {
  local dest="$1"
  [[ -L "$dest" ]] || return 0
  local target
  target="$(readlink "$dest")"
  local resolved
  resolved="$(cd "$(dirname "$dest")" && node -e 'const p=require("path");process.stdout.write(p.resolve(process.argv[1]))' "$target")"
  if [[ "$resolved" == "$SKILL_SRC" ]]; then
    unlink "$dest"
    echo "removed $dest"
  else
    echo "left foreign link unchanged: $dest -> $target"
  fi
}

remove_owned_link "${HOME}/.codex/skills/cursor-cli-runtime"
remove_owned_link "${HOME}/.agents/skills/cursor-cli-runtime"

if [[ -f "$CONFIG" ]]; then
  node - "$CONFIG" "$COMPANION" <<'NODE'
const fs = require("fs")
const [file, companionScript] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(file, "utf8"))
if (config.companionScript === companionScript) {
  delete config.companionScript
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`)
  fs.renameSync(temporary, file)
}
NODE
fi
