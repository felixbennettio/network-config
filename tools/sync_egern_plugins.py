#!/usr/bin/env python3
"""Publish the existing Egern plugin snapshot through private GitLab URLs."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote
import urllib.request
import time

from sync_modules import SCRIPT_RE, render_module, validate

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://github.com/felixbennettio/proxy_plugins.git"
PREFIX = "modules/egern/"
REPOSITORY_URL = re.compile(
    r"https://(?:cdn\.jsdelivr\.net/gh/(?:ciallothu|felixbennettio)/proxy_plugins@main/"
    r"|raw\.githubusercontent\.com/(?:ciallothu|felixbennettio)/proxy_plugins/main/)"
    r"(?P<path>[^\s,\"'<>]+)"
)
SUFFIXES = {".sgmodule", ".srmodule", ".yaml", ".js", ".list", ".json"}


def render(text: str, available: set[str], yaml_module: bool = False) -> str:
    def replace(match: re.Match) -> str:
        path = match["path"]
        if path not in available:
            raise ValueError(f"Missing plugin dependency: {path}")
        return ("https://git.routeforge.zone/api/v4/projects/13/repository/files/"
                + quote(PREFIX + path, safe="")
                + "/raw?ref=main&private_token={{{GitLabToken}}}")

    if not REPOSITORY_URL.search(text):
        return text
    if "GitLabToken" in text:
        raise ValueError("Upstream uses the reserved GitLabToken argument")
    text = REPOSITORY_URL.sub(replace, text)
    if yaml_module:
        if re.search(r"(?m)^compat_arguments:\s*$", text):
            return re.sub(r"(?m)^compat_arguments:\s*$", 'compat_arguments:\n  GitLabToken: ""', text, count=1)
        return 'compat_arguments:\n  GitLabToken: ""\n' + text
    if re.search(r"(?m)^#!arguments\s*=", text):
        return re.sub(r"(?m)^(#!arguments\s*=.*)$", lambda m: m[1] + ',GitLabToken:""', text, count=1)
    return '#!arguments=GitLabToken:""\n' + text


def publish(source: Path, root: Path = ROOT) -> dict:
    manifest = json.loads((source / "MANIFEST.json").read_text())
    entries = {item["path"]: item for item in manifest["files"]}
    pending = {}
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--", "modules", "scripts", "rules"], check=True)
    tracked = set(subprocess.check_output(["git", "-C", str(source), "ls-tree", "-r", "--name-only", "HEAD"], text=True).splitlines())
    for folder in ("modules", "scripts", "rules"):
        for file in (source / folder).rglob("*"):
            if not file.is_file():
                continue
            path = file.relative_to(source).as_posix()
            if file.is_symlink() or file.suffix not in SUFFIXES:
                raise ValueError(f"Unexpected plugin artifact: {path}")
            data = file.read_bytes()
            if path not in entries or path not in tracked:
                raise ValueError(f"Untracked plugin artifact: {path}")
            pending[path] = data
    source_hashes = {path: hashlib.sha256(data).hexdigest() for path, data in pending.items()}
    for path, data in list(pending.items()):
        if path.startswith("modules/"):
            pending[path] = render(data.decode("utf-8-sig"), set(pending), path.endswith(".yaml")).encode()
    # Prepare the complete snapshot before changing the published directory.
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    report = {"source_repository": "felixbennettio/proxy_plugins", "source_commit": revision,
              "files": [{"path": PREFIX + path, "source_sha256": source_hashes[path],
                         "source_manifest_sha256": entries[path]["sha256"],
                         "sha256": hashlib.sha256(data).hexdigest()}
                        for path, data in sorted(pending.items())]}
    destination = root / PREFIX
    for path, data in pending.items():
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    for folder in ("modules", "scripts", "rules"):
        for file in (destination / folder).rglob("*"):
            if file.is_file() and file.relative_to(destination).as_posix() not in pending:
                file.unlink()
    (destination / "MANIFEST.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Published {len(pending)} Egern plugin files from {revision[:12]}")
    return report


def publish_wloc(root: Path = ROOT) -> None:
    def download(url: str) -> bytes:
        if not re.fullmatch(r"https://wloc\.app/(?:modules/wloc\.sgmodule|scripts/[A-Za-z0-9_.-]+\.js(?:\?v=[A-Za-z0-9_.-]+)?)", url):
            raise ValueError("Unexpected Wloc dependency")
        request = urllib.request.Request(url, headers={"User-Agent": "Surge/6.9.1"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    data = response.read(8 * 1024 * 1024 + 1)
                break
            except (OSError, http.client.HTTPException):
                if attempt == 3:
                    raise
                time.sleep(1)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("Wloc asset exceeds limit")
        return data

    module_url = "https://wloc.app/modules/wloc.sgmodule"
    data = download(module_url)
    text = validate(data, "module", "WLOC Control Center")
    urls = {match["url"] for match in SCRIPT_RE.finditer(text)}
    paths = {url: PREFIX + "wloc/" + url.split("/")[-1].split("?")[0] for url in urls}
    pending = {}
    sources = [{"url": module_url, "sha256": hashlib.sha256(data).hexdigest()}]
    for url, path in sorted(paths.items()):
        script = download(url)
        validate(script, "script")
        pending[path] = script
        sources.append({"url": url, "path": path, "sha256": hashlib.sha256(script).hexdigest()})
    pending[PREFIX + "wloc.sgmodule"] = render_module(text, paths, "https://git.routeforge.zone", 13).encode()
    for path, content in pending.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (root / PREFIX / "WLOC.json").write_text(json.dumps({"sources": sources}, indent=2) + "\n")
    print(f"Published Wloc module and {len(paths)} scripts")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    args = parser.parse_args()
    if args.source:
        publish(args.source)
        return
    with tempfile.TemporaryDirectory(prefix="egern-plugins-") as temporary:
        source = Path(temporary) / "source"
        subprocess.run(["git", "-c", "credential.helper=", "clone", "--quiet", "--depth", "1", SOURCE, str(source)], check=True)
        publish(source)
    publish_wloc()


if __name__ == "__main__":
    main()
