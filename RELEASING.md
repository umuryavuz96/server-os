# Releasing Server OS

Installs and the self-updater only take **signed** releases, so every release goes through CI.

## Cut a release

1. Bump `version` in `package.json` (e.g. `0.2.0`) and add the notes to `CHANGELOG.md`. Commit to `main`.
2. Tag it and push the tag:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
   Use a prerelease tag (`v0.3.0-beta.1`) for the beta channel. Any tag with a `-` is published as a GitHub prerelease,
   and only servers set to the beta channel take it.
3. `.github/workflows/release.yml` then does the rest:
   - runs the tests and builds the web panel;
   - builds `server-os-setup-<os>-<arch>`;
   - runs `scripts/release-bundle.sh`. This writes `server-os-<tag>.tar.gz` (the server with the prebuilt panel) and
     `SHA256SUMS`. It fails if `package.json` doesn't match the tag, because the server reports that version and the
     updater compares against it;
   - runs `scripts/sign-release.sh`. This signs `SHA256SUMS` into `SHA256SUMS.sig` (Ed25519) and checks the signature
     against the public key in the code, so a wrong key fails the release instead of shipping one nobody can install;
   - publishes the GitHub release with all the files.
4. Homebrew tap: update `url` and `sha256` in `install/homebrew/server-os.rb` from the new `SHA256SUMS`.

## The signing key

| | |
|---|---|
| Private key | GitHub Actions secret `SERVER_OS_SIGNING_KEY` on `umuryavuz96/server-os` (base64 of the PEM). The maintainer's backup copy is in the Infisical vault under the same name. |
| Public key | `RELEASE_PUBLIC_KEY` in `server/modules/release.ts`, and `PUBKEY` in `install/install.sh`. A test keeps the two equal. |

The private key is never committed and never printed. To sign locally (for example to test the updater against a fake
release), export the variable and run `scripts/sign-release.sh <dist>`. That needs OpenSSL 3 or later.

**Rotating the key:**

1. Generate a new pair: `openssl genpkey -algorithm ed25519 -out k.pem && openssl pkey -in k.pem -pubout`.
2. Put the new public key in both places listed above.
3. Ship one release signed with the **old** key that contains the new public key.
4. Switch the secret to the new key. Releases signed with the new key are refused by servers that never installed the
   release from step 3.

## Testing the updater without a real release

`SERVER_OS_UPDATE_BASE=<url>` points a server at a fake release host. It serves `/releases` in the GitHub API shape
and `/download/<tag>/<file>`. Signatures are still checked, so the fake release must be signed with the real key.
`SERVER_OS_UPDATE_TIMEOUT_MS` shortens the 45 s health wait. Run that server as its own launchd agent or systemd unit,
with a temporary `SERVER_OS_HOME` laid out like `install/install.sh` does: `versions/<tag>` plus a `current` link.
