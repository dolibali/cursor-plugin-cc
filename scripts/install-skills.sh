#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_SRC="$ROOT/skills/cursor-cli-runtime"
COMPANION="$ROOT/scripts/cursor-companion.mjs"

install_link() {
  local dest_parent="$1"
  local name="cursor-cli-runtime"
  mkdir -p "$dest_parent"
  local dest="$dest_parent/$name"
  if [[ -L "$dest" || -e "$dest" ]]; then
    rm -rf "$dest"
  fi
  ln -s "$SKILL_SRC" "$dest"
  echo "linked $dest -> $SKILL_SRC"
}

# Write companion path into global config
mkdir -p "${HOME}/.cursor/cursor-companion"
CONFIG="${HOME}/.cursor/cursor-companion/config.json"
if [[ -f "$CONFIG" ]]; then
  node -e '
const fs=require("fs");
const p=process.argv[1];
const script=process.argv[2];
let c={};
try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
c.companionScript=script;
fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
' "$CONFIG" "$COMPANION"
else
  printf '%s\n' "{" "  \"companionScript\": \"${COMPANION}\"" "}" > "$CONFIG"
fi

install_link "${HOME}/.codex/skills"
install_link "${HOME}/.agents/skills"

# Retire old name: replace with symlink to new skill if present
OLD="${HOME}/.agents/skills/cursor-cli-use"
if [[ -e "$OLD" || -L "$OLD" ]]; then
  rm -rf "$OLD"
  ln -s "$SKILL_SRC" "$OLD"
  echo "replaced legacy $OLD -> $SKILL_SRC"
fi

echo
echo "Codex: use \$cursor-cli-runtime or /skills → cursor-cli-runtime"
echo "Companion: node \"$COMPANION\" setup --json"
