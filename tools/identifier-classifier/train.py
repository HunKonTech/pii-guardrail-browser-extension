"""Fine-tune a small code encoder to tell a snippet's own identifiers from library names.

Token classification with BIO tags over identifiers:
    O, B-OWN, I-OWN, B-LIB, I-LIB
Identifiers the extractors could not decide (IGN) are left out of the loss.

An OWN name predicted LIB is kept unrenamed and leaks into the prompt; a LIB
name predicted OWN is only renamed (and restored on copy-back), which makes
the code harder for the chat model to read. So the extension keeps a name
only when P(LIB) clears a high threshold, and the score that matters is
`lib_recall_at_own98`: the share of library names kept at the threshold
(`lib_threshold_own98`) that still renames 98% of the user's names.

Long runs are resumable: rerunning the same command continues from the last
checkpoint (hourly). `--hours` fits the run into a time budget, which is how
a CPU-only machine should use it.

Usage:
    python train.py --data work/dataset --out work/model
    python train.py --data work/dataset --out work/model --cpu --hours 36
    python train.py --data work/dataset --out work/model --base-model microsoft/unixcoder-base --epochs 4
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset
from transformers import (
    AutoModelForTokenClassification,
    AutoTokenizer,
    DataCollatorForTokenClassification,
    Trainer,
    TrainingArguments,
    set_seed,
)

HERE = Path(__file__).resolve().parent

LABELS = ["O", "B-OWN", "I-OWN", "B-LIB", "I-LIB"]
LABEL2ID = {label: index for index, label in enumerate(LABELS)}
IGNORE = -100


def read_jsonl(path: Path, limit: int = 0) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            rows.append(json.loads(line))
            if limit and len(rows) >= limit:
                break
    return rows


def encode(row: dict, tokenizer, max_length: int) -> dict:
    text: str = row["text"]
    # Which span covers each character (-1: none).
    owner = [-1] * len(text)
    for index, (start, end, _label) in enumerate(row["spans"]):
        for position in range(start, min(end, len(text))):
            owner[position] = index

    encoding = tokenizer(text, truncation=True, max_length=max_length, return_offsets_mapping=True)
    labels = []
    for start, end in encoding.pop("offset_mapping"):
        if start == end:  # special token
            labels.append(IGNORE)
            continue
        span_index = next((owner[p] for p in range(start, min(end, len(text))) if owner[p] != -1), -1)
        if span_index == -1:
            labels.append(LABEL2ID["O"])
            continue
        span_start, _span_end, label = row["spans"][span_index]
        if label == "IGN":
            labels.append(IGNORE)
            continue
        prefix = "B" if start <= span_start else "I"
        labels.append(LABEL2ID[f"{prefix}-{label}"])
    encoding["labels"] = labels
    return encoding


class SnippetDataset(Dataset):
    """Encoded snippets kept as compact arrays: a list of Python ints per token
    would take gigabytes for the full dataset."""

    def __init__(self, rows: list[dict], tokenizer, max_length: int):
        self.ids: list[np.ndarray] = []
        self.labels: list[np.ndarray] = []
        for row in rows:
            encoding = encode(row, tokenizer, max_length)
            self.ids.append(np.asarray(encoding["input_ids"], dtype=np.int32))
            self.labels.append(np.asarray(encoding["labels"], dtype=np.int16))

    def __len__(self) -> int:
        return len(self.ids)

    def __getitem__(self, index: int) -> dict:
        ids = self.ids[index].tolist()
        return {"input_ids": ids, "attention_mask": [1] * len(ids), "labels": self.labels[index].tolist()}


def identifier_metrics(eval_prediction) -> dict:
    """Score each identifier on its first token: OWN (B-OWN + I-OWN) against LIB (B-LIB + I-LIB)."""
    logits, labels = eval_prediction
    logits = torch.tensor(logits)
    probs = torch.softmax(logits, dim=-1).numpy()
    labels = np.asarray(labels)
    first = (labels == LABEL2ID["B-OWN"]) | (labels == LABEL2ID["B-LIB"])
    gold_own = labels[first] == LABEL2ID["B-OWN"]
    p = probs[first]
    pred_own = (p[:, LABEL2ID["B-OWN"]] + p[:, LABEL2ID["I-OWN"]]) >= (p[:, LABEL2ID["B-LIB"]] + p[:, LABEL2ID["I-LIB"]])

    # The extension keeps a name only when P(LIB) clears a threshold. Pick the
    # threshold that still renames 98% of OWN names and report how many LIB
    # names survive it: that is the model's real usefulness at a fixed leak rate.
    lib_share = (p[:, LABEL2ID["B-LIB"]] + p[:, LABEL2ID["I-LIB"]]) / np.maximum(
        1e-9, p[:, LABEL2ID["B-OWN"]] + p[:, LABEL2ID["I-OWN"]] + p[:, LABEL2ID["B-LIB"]] + p[:, LABEL2ID["I-LIB"]]
    )
    threshold = float(np.quantile(lib_share[gold_own], 0.98)) if gold_own.any() else 0.5
    lib_kept_at_own98 = float((lib_share[~gold_own] > threshold).mean()) if (~gold_own).any() else 0.0

    own_total = max(1, int(gold_own.sum()))
    lib_total = max(1, int((~gold_own).sum()))
    own_recall = float((pred_own & gold_own).sum() / own_total)
    lib_recall = float((~pred_own & ~gold_own).sum() / lib_total)
    return {
        "identifiers": int(first.sum()),
        "accuracy": float((pred_own == gold_own).mean()) if first.any() else 0.0,
        "own_recall": own_recall,
        "lib_recall": lib_recall,
        "leak_rate": 1.0 - own_recall,
        "balanced_accuracy": (own_recall + lib_recall) / 2,
        "lib_threshold_own98": threshold,
        "lib_recall_at_own98": lib_kept_at_own98,
    }


def keep_awake() -> None:
    """Keep Windows from sleeping while this process runs (a sleeping PC stops training)."""
    if sys.platform != "win32":
        return
    import ctypes

    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)


def seconds_per_step(model, dataset: Dataset, collator, batch_size: int, grad_accum: int, device: torch.device) -> float:
    """Time a few optimizer steps' worth of forward + backward passes. Weights are not changed."""
    rng = random.Random(0)
    model.to(device).train()
    timings = []
    for step in range(3):
        started = time.perf_counter()
        for _ in range(grad_accum):
            batch = collator([dataset[rng.randrange(len(dataset))] for _ in range(batch_size)])
            loss = model(**{k: v.to(device) for k, v in batch.items()}).loss
            loss.backward()
        model.zero_grad(set_to_none=True)
        if step > 0:  # the first step pays for warm-up
            timings.append(time.perf_counter() - started)
    return sum(timings) / len(timings)


