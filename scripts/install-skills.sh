#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="$ROOT/plugins/cursor/skills/cursor-cli-runtime"
COMPANION="$ROOT/plugins/cursor/scripts/cursor-companion.mjs"
DRY_RUN=0
REPLACE_LINK=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --replace-link) REPLACE_LINK=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run] [--replace-link]"
      exit 0
      ;;
    *) echo "Unknown option: $argument" >&2; exit 1 ;;
  esac
done

preflight_link() {
  local dest="$1"
  if [[ -L "$dest" ]]; then
    local current
    current="$(readlink "$dest")"
    local resolved
    resolved="$(cd "$(dirname "$dest")" 2>/dev/null && node -e 'const p=require("path");process.stdout.write(p.resolve(process.argv[1]))' "$current")"
    if [[ "$resolved" == "$SKILL_SRC" ]]; then
      return
    fi
    if [[ "$REPLACE_LINK" != "1" ]]; then
      echo "Refusing to replace foreign symlink: $dest -> $current (use --replace-link)" >&2
      return 1
    fi
  elif [[ -e "$dest" ]]; then
    echo "Refusing to replace real file or directory: $dest" >&2
    return 1
  fi
  return 0
}

preflight_config() {
  local config="${HOME}/.cursor/cursor-companion/config.json"
  [[ -f "$config" ]] || return 0
  node - "$config" "$DRY_RUN" <<'NODE'
const fs = require("fs")
const [file, dryRun] = process.argv.slice(2)
try {
  JSON.parse(fs.readFileSync(file, "utf8"))
} catch (error) {
  if (dryRun === "1") throw new Error(`Invalid JSON in ${file}: ${error.message}`)
  const backup = `${file}.bak-${new Date().toISOString().replaceAll(":", "-")}`
  fs.copyFileSync(file, backup)
  throw new Error(`Invalid JSON in ${file}; backup written to ${backup}: ${error.message}`)
}
NODE
}

install_link() {
  local dest_parent="$1"
  local dest="$dest_parent/cursor-cli-runtime"
  if [[ -L "$dest" ]]; then
    local current
    current="$(readlink "$dest")"
    local resolved
    resolved="$(cd "$(dirname "$dest")" 2>/dev/null && node -e 'const p=require("path");process.stdout.write(p.resolve(process.argv[1]))' "$current")"
    if [[ "$resolved" == "$SKILL_SRC" ]]; then
      echo "unchanged $dest -> $SKILL_SRC"
      return
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "would replace link $dest -> $SKILL_SRC"
      return
    fi
    unlink "$dest"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "would link $dest -> $SKILL_SRC"
    return
  fi
  mkdir -p "$dest_parent"
  ln -s "$SKILL_SRC" "$dest"
  echo "linked $dest -> $SKILL_SRC"
}

write_config() {
  local config="${HOME}/.cursor/cursor-companion/config.json"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "would set companionScript in $config to $COMPANION"
    return
  fi
  mkdir -p "$(dirname "$config")"
  node - "$config" "$COMPANION" <<'NODE'
const fs = require("fs")
const path = require("path")
const [file, companionScript] = process.argv.slice(2)
let config = {}
if (fs.existsSync(file)) {
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    const backup = `${file}.bak-${new Date().toISOString().replaceAll(":", "-")}`
    fs.copyFileSync(file, backup)
    throw new Error(`Invalid JSON in ${file}; backup written to ${backup}: ${error.message}`)
  }
}
config.companionScript = companionScript
const temporary = `${file}.${process.pid}.tmp`
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`)
fs.renameSync(temporary, file)
NODE
  echo "configured $config"
}

if [[ ! -f "$SKILL_SRC/SKILL.md" || ! -f "$COMPANION" ]]; then
  echo "Plugin runtime is incomplete under $ROOT/plugins/cursor" >&2
  exit 1
fi

preflight_link "${HOME}/.codex/skills/cursor-cli-runtime"
preflight_link "${HOME}/.agents/skills/cursor-cli-runtime"
preflight_config
install_link "${HOME}/.codex/skills"
install_link "${HOME}/.agents/skills"
write_config

OLD="${HOME}/.agents/skills/cursor-cli-use"
if [[ -L "$OLD" ]]; then
  old_target="$(readlink "$OLD")"
  if [[ "$old_target" == "$ROOT" || "$old_target" == "$ROOT/"* ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "would remove legacy link $OLD"
    else
      unlink "$OLD"
      echo "removed legacy link $OLD"
    fi
  fi
fi

echo
echo "Codex: use \$cursor-cli-runtime or /skills -> cursor-cli-runtime"
echo "Companion: node \"$COMPANION\" setup --json"
