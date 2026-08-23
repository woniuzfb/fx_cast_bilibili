"""Update docs/updates.json with the release download links and sha256 hashes.

Hashes come straight from the GitHub release API (asset digests), no
downloads needed. docs/updates.json is served via GitHub Pages and consumed
by the extension self-update ("addons") and the bridge update check in the
options page ("fx_cast_bilibili_bridge").

Env vars (set by the workflow step):
  GIT_TAG  e.g. vX.Y.Z
  GIT_REPO e.g. owner/repo
  GH_TOKEN used by the gh CLI for API access
"""

import json
import os
import subprocess
import time

tag = os.environ["GIT_TAG"]
ver = os.environ["GIT_TAG"].lstrip("v")
repo = os.environ["GIT_REPO"]

# Asset filenames published by the build workflow (see
# .github/workflows/build.yml and bridge/bin/build.js).
xpi_name = f"fx_cast_bilibili-{ver}.xpi"
bridge_assets = [
    ("mac", "arm64", f"fx_cast_bilibili_bridge-{ver}-arm64.pkg"),
    ("mac", "x64", f"fx_cast_bilibili_bridge-{ver}-x64.pkg"),
    ("win", "x64", f"fx_cast_bilibili_bridge-{ver}-x64.exe"),
    ("linux-deb", "x64", f"fx_cast_bilibili_bridge-{ver}-x64.deb"),
    ("linux-rpm", "x64", f"fx_cast_bilibili_bridge-{ver}-x64.rpm"),
]

# Asset digests are computed asynchronously; they are normally ready long
# before this runs (assets are uploaded while the release is still a draft).
for _ in range(3):
    release = json.loads(
        subprocess.check_output(["gh", "api", f"repos/{repo}/releases/tags/{tag}"])
    )
    digests = {a["name"]: a["digest"] for a in release["assets"]}
    if digests.get(xpi_name) and all(digests.get(f) for _, _, f in bridge_assets):
        break
    time.sleep(15)
else:
    missing = [n for n, d in digests.items() if not d] or "release assets"
    raise SystemExit(f"error: sha256 digests not available for {tag}: {missing}")

with open("extension/src/manifest.json") as f:
    addon_id = json.load(f)["browser_specific_settings"]["gecko"]["id"]

with open("docs/updates.json") as f:
    data = json.load(f)

link_prefix = f"https://github.com/{repo}/releases/download/{tag}/"


def record_entry(updates, entry):
    """Insert or update (idempotent for re-released tags) an entry."""
    for u in updates:
        if u["version"] == entry["version"]:
            u.clear()
            u.update(entry)
            break
    else:
        updates.append(entry)


# Extension entry (signed xpi published by the build-extension job).
record_entry(
    data["addons"][addon_id]["updates"],
    {
        "version": ver,
        "update_link": link_prefix + xpi_name,
        "update_hash": digests[xpi_name],
    },
)

# Bridge entry (installers published by the build matrix). Bridge versions
# keep the "v" prefix (Bridge.svelte builds the release page URL from it).
platforms = {}
for platform, arch, filename in bridge_assets:
    platforms.setdefault(platform, {})[arch] = {
        "update_link": link_prefix + filename,
        "update_hash": digests[filename],
    }

record_entry(
    data["fx_cast_bilibili_bridge"]["updates"],
    {"version": tag, "platforms": platforms},
)

with open("docs/updates.json", "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")

print(f"Done: docs/updates.json updated for {tag}")
