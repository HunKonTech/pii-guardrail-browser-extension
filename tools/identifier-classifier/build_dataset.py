"""Cut paste-sized snippets out of the labelled files and split them by repository.

The extractors label identifiers knowing the whole repository. A pasted
snippet is a few lines out of the middle of a file, so the model has to
learn to tell the two apart from the snippet alone. Each window keeps the
labels the whole-repository analysis gave it.

The split is by repository, never by file: files of one project share names,
and a model tested on a project it was trained on would look better than it
is.

Output: train.jsonl / val.jsonl / test.jsonl with lines
    {"repo", "lang", "text", "spans": [[start, end, "OWN"|"LIB"|"IGN"], ...]}
with code-point offsets (Python string indices).

Usage:
    python build_dataset.py --inputs work/labels/*.jsonl --out work/dataset
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent

MIN_LINES, MAX_LINES = 3, 40
MAX_CHARS = 2500
MIN_LABELLED = 3


def utf16_to_codepoint_map(text: str) -> list[int] | None:
    """Map UTF-16 offsets to string indices; None when they coincide (BMP-only text)."""
    if all(ord(ch) <= 0xFFFF for ch in text):
        return None
    mapping: list[int] = []
    for index, ch in enumerate(text):
        mapping.append(index)
        if ord(ch) > 0xFFFF:
            mapping.append(index)
    mapping.append(len(text))
    return mapping


def split_of(repo: str, test_repos: set[str], val_repos: set[str]) -> str:
    if repo in test_repos:
        return "test"
    if repo in val_repos:
        return "val"
    if test_repos or val_repos:
        return "train"
    bucket = int(hashlib.sha1(repo.encode("utf-8")).hexdigest(), 16) % 10
    return "test" if bucket == 0 else "val" if bucket == 1 else "train"


def windows(record: dict, rng: random.Random, per_file: int) -> list[dict]:
    # Offsets point into the text as extracted: never normalise line endings here.
    text: str = record["text"]
    mapping = utf16_to_codepoint_map(text)
    spans = []
    for start, end, label in record["ids"]:
        if mapping is not None:
            start, end = mapping[start], mapping[end]
        spans.append((start, end, label))

    line_starts = [0]
    for index, ch in enumerate(text):
        if ch == "\n":
            line_starts.append(index + 1)
    line_count = len(line_starts)
    line_starts.append(len(text) + 1)

    out = []
    wanted = min(per_file, max(1, line_count // 15))
    for _ in range(wanted * 3):
        if len(out) >= wanted:
            break
        length = min(line_count, int(rng.triangular(MIN_LINES, MAX_LINES, 12)))
        first = rng.randrange(0, max(1, line_count - length + 1))
        start = line_starts[first]
        end = min(line_starts[min(first + length, line_count)] - 1, len(text))
        if end - start > MAX_CHARS:
            end = text.rfind("\n", start, start + MAX_CHARS)
            if end <= start:
                continue
        snippet = text[start:end]
        if not snippet.strip():
            continue
        inside = [(s - start, e - start, label) for s, e, label in spans if s >= start and e <= end]
        if sum(1 for *_, label in inside if label != "IGN") < MIN_LABELLED:
            continue
        # Search boxes and chat inputs sometimes flatten a paste to one line.
        # Replacing newlines by spaces keeps every offset valid.
        if rng.random() < 0.05:
            snippet = snippet.replace("\r\n", "  ").replace("\n", " ")
        out.append({"repo": record["repo"], "lang": record["lang"], "text": snippet, "spans": inside})
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--inputs", nargs="+", default=[str(HERE / "work" / "labels" / "*.jsonl")])
    parser.add_argument("--out", type=Path, default=HERE / "work" / "dataset")
    parser.add_argument("--per-file", type=int, default=6, help="at most this many snippets per source file")
    parser.add_argument("--per-repo", type=int, default=8000, help="at most this many snippets per repository")
    parser.add_argument("--test-repos", nargs="*", default=[], help="repository dirs (owner__name) held out for test")
    parser.add_argument("--val-repos", nargs="*", default=[], help="repository dirs (owner__name) held out for validation")
    parser.add_argument("--seed", type=int, default=13)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    by_repo: dict[str, list[dict]] = defaultdict(list)
    files = sorted({path for pattern in args.inputs for path in glob.glob(pattern)})
    if not files:
        raise SystemExit(f"no input files match {args.inputs}")
    for path in files:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                record = json.loads(line)
                by_repo[record["repo"]].extend(windows(record, rng, args.per_file))

    args.out.mkdir(parents=True, exist_ok=True)
    handles = {name: open(args.out / f"{name}.jsonl", "w", encoding="utf-8") for name in ("train", "val", "test")}
    seen: set[str] = set()
    stats: dict[str, Counter] = defaultdict(Counter)
    for repo in sorted(by_repo):
        snippets = by_repo[repo]
        rng.shuffle(snippets)
        split = split_of(repo, set(args.test_repos), set(args.val_repos))
        kept = 0
        for snippet in snippets:
            if kept >= args.per_repo:
                break
            digest = hashlib.sha1(snippet["text"].encode("utf-8")).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            handles[split].write(json.dumps(snippet, ensure_ascii=False) + "\n")
            kept += 1
            stats[split]["snippets"] += 1
            for *_, label in snippet["spans"]:
                stats[split][label] += 1
        stats[split]["repos"] += 1
    for handle in handles.values():
        handle.close()

    for split in ("train", "val", "test"):
        print(f"{split:5s} {dict(stats[split])}")


if __name__ == "__main__":
    main()
