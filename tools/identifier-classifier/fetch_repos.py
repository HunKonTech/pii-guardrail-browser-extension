"""Clone the training repositories and, optionally, restore their dependencies.

Restoring lets the extractors resolve package names to their real
definitions (`IOptions`, `express`) instead of guessing that an unresolved
name is external. It is optional: without it the extractors still label
every name the repository declares as OWN and every unresolved name the
repository does not declare as LIB.

Security: `dotnet restore` evaluates the repository's MSBuild files, which can
run code. Only restore repositories you trust. npm is run with
`--ignore-scripts`, so package install scripts do not run.

Usage:
    python fetch_repos.py --out work/repos [--restore] [--lang csharp|typescript]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 1800) -> bool:
    print("  $", " ".join(cmd), flush=True)
    try:
        result = subprocess.run(cmd, cwd=cwd, timeout=timeout, shell=sys.platform == "win32" and cmd[0] in ("npm", "npx"))
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"  ! {error}", flush=True)
        return False
    if result.returncode != 0:
        print(f"  ! exited with {result.returncode}", flush=True)
    return result.returncode == 0


def repo_dir(out: Path, lang: str, url: str) -> Path:
    owner, name = url.rstrip("/").split("/")[-2:]
    return out / lang / f"{owner}__{name}"


def restore_typescript(path: Path) -> None:
    if not (path / "package.json").exists() or shutil.which("npm") is None:
        return
    run(
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--loglevel=error"],
        cwd=path,
    )


def restore_csharp(path: Path) -> None:
    if shutil.which("dotnet") is None:
        print("  ! dotnet not found, skipping restore", flush=True)
        return
    # The solution nearest the root is the main one (eShop: eShop.slnx, not
    # src/ClientApp/ClientApp.sln). Restore errors in single projects (e.g. a
    # MAUI project without the workload) only cost those projects' packages.
    solutions = sorted(
        [*path.rglob("*.sln"), *path.rglob("*.slnx")],
        key=lambda p: (len(p.relative_to(path).parts), p.suffix != ".slnx", str(p)),
    )
    targets = solutions[:1] if solutions else sorted(path.rglob("*.csproj"))
    # A global.json pinning an SDK that is not installed fails the restore.
    # Nothing is built, so any installed SDK will do: set it aside meanwhile.
    pins = [pin for pin in path.rglob("global.json") if "node_modules" not in pin.parts]
    for pin in pins:
        pin.rename(pin.with_suffix(".json.pg-disabled"))
    try:
        for target in targets:
            run(["dotnet", "restore", str(target), "--verbosity", "quiet"], cwd=path)
    finally:
        for pin in pins:
            pin.with_suffix(".json.pg-disabled").rename(pin)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=HERE / "work" / "repos")
    parser.add_argument("--repos", type=Path, default=HERE / "repos.json")
    parser.add_argument("--lang", choices=["csharp", "typescript"], action="append")
    parser.add_argument("--restore", action="store_true", help="restore dependencies (see the security note)")
    parser.add_argument("--limit", type=int, default=0, help="only the first N repositories per language")
    args = parser.parse_args()

    catalogue = json.loads(args.repos.read_text(encoding="utf-8"))
    languages = args.lang or ["csharp", "typescript"]
    for lang in languages:
        urls = catalogue[lang][: args.limit or None]
        for url in urls:
            target = repo_dir(args.out, lang, url)
            print(f"[{lang}] {url}", flush=True)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if not run(["git", "-c", "core.longpaths=true", "clone", "--depth", "1", "--quiet", url, str(target)]):
                    # A half-cloned directory would be taken for a finished one next time.
                    shutil.rmtree(target, ignore_errors=True)
                    continue
            if args.restore:
                (restore_csharp if lang == "csharp" else restore_typescript)(target)


if __name__ == "__main__":
    main()
