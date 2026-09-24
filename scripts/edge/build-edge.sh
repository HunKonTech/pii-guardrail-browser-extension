#!/usr/bin/env bash
# Build the Microsoft Edge package on macOS / Linux.
# Usage: scripts/edge/build-edge.sh [--skip-build] [--require-model]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# rustup installs cargo and wasm-bindgen here without always adding it to PATH.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

node scripts/edge/build-edge.js "$@"
