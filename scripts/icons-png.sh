#!/bin/bash
# Renders every app icon SVG to a 180 px PNG beside it (x.svg → x.png) for the iPhone app,
# which can't draw SVG. Usage: icons-png.sh <icons-dir>. Re-run after adding or changing an icon. Uses Quick Look (built into macOS).
set -euo pipefail
ICONS="${1:?usage: icons-png.sh <icons-dir>}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
find "$ICONS" -name '*.svg' | while read -r svg; do
  png="${svg%.svg}.png"
  [ -f "$png" ] && [ "$png" -nt "$svg" ] && continue
  qlmanage -t -s 180 -o "$TMP" "$svg" >/dev/null 2>&1 && mv "$TMP/$(basename "$svg").png" "$png" && echo "rendered ${png#$ICONS/}"
done
