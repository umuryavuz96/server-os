#!/usr/bin/env bash
# Release body for a tag: the matching "## [x.y.z]" section of CHANGELOG.md, then the compare link to the previous tag.
# Usage: scripts/release-notes.sh v0.1.1 [previous-tag]   (previous defaults to the highest tag below this one)
set -euo pipefail
tag="$1"; ver="${tag#v}"; cd "$(dirname "$0")/.."
prev="${2:-}"
if [ -z "$prev" ]; then
  for c in $(git tag --list 'v*' --sort=-v:refname); do
    [ "$c" = "$tag" ] && continue
    if [ "$(printf '%s\n%s\n' "$c" "$tag" | sort -V | head -1)" = "$c" ]; then prev="$c"; break; fi
  done
fi
section="$(awk -v v="$ver" '
  /^## \[/ { if (on) exit; on = index($0, "## [" v "]") == 1; next }
  on { lines[++n] = $0 }
  END { s = 1; while (s <= n && lines[s] == "") s++; while (n >= s && lines[n] == "") n--; for (i = s; i <= n; i++) print lines[i] }' CHANGELOG.md)"
[ -n "$section" ] || { echo "CHANGELOG.md has no ## [$ver] section" >&2; exit 1; }
printf '%s\n' "$section"
repo="${GITHUB_REPOSITORY:-umuryavuz96/server-os}"
if [ -n "$prev" ]; then printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag"; fi
