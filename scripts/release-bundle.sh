#!/bin/sh
# Build the server bundle for a release and checksum everything in the output folder.
#   scripts/release-bundle.sh <tag> <dist>     (run from the repository root, after `bun run build`)
# Writes <dist>/server-os-<tag>.tar.gz (the server source with the web panel prebuilt, no node_modules) and
# <dist>/SHA256SUMS over every file in <dist>. Used by .github/workflows/release.yml and the updater's local tests.
set -eu
tag="$1"; dist="$2"
ver=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' package.json | head -n1)
[ "v$ver" = "$tag" ] || { echo "package.json says $ver but the tag is $tag: bump package.json first" >&2; exit 1; }
[ -f web/dist/index.html ] || { echo "web/dist is missing: run bun run build first" >&2; exit 1; }
mkdir -p "$dist"
# Top-level entries are picked here instead of with --exclude: GNU tar and bsdtar anchor patterns differently, and an
# unanchored ".claude" or "dist" also drops agent/.claude (the agent kit) and web/dist (the panel).
set --
for f in * .[!.]*; do
  case "$f" in .git|.claude|dist|var|node_modules|'.[!.]*'|'*') ;; *) set -- "$@" "./$f" ;; esac
done
tar --exclude=node_modules --exclude=server-os-setup -czf "$dist/server-os-$tag.tar.gz" "$@"
( cd "$dist" && rm -f SHA256SUMS SHA256SUMS.sig && shasum -a 256 * > SHA256SUMS )
echo "bundle: $dist/server-os-$tag.tar.gz"
