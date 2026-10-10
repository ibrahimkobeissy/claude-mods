#!/usr/bin/env bash
# Validate the marketplace, then validate and test every mod (or only the ones named).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
manifest=.claude-plugin/marketplace.json
status=0

jq empty "$manifest"

# Every listed mod must exist, and every mod folder must be listed.
for src in $(jq -r '.plugins[].source' "$manifest"); do
  [[ -f "$src/.claude-plugin/plugin.json" ]] || { echo "✗ $manifest lists $src, which has no plugin.json"; status=1; }
done
for dir in mods/*/; do
  [[ -d "$dir" ]] || continue
  name="$(basename "$dir")"
  jq -e --arg s "./mods/$name" '.plugins | any(.source == $s)' "$manifest" >/dev/null \
    || { echo "✗ mods/$name is not listed in $manifest"; status=1; }
  jq -e --arg n "$name" '.name == $n' "$dir/.claude-plugin/plugin.json" >/dev/null \
    || { echo "✗ mods/$name/.claude-plugin/plugin.json name does not match its folder"; status=1; }
done

if [[ $# -gt 0 ]]; then targets=("$@"); else targets=(template mods/*/); fi

for dir in "${targets[@]}"; do
  [[ -f "$dir/.claude-plugin/plugin.json" ]] || continue
  echo "── ${dir%/}"
  claude plugin validate "$dir" || status=1
  if find "$dir" -name '*.test.ts' -not -path '*/.claude-plugin/types/*' | grep -q .; then
    claude plugin test "$dir" || status=1
  fi
done

exit $status
