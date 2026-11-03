"""Download the render's CC0 assets from Poly Haven into a cache folder (kept out of git).

    python3 fetch_assets.py <cache dir>          # fetch what's missing, check every file against assets.lock.json
    python3 fetch_assets.py <cache dir> --lock   # (re)write the lock from Poly Haven's API

assets.json names what we use; assets.lock.json pins every file's URL and sha256, so a later fetch gets the same bytes
(a changed file fails loudly instead of quietly changing the renders). Standard library only.
"""
import hashlib, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "server-os-house-render/1 (+https://github.com/umuryavuz96/server-os)"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def plan():
    """Every file the assets need: {relative path: url}, from Poly Haven's file API."""
    spec = json.load(open(os.path.join(HERE, "assets.json")))
    out = {}
    for key, t in spec["textures"].items():
        files = json.loads(get(f"https://api.polyhaven.com/files/{t['id']}"))
        for m, name in ((t.get("diffuse", "Diffuse"), "Diffuse"), ("Rough", "Rough"), ("nor_gl", "nor_gl"), ("AO", "AO")):
            if m in files:
                out[f"textures/{t['id']}/{name}.jpg"] = files[m][t["res"]]["jpg"]["url"]
        info = json.loads(get(f"https://api.polyhaven.com/info/{t['id']}"))
        out[f"textures/{t['id']}/info.json"] = {"dimensions": info.get("dimensions"), "authors": info.get("authors")}
    for key, h in spec["hdri"].items():
        files = json.loads(get(f"https://api.polyhaven.com/files/{h['id']}"))
        out[f"hdri/{h['id']}.hdr"] = files["hdri"][h["res"]]["hdr"]["url"]
    for key, m in spec["models"].items():
        files = json.loads(get(f"https://api.polyhaven.com/files/{m['id']}"))
        g = files["gltf"][m.get("res", "1k")]["gltf"]
        out[f"models/{m['id']}/{m['id']}.gltf"] = g["url"]
        for rel, f in g.get("include", {}).items():
            out[f"models/{m['id']}/{rel}"] = f["url"]
    return out


def main():
    cache = os.path.abspath(sys.argv[1])
    lock_path = os.path.join(HERE, "assets.lock.json")
    if "--lock" in sys.argv or not os.path.exists(lock_path):
        lock = {}
        for rel, src in plan().items():
            if isinstance(src, dict):  # metadata we write ourselves
                lock[rel] = {"json": src}
                continue
            data = get(src)
            lock[rel] = {"url": src, "sha256": hashlib.sha256(data).hexdigest()}
            write(cache, rel, data)
        json.dump(lock, open(lock_path, "w"), indent=1, sort_keys=True)
        print(f"locked {len(lock)} files")
    lock = json.load(open(lock_path))
    fetched = 0
    for rel, f in lock.items():
        path = os.path.join(cache, rel)
        if "json" in f:
            write(cache, rel, json.dumps(f["json"]).encode())
            continue
        if os.path.exists(path) and sha(path) == f["sha256"]:
            continue
        data = get(f["url"])
        if hashlib.sha256(data).hexdigest() != f["sha256"]:
            sys.exit(f"checksum mismatch for {rel} ({f['url']}): refusing to use it")
        write(cache, rel, data)
        fetched += 1
    print(f"assets ready in {cache} ({fetched} downloaded, {len(lock)} total)")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def write(cache, rel, data):
    path = os.path.join(cache, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "wb").write(data)


if __name__ == "__main__":
    main()
