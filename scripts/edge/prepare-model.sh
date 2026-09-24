#!/usr/bin/env bash
# Prepare the Local AI (BardsAI EU multilingual NER) model assets so the
# extension build can include them. One-time step; see
# docs/developer/model-assets.md for what each stage does.
#
# Writes only to Git-ignored project folders:
#   .venv/            Python conversion tools
#   .model-sources/   upstream model download
#   generated/models/ prepared runtime model
#
# Usage: scripts/edge/prepare-model.sh [--python <python3.10+>] [--force]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MODEL_ID="bardsai/eu-pii-anonimization-multilang"
MODEL_REVISION="6de9f686549277a3dd4233ebce14d8117ffbe128"
SOURCE_DIR=".model-sources/bardsai-eu-pii-anonimization-multilang"
OUTPUT_DIR="generated/models/ner/bardsai-eu-pii-anonimization-multilang"
BASE_PYTHON=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --python) BASE_PYTHON="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$FORCE" -eq 0 ] && [ -f "$OUTPUT_DIR/onnx/model_q4f16.onnx.data" ]; then
  echo "Model already prepared in $OUTPUT_DIR (use --force to rebuild)."
  exit 0
fi

# The conversion tools (tokenizers, onnxruntime) ship prebuilt wheels for
# established Python releases first; the newest release can lack them.
if [ -z "$BASE_PYTHON" ]; then
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      BASE_PYTHON="$candidate"
      break
    fi
  done
fi

if [ -x .venv/bin/python ] && ! .venv/bin/python -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)'; then
  echo "Recreating .venv with $BASE_PYTHON"
  rm -rf .venv
fi

if ! "$BASE_PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python 3.10 or newer is required (got $("$BASE_PYTHON" --version 2>&1))." >&2
  exit 1
fi

echo "> Python environment (.venv)"
if [ ! -x .venv/bin/python ]; then
  "$BASE_PYTHON" -m venv .venv
fi
.venv/bin/python -m pip install --quiet -U pip
# Binary wheels only: without this the resolver can backtrack to an old
# tokenizers release that has to be compiled from source (and no longer
# compiles). The `hf` CLI ships with huggingface_hub itself.
.venv/bin/python -m pip install --quiet --only-binary=:all: -U huggingface_hub numpy onnx onnxruntime onnx-ir sympy tokenizers

echo "> Downloading $MODEL_ID@$MODEL_REVISION"
mkdir -p "$SOURCE_DIR"
.venv/bin/hf download "$MODEL_ID" \
  --revision "$MODEL_REVISION" \
  --include "config.json" \
  --include "tokenizer.json" \
  --include "tokenizer_config.json" \
  --include "vocab.txt" \
  --include "special_tokens_map.json" \
  --include "onnx/model.onnx" \
  --include "onnx/model_quantized.onnx" \
  --include "onnx/model_fp16.onnx" \
  --local-dir "$SOURCE_DIR"

BASELINE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bardsai-fp16-baseline.XXXXXX")"
trap 'rm -rf "$BASELINE_DIR"' EXIT

echo "> Preparing fp16 baseline"
node scripts/prepare-bardsai-model.js \
  --source-dir "$SOURCE_DIR" \
  --output-dir "$BASELINE_DIR" \
  --python .venv/bin/python \
  --force

node scripts/convert-onnx-to-external-data.js \
  --input "$BASELINE_DIR/onnx/model_fp16.onnx" \
  --python .venv/bin/python \
  --force

echo "> Optimizing to q4f16"
node scripts/optimize-bardsai-model.js \
  --source-dir "$BASELINE_DIR" \
  --output-dir "$OUTPUT_DIR" \
  --python .venv/bin/python \
  --force

echo
echo "Model ready in $OUTPUT_DIR"
echo "Build with Local AI: scripts/edge/build-edge.sh --require-model"
