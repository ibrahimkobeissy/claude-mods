#!/usr/bin/env bash
# Scaffold a new mod from template/ into mods/<name> and list it in the marketplace.
set -euo pipefail

name="${1:-}"
description="${2:-TODO: one-line description}"

if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "usage: scripts/new-mod.sh <kebab-case-name> [\"one-line description\"]" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/mods/$name"
manifest="$root/.claude-plugin/marketplace.json"

[[ -e "$dest" ]] && { echo "mods/$name already exists" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

cp -r "$root/template" "$dest"
rm -rf "$dest/.claude-plugin/types"

tmp="$(mktemp)"
jq --arg n "$name" --arg d "$description" '.name = $n | .description = $d' \
  "$dest/.claude-plugin/plugin.json" > "$tmp" && mv "$tmp" "$dest/.claude-plugin/plugin.json"

jq --arg n "$name" --arg d "$description" \
  '.plugins += [{ name: $n, source: ("./mods/" + $n), description: $d }] | .plugins |= sort_by(.name)' \
  "$manifest" > "$tmp" && mv "$tmp" "$manifest"

echo "Created mods/$name and added it to .claude-plugin/marketplace.json"
echo "Next: edit mods/$name/hooks/register.ts, then run scripts/validate.sh"
