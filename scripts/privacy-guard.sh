#!/usr/bin/env bash
# Fails when a tracked text file contains a word that belongs to one private install
# (family, house, personal bots, home network). Run in CI and before every push.
#
# The private words are NOT written here. Each tracked file is lowercased and split
# into word tokens (letters and digits, plus camelCase parts and dotted IPs); the
# sha256 of every token is compared with the list below. Output names file:line only,
# never the word, so CI logs stay clean too.
#
# Allowed: the author line "Umur Yavuz" (stripped before matching) and the
# repo owner "umuryavuz96" (one token, never in the list).
#
# Add a word:   echo -n word | shasum -a 256     (lowercase, no newline)
# then append the hash to HASHES below.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec python3 - <<'PY'
import hashlib, re, subprocess, sys

HASHES = set("""
17c7c89093b7e4b3942c317e272399bb7eaa5a63bde081e262d2172525b7de7b
4d4e471671b2db791de6921eb938f9b48230c67f66cfccd94dbaf692f1587269
b2059cffa68c76715743ed12164c858fc99f870f610d8e171d5d14261724d341
3f3049e3a895023633c05e8e779ce14441dd8c39372da87bd290a6302b405e6c
b1bdf50e3776d7c35d2759dfd406e10e22cd898ea5869516d3ca6541928eca7f
ec184d5b6ea2a832430f12e912509fbfd6476e3894a0ed84c8c36e3b7e8fe2ee
f14a36f6a0d7ecf6ee36aeb145466221c3d52bd0321417d775bca9f6f260a69d
2bef11b582531abb9e377fb694a35c5346422849b8056a1ebb14362f8ebf8b0c
345aa1ac4246d2030f742e9cc67207155dfc9009294b0eebbfb797910b7a752d
ffeba285551ff08eff0f16bf2ce3d8194df5132cf0da2d39529c5d4110da6cd3
5bb1d2a8e2a5a64563fe6c041a7e8af1d9ea99625c32c35ce54fdaf15c3ae6c0
2483a056889c7257464e6ce0b9cf808a0add1e8d9fe67b253fdb7f2f1e9fa1df
7a07705118e3d77108fd08232cc2af939537166a4fde77fa7c31ab439271feba
60386465ca8f544ec69f3d11bae8e5b6a8afa9bad4b0cb11ce9fc0c8bdf889d2
977afac6eeeebf47149230bd78cc60f574ccbceda8f77ddbb6e4eaf048fb430b
7a79714a92bead588aad67ee23a00f8ac52fb77b7754f24bea9a1b876ce84c00
a96da0017958c26cb2936d770dc21abfd71f75691eb0e32fc9af52a3e114a7a7
56b2aea1e07a58eba05b4eb1f9572484ad69ac2f58a036daeaa47e6dfdad5f0f
""".split())

# The author line is two tokens in a row; this pair of hashes is let through.
AUTHOR = ("ffeba285551ff08eff0f16bf2ce3d8194df5132cf0da2d39529c5d4110da6cd3",
          "345aa1ac4246d2030f742e9cc67207155dfc9009294b0eebbfb797910b7a752d")
IP = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")
WORD = re.compile(r"[A-Za-z0-9]+")
CAMEL = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
SKIP = {"bun.lock"}

def digest(t):
    return hashlib.sha256(t.encode()).hexdigest()

def hits(line):
    """True when the line holds a listed word outside the author pair."""
    if any(digest(ip) in HASHES for ip in IP.findall(line)):
        return True
    words = [w.lower() for w in WORD.findall(line)]
    raw = WORD.findall(line)
    i = 0
    while i < len(words):
        if i + 1 < len(words) and (digest(words[i]), digest(words[i + 1])) == AUTHOR:
            i += 2
            continue
        toks = {words[i]} | {p.lower() for p in CAMEL.findall(raw[i])}
        if any(digest(t) in HASHES for t in toks):
            return True
        i += 1
    return False

files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\0")
bad = []
for raw in files:
    if not raw:
        continue
    path = raw.decode()
    if path.rsplit("/", 1)[-1] in SKIP:
        continue
    try:
        data = open(path, "rb").read()
    except OSError:
        continue
    if b"\0" in data[:8192]:
        continue
    for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        if hits(line):
            bad.append(f"{path}:{n}")

if bad:
    print("privacy-guard: private words found (file:line):", file=sys.stderr)
    print("\n".join(bad), file=sys.stderr)
    sys.exit(1)
print("privacy-guard: clean")
PY
