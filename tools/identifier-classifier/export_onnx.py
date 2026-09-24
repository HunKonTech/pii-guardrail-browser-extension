"""Export the trained classifier to ONNX in the layout the extension's NER models use.

    <out>/config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json
    <out>/onnx/model.onnx             float32
    <out>/onnx/model_quantized.onnx   int8 dynamic quantization (what the extension loads)

Then checks that the quantized model agrees with the PyTorch model on the
test snippets.

Usage:
    python export_onnx.py --model work/model/final --out work/export/code-identifier-classifier
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from optimum.exporters.onnx import main_export
from transformers import AutoModelForTokenClassification, AutoTokenizer

HERE = Path(__file__).resolve().parent
TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt"]


def agreement(model_dir: Path, onnx_path: Path, samples: list[str]) -> float:
    tokenizer = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForTokenClassification.from_pretrained(model_dir).eval()
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_names = {i.name for i in session.get_inputs()}
    same = total = 0
    for text in samples:
        encoded = tokenizer(text, truncation=True, max_length=512, return_tensors="np")
        feeds = {name: encoded[name].astype(np.int64) for name in input_names if name in encoded}
        onnx_labels = session.run(None, feeds)[0].argmax(-1)
        with torch.no_grad():
            torch_labels = model(**{k: torch.from_numpy(v) for k, v in feeds.items()}).logits.argmax(-1).numpy()
        same += int((onnx_labels == torch_labels).sum())
        total += onnx_labels.size
    return same / max(1, total)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", type=Path, default=HERE / "work" / "model" / "final")
    parser.add_argument("--out", type=Path, default=HERE / "work" / "export" / "code-identifier-classifier")
    parser.add_argument("--test", type=Path, default=HERE / "work" / "dataset" / "test.jsonl")
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    staging = args.out / "_staging"
    if args.out.exists():
        shutil.rmtree(args.out)
    main_export(str(args.model), output=str(staging), task="token-classification", opset=args.opset)

    onnx_dir = args.out / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(staging / "model.onnx"), onnx_dir / "model.onnx")
    for name in ["config.json", *TOKENIZER_FILES]:
        source = staging / name if (staging / name).exists() else args.model / name
        if source.exists():
            shutil.copy2(source, args.out / name)
    shutil.rmtree(staging, ignore_errors=True)

    quantize_dynamic(str(onnx_dir / "model.onnx"), str(onnx_dir / "model_quantized.onnx"), weight_type=QuantType.QInt8)

    samples = []
    if args.test.exists():
        with open(args.test, encoding="utf-8") as handle:
            for line in handle:
                samples.append(json.loads(line)["text"])
                if len(samples) >= 50:
                    break
    if samples:
        rate = agreement(args.model, onnx_dir / "model_quantized.onnx", samples)
        print(f"int8 ONNX agrees with PyTorch on {rate:.2%} of tokens")

    for path in sorted(args.out.rglob("*")):
        if path.is_file():
            print(f"  {path.relative_to(args.out)}  {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
