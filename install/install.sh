#!/bin/sh
# Server OS installer: downloads the latest release (server + setup wizard) and starts the wizard.
#   curl -fsSL https://raw.githubusercontent.com/umuryavuz96/server-os/main/install/install.sh | sh
# Env: SERVER_OS_REPO (owner/name), SERVER_OS_VERSION (tag, default latest), SERVER_OS_HOME (default ~/server-os)
set -eu

REPO="${SERVER_OS_REPO:-umuryavuz96/server-os}"
HOME_DIR="${SERVER_OS_HOME:-${SERVER_DASH_HOME:-$HOME/server-os}}"
say() { printf '\033[1;31m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in darwin|linux) ;; *) die "Server OS runs on macOS and Linux (this is $os)." ;; esac
arch=$(uname -m)
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; *) die "Unsupported CPU: $arch" ;; esac
command -v curl >/dev/null || die "curl is required."
command -v tar >/dev/null || die "tar is required."

tag="${SERVER_OS_VERSION:-}"
if [ -z "$tag" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$tag" ] || die "Could not find the latest release of $REPO."
fi
base="https://github.com/$REPO/releases/download/$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Release signing key (Ed25519). SHA256SUMS is signed with its private half in the release workflow; the server's
# self-updater checks the same key (server/modules/release.ts).
PUBKEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzw7A78HeKVk+lRM9HJRhQiKBjIKq14bLRZ80m+IcZRc=
-----END PUBLIC KEY-----'

say "Downloading Server OS $tag for $os/$arch"
curl -fsSL -o "$tmp/server-os-setup" "$base/server-os-setup-$os-$arch"
curl -fsSL -o "$tmp/server.tgz" "$base/server-os-$tag.tar.gz"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
curl -fsSL -o "$tmp/SHA256SUMS.sig" "$base/SHA256SUMS.sig" || die "$tag has no signature (SHA256SUMS.sig)."

# Ed25519 needs OpenSSL 3+; macOS's own openssl is LibreSSL, so look for Homebrew's too.
ossl=""
for c in openssl /opt/homebrew/opt/openssl/bin/openssl /usr/local/opt/openssl/bin/openssl; do
  if command -v "$c" >/dev/null 2>&1 && "$c" version 2>/dev/null | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9])\.'; then ossl="$c"; break; fi
done
if [ -n "$ossl" ]; then
  say "Checking the signature"
  printf '%s\n' "$PUBKEY" > "$tmp/release.pub"
  "$ossl" pkeyutl -verify -pubin -inkey "$tmp/release.pub" -rawin -in "$tmp/SHA256SUMS" -sigfile "$tmp/SHA256SUMS.sig" >/dev/null 2>&1 \
    || die "The signature on SHA256SUMS does not match the Server OS release key. Not installing."
else
  say "No OpenSSL 3 found: skipping the signature check (checksums are still checked; the updater checks signatures itself)"
fi

say "Checking checksums"
( cd "$tmp"
  cp server-os-setup "server-os-setup-$os-$arch" && cp server.tgz "server-os-$tag.tar.gz"
  if command -v sha256sum >/dev/null; then sum="sha256sum"; else sum="shasum -a 256"; fi
  grep -E " (server-os-setup-$os-$arch|server-os-$tag\.tar\.gz)\$" SHA256SUMS | $sum -c - >/dev/null ) || die "Checksum mismatch — download again."

# Layout: each version in versions/<tag>, `current` links to the running one (the self-updater switches it and keeps
# the previous version for rollback). config/, data/, logs/ … stay in $HOME_DIR, outside every version folder.
dest="$HOME_DIR/versions/$tag"
say "Unpacking into $dest"
mkdir -p "$HOME_DIR/versions"
rm -rf "$dest.tmp" && mkdir -p "$dest.tmp"
tar -xzf "$tmp/server.tgz" -C "$dest.tmp"
rm -rf "$dest" && mv "$dest.tmp" "$dest"
ln -sfn "versions/$tag" "$HOME_DIR/current"
# Older installs unpacked into source/ and their service still points there: keep that path working through current.
if [ -d "$HOME_DIR/source" ] && [ ! -L "$HOME_DIR/source" ]; then mv "$HOME_DIR/source" "$HOME_DIR/versions/.old-source"; fi
ln -sfn current "$HOME_DIR/source"
mkdir -p "$HOME_DIR/bin"
install -m 0755 "$tmp/server-os-setup" "$HOME_DIR/bin/server-os-setup"

# `server-os` CLI (pair, devices, revoke, init): a wrapper over the bundled server/cli.ts, linked into ~/.local/bin.
cat > "$HOME_DIR/bin/server-os" <<WRAP
#!/bin/sh
export SERVER_OS_HOME="\${SERVER_OS_HOME:-$HOME_DIR}"
for b in "\$(command -v bun 2>/dev/null)" "\$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -n "\$b" ] && [ -x "\$b" ] && exec "\$b" "$HOME_DIR/current/server/cli.ts" "\$@"
done
echo "server-os: Bun not found (install it from https://bun.sh)" >&2; exit 1
WRAP
chmod 0755 "$HOME_DIR/bin/server-os"
mkdir -p "$HOME/.local/bin" && ln -sfn "$HOME_DIR/bin/server-os" "$HOME/.local/bin/server-os"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Add ~/.local/bin to your PATH to use the server-os command (or run $HOME_DIR/bin/server-os)" ;; esac

say "Starting the setup wizard"
exec "$HOME_DIR/bin/server-os-setup" --source "$HOME_DIR/current" --home "$HOME_DIR" </dev/tty
