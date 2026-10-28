#!/bin/sh
# Sign <dist>/SHA256SUMS with the release key into SHA256SUMS.sig (Ed25519), then check it against the public key
# the server and install.sh carry, so a wrong secret fails the release instead of shipping updates nobody can install.
#   SERVER_OS_SIGNING_KEY=<base64 of the private key PEM> scripts/sign-release.sh <dist>
# Needs OpenSSL 3+ (Ed25519 -rawin) and Bun. The key is only ever written to a 0600 temp file, removed on exit.
set -eu
dist="$1"
[ -n "${SERVER_OS_SIGNING_KEY:-}" ] || { echo "SERVER_OS_SIGNING_KEY is not set" >&2; exit 1; }
key=$(mktemp); trap 'rm -f "$key"' EXIT
chmod 600 "$key"
printf '%s' "$SERVER_OS_SIGNING_KEY" | base64 -d > "$key"
openssl pkeyutl -sign -rawin -inkey "$key" -in "$dist/SHA256SUMS" -out "$dist/SHA256SUMS.sig"
bun -e '
import { readFileSync } from "node:fs";
import { verifySignature } from "./server/modules/release.ts";
const d = process.argv[1];
if (!verifySignature(readFileSync(d + "/SHA256SUMS"), readFileSync(d + "/SHA256SUMS.sig"))) { console.error("SHA256SUMS.sig does not verify against RELEASE_PUBLIC_KEY"); process.exit(1); }
console.log("signed: SHA256SUMS.sig verifies against the release key");
' "$dist"