def latest_checkpoint(directory: Path) -> str | None:
    checkpoints = sorted(directory.glob("checkpoint-*"), key=lambda p: int(p.name.split("-")[-1]))
    return str(checkpoints[-1]) if checkpoints else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=HERE / "work" / "dataset")
    parser.add_argument("--out", type=Path, default=HERE / "work" / "model")
    parser.add_argument("--base-model", default="huggingface/CodeBERTa-small-v1")
    parser.add_argument("--epochs", type=float, default=3, help="upper bound; the time budget may stop earlier")
    parser.add_argument("--hours", type=float, default=0, help="time budget for training; 0 = no budget, just --epochs")
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--val-limit", type=int, default=2000, help="validation snippets scored during training")
    parser.add_argument("--limit", type=int, default=0, help="use only the first N training rows (smoke tests)")
    parser.add_argument("--max-steps", type=int, default=-1)
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--cpu", action="store_true", help="train on the CPU even when a GPU is available")
    parser.add_argument("--fresh", action="store_true", help="discard earlier checkpoints instead of resuming")
    args = parser.parse_args()

    keep_awake()
    set_seed(args.seed)
    checkpoints = args.out / "checkpoints"
    plan_path = args.out / "plan.json"
    if args.fresh and args.out.exists():
        shutil.rmtree(args.out)
    resume_from = latest_checkpoint(checkpoints)
    plan = json.loads(plan_path.read_text(encoding="utf-8")) if resume_from and plan_path.exists() else None
    if plan:
        # Resuming: keep the model, schedule and step count the run started with.
        args.base_model, args.batch_size, args.grad_accum = plan["base_model"], plan["batch_size"], plan["grad_accum"]
        print(f"Resuming from {resume_from} (planned {plan['max_steps']} steps)")

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, add_prefix_space=False)
    if not tokenizer.is_fast:
        raise SystemExit("A fast tokenizer is required (offset mappings).")
    model = AutoModelForTokenClassification.from_pretrained(
        args.base_model,
        num_labels=len(LABELS),
        id2label=dict(enumerate(LABELS)),
        label2id=LABEL2ID,
    )

    train_rows = read_jsonl(args.data / "train.jsonl", args.limit)
    val_rows = read_jsonl(args.data / "val.jsonl", args.val_limit)
    print(f"train {len(train_rows)} snippets, val {len(val_rows)} snippets")
    print("Tokenizing...", flush=True)
    train_set = SnippetDataset(train_rows, tokenizer, args.max_length)
    val_set = SnippetDataset(val_rows, tokenizer, args.max_length)
    collator = DataCollatorForTokenClassification(tokenizer)

    cuda = torch.cuda.is_available() and not args.cpu
    device = torch.device("cuda" if cuda else "cpu")
    print(f"Device: {device}" + ("" if cuda else f", {torch.get_num_threads()} CPU threads"))
    steps_per_epoch = math.ceil(len(train_set) / (args.batch_size * args.grad_accum))

    if plan:
        max_steps, eval_steps = plan["max_steps"], plan["eval_steps"]
    else:
        step_seconds = seconds_per_step(model, train_set, collator, args.batch_size, args.grad_accum, device)
        # Length-grouped batches carry less padding than the random ones timed.
        step_seconds *= 0.8
        max_steps = args.max_steps if args.max_steps > 0 else math.ceil(args.epochs * steps_per_epoch)
        if args.hours > 0:
            # Leave a tenth of the budget for evaluation and checkpoints.
            max_steps = min(max_steps, int(args.hours * 3600 * 0.9 / step_seconds))
        max_steps = max(1, max_steps)
        # Evaluate and checkpoint about once an hour (at least every quarter of the run).
        eval_steps = max(1, min(int(3600 / step_seconds), max_steps // 4 or 1))
        plan = {
            "base_model": args.base_model,
            "batch_size": args.batch_size,
            "grad_accum": args.grad_accum,
            "max_steps": max_steps,
            "eval_steps": eval_steps,
            "seconds_per_step": round(step_seconds, 3),
        }
        args.out.mkdir(parents=True, exist_ok=True)
        plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
        hours = max_steps * step_seconds / 3600
        print(
            f"{step_seconds:.2f} s/step -> {max_steps} steps "
            f"({max_steps / steps_per_epoch:.2f} epochs), about {hours:.1f} h of training, "
            f"checkpoint every {eval_steps} steps"
        )

    training_args = TrainingArguments(
        output_dir=str(checkpoints),
        max_steps=max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size * 2,
        gradient_accumulation_steps=args.grad_accum,
        group_by_length=True,
        warmup_ratio=0.06,
        weight_decay=0.01,
        eval_strategy="steps",
        eval_steps=eval_steps,
        save_strategy="steps",
        save_steps=eval_steps,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="lib_recall_at_own98",
        greater_is_better=True,
        logging_steps=max(1, min(50, eval_steps // 10)),
        fp16=cuda,
        use_cpu=not cuda,
        dataloader_num_workers=0,
        report_to="none",
        seed=args.seed,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_set,
        eval_dataset=val_set,
        data_collator=collator,
        compute_metrics=identifier_metrics,
    )
    trainer.train(resume_from_checkpoint=resume_from)

    final = args.out / "final"
    trainer.save_model(str(final))
    tokenizer.save_pretrained(str(final))
    metrics = trainer.evaluate()
    test_path = args.data / "test.jsonl"
    if test_path.exists() and test_path.stat().st_size > 0:
        print("Scoring the held-out test repositories...", flush=True)
        test_set = SnippetDataset(read_jsonl(test_path), tokenizer, args.max_length)
        metrics.update(trainer.evaluate(test_set, metric_key_prefix="test"))
    (final / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    print(f"Model saved to {final}")


if __name__ == "__main__":
    main()
