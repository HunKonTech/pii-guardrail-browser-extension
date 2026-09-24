"""Show what a trained model thinks of each identifier in a snippet.

Usage:
    python predict.py --model work/model/final snippet.cs
    echo "var total = Math.Max(ComputeTotal(rows), 0);" | python predict.py --model work/model/final -
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

HERE = Path(__file__).resolve().parent
IDENTIFIER_RE = re.compile(r"[^\W\d]\w*", re.UNICODE)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=HERE / "work" / "model" / "final")
    parser.add_argument("file", help="source file, or - for stdin")
    args = parser.parse_args()

    text = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForTokenClassification.from_pretrained(args.model).eval()
    label2id = model.config.label2id

    encoded = tokenizer(text, truncation=True, max_length=512, return_offsets_mapping=True, return_tensors="pt")
    offsets = encoded.pop("offset_mapping")[0].tolist()
    with torch.no_grad():
        probs = torch.softmax(model(**encoded).logits[0], dim=-1)

    seen = set()
    for match in IDENTIFIER_RE.finditer(text):
        token_index = next((i for i, (s, e) in enumerate(offsets) if s < e and s <= match.start() < e), None)
        if token_index is None:
            continue
        p = probs[token_index]
        own = float(p[label2id["B-OWN"]] + p[label2id["I-OWN"]])
        lib = float(p[label2id["B-LIB"]] + p[label2id["I-LIB"]])
        if own + lib < 0.5 or match.group() in seen:
            continue  # the model reads it as a keyword / not an identifier
        seen.add(match.group())
        verdict = "OWN" if own >= lib else "LIB"
        print(f"{verdict}  {own / (own + lib):5.2f}  {match.group()}")


if __name__ == "__main__":
    main()
