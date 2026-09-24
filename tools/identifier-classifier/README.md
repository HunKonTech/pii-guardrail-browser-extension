# Code identifier classifier

Trains the small model that tells, for every identifier in a pasted snippet,
whether it is the user's **own** name (renamed before the paste) or a
**library** name (`Console`, `Math.max`, `IOptions`, `res.status`), which is
kept so the chat model can still read the code. It replaces the hand-written
`LIBRARY_NAMES` list in `src/shared/code-rename.ts`.

It is a token-classification ("NER") model like the extension's PII models:
a ~84M-parameter code encoder, fine-tuned on BIO tags `B-OWN I-OWN B-LIB I-LIB O`,
exported to int8 ONNX (~85 MB).

## How the labels are made

No hand labelling. Real open-source projects are compiled, and every
identifier is resolved against the **whole** repository:

| Label | Meaning |
|---|---|
| `OWN` | resolves to a declaration in the repository's own source |
| `LIB` | resolves to the framework / a package, overrides or implements a library member (`ToString`, `Dispose`), or does not resolve and the repository declares no such name |
| `IGN` | does not resolve, but the repository declares the name: left out of training |

Then paste-sized windows (3–40 lines, sometimes flattened to one line) are
cut out of the files. The model sees only the window but learns the labels
the whole-repository analysis gave, which is exactly the situation of a paste.

- C#: Roslyn (`extract-cs`), one ad-hoc compilation per repository with the
  .NET shared frameworks and the restored NuGet packages as references.
  No MSBuild build runs.
- TypeScript / JavaScript: the TypeScript checker (`extract-ts`), with
  `lib.d.ts` and, when installed, `node_modules`.

The split into train / val / test is by repository, so the scores are for
projects the model has never seen.

## Running it on Windows

Prerequisites:

- Git
- Node.js 20+
- .NET SDK 8 or newer
- Python 3.10–3.12
- a CPU is enough: training fits itself into a time budget (default 36 hours)

```powershell
cd tools\identifier-classifier
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# PyTorch first. CPU only:
pip install torch --index-url https://download.pytorch.org/whl/cpu
# (with an NVIDIA GPU instead: --index-url https://download.pytorch.org/whl/cu124)
pip install -r requirements.txt

.\run_all.ps1
```

`run_all.ps1` runs five steps; `-From <step>` restarts at a later one:

| Step | What it does | Output |
|---|---|---|
| `fetch` | clones the repositories in `repos.json`, runs `npm install --ignore-scripts` / `dotnet restore` | `work\repos` |
| `label` | labels every identifier | `work\labels\*.jsonl` |
| `dataset` | cuts snippets, splits by repository | `work\dataset\{train,val,test}.jsonl` |
| `train` | fine-tunes the model | `work\model\final` (+ `metrics.json`) |
| `export` | ONNX + int8, checks agreement with PyTorch | `work\export\code-identifier-classifier` |

Options: `-NoRestore` (skip dependency restore), `-Hours`, `-BaseModel`, `-Epochs`, `-BatchSize`.

### Long CPU runs

- **Time budget.** Before training, `train.py` times a few steps and sets the
  number of steps so the run ends within `-Hours` (default 36; at most
  `-Epochs` passes over the data). It prints the plan, e.g.
  `1.40 s/step -> 83000 steps (2.10 epochs), about 32.3 h of training`.
- **Resuming.** A checkpoint is written about once an hour to
  `work\model\checkpoints`. After a restart, a crash or a closed window, run
  `.\run_all.ps1 -From train`: it continues from the last checkpoint with the
  same plan. `python train.py --fresh` starts over.
- **Sleep.** While training runs, Windows is told not to go to sleep. Turn
  off automatic *restarts* for updates for those days (Settings → Windows
  Update → Pause updates), since a restart ends the process (resume as above).
- **Memory.** About 2–4 GB of RAM with the default model. Lower
  `-BatchSize` (e.g. 8) if the PC starts swapping.
- Progress: the console shows steps and, every checkpoint, the validation
  scores (`eval_lib_recall_at_own98` should rise over time).

**Security:** `dotnet restore` evaluates the repositories' MSBuild files, which
can run code. `repos.json` lists well-known projects; if you add your own,
add only repositories you trust, or use `-NoRestore`.

Rough budget with the default 40 repositories: 15–20 GB disk (mostly
`node_modules` and NuGet packages), 30–90 minutes for fetch + label, then
the training budget (`-Hours`, default 36) on a CPU, or 1–3 hours on an
NVIDIA GPU.

## Reading the result

`work\model\final\metrics.json` holds, for validation and `test_*`:

- `lib_recall_at_own98`: **the main score.** The extension keeps a name only
  when the model is confident it is a library name, with the threshold
  (`lib_threshold_own98`) set so that 98% of the user's own names are still
  renamed. This is the share of library names that are then kept readable.
  Higher is better; the best checkpoint is chosen by it.
- `own_recall` / `lib_recall` / `leak_rate`: the same at a plain 50/50 cut.

A missed own name leaks into the prompt, a missed library name is only
renamed (and restored on copy-back), which is why the threshold favours
renaming.

Try it on your own code:

```powershell
python predict.py --model work\model\final C:\path\to\SomeFile.cs
```

## Choosing the base model

| `-BaseModel` | Size | Notes |
|---|---|---|
| `huggingface/CodeBERTa-small-v1` (default) | 84M, ~85 MB int8 | smallest; pretrained without C#, learns it during fine-tuning |
| `microsoft/unixcoder-base` | 125M, ~125 MB int8 | stronger code understanding |
| `answerdotai/ModernBERT-base` | 149M, ~150 MB int8 | pretrained on code and text, long context |

Start with the default; switch only if `lib_recall_at_own98` stays low. On a
CPU a larger model means fewer training steps in the same `-Hours`.

## Adding data

Add repositories to `repos.json` (complete projects, permissive licences only)
and rerun from `fetch`. Python and Java would need their own extractor
(pyright / javac based) writing the same JSON lines.

## Handing the model to the extension

Copy the `work\export\code-identifier-classifier` folder back. Wiring it
into the extension (loading it in the offscreen document next to the NER
model, and using its OWN/LIB verdicts in `code-rename.ts` instead of the
`LIBRARY_NAMES` list) is a separate step.
