#!/usr/bin/env node

/**
 * One-command dev build for macOS.
 *
 * Checks the mac-specific toolchain this project's build needs (Xcode
 * Command Line Tools, Rust + the wasm32-unknown-unknown target, the
 * wasm-bindgen CLI pinned to the version in crate/Cargo.toml), adds the
 * wasm32 target automatically if it's missing, then runs the normal build:
 *
 *   1. npm run prepare:model:identifier-classifier (best effort; the model
 *      is optional, see docs/developer/model-assets.md)
 *   2. npm run build   (build:wasm + build:ext -> dist/)
 *
 * This is a Chrome extension, not a native app, so there is no code
 * signing or notarization step here — this script only gets a mac dev
 * machine's toolchain into shape and produces dist/, the same output
 * `npm run build` produces on any platform.
 *
 * Usage: node scripts/build-macos.js [--skip-model] [--require-model]
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CARGO_TOML_PATH = path.join(ROOT_DIR, 'crate', 'Cargo.toml');
const WASM_TARGET = 'wasm32-unknown-unknown';

function parseArgs(argv) {
  const options = { skipModel: false, requireModel: false };
  for (const arg of argv) {
    if (arg === '--skip-model') options.skipModel = true;
    else if (arg === '--require-model') options.requireModel = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}\nUsage: node scripts/build-macos.js [--skip-model] [--require-model]`);
  }
  return options;
}

function usage() {
  return `
One-command dev build for macOS: checks the Rust/wasm toolchain, prepares the
optional identifier-classifier model, then runs 'npm run build'.

Usage: node scripts/build-macos.js [--skip-model] [--require-model]

Options:
  --skip-model      Don't attempt to prepare the identifier-classifier model.
  --require-model   Fail the build if the identifier-classifier model can't be prepared.
  --help            Show this help.
`.trim();
}

function commandExists(command) {
  return childProcess.spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

function run(label, command, args, options = {}) {
  console.log(`\n> ${label}`);
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

function readRequiredWasmBindgenVersion() {
  const contents = fs.readFileSync(CARGO_TOML_PATH, 'utf8');
  const match = contents.match(/^wasm-bindgen\s*=\s*"=?([^"]+)"/m);
  return match ? match[1] : null;
}

function getInstalledWasmTargets() {
  const result = childProcess.spawnSync('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function assertToolchain() {
  const missing = [];

  if (childProcess.spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) {
    missing.push('Xcode Command Line Tools (run `xcode-select --install`)');
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'node_modules'))) {
    missing.push('node_modules (run `npm install`)');
  }
  if (!commandExists('cargo') || !commandExists('rustup')) {
    missing.push('Rust + rustup (install from https://rustup.rs)');
  } else if (!getInstalledWasmTargets().includes(WASM_TARGET)) {
    console.log(`Installing missing Rust target ${WASM_TARGET} ...`);
    if (!run(`rustup target add ${WASM_TARGET}`, 'rustup', ['target', 'add', WASM_TARGET])) {
      missing.push(`${WASM_TARGET} Rust target (run \`rustup target add ${WASM_TARGET}\`)`);
    }
  }

  const requiredWasmBindgenVersion = readRequiredWasmBindgenVersion();
  if (!commandExists('wasm-bindgen')) {
    missing.push(
      `wasm-bindgen CLI (run \`cargo install wasm-bindgen-cli --version ${requiredWasmBindgenVersion || 'x.y.z'}\`)`
    );
  } else if (requiredWasmBindgenVersion) {
    const versionResult = childProcess.spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
    const installedVersion = versionResult.stdout.trim().replace(/^wasm-bindgen\s+/, '');
    if (installedVersion && installedVersion !== requiredWasmBindgenVersion) {
      missing.push(
        `wasm-bindgen CLI ${requiredWasmBindgenVersion} (have ${installedVersion}; run ` +
          `\`cargo install wasm-bindgen-cli --version ${requiredWasmBindgenVersion} --force\`)`
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing build prerequisites:\n${missing.map((item) => `  - ${item}`).join('\n')}`);
  }
}

function prepareModel(options) {
  const ok = run('Prepare identifier-classifier model', 'npm', ['run', 'prepare:model:identifier-classifier']);
  if (!ok) {
    const message = 'Could not prepare the identifier-classifier model (see docs/developer/model-assets.md).';
    if (options.requireModel) throw new Error(message);
    console.warn(`\n${message} Continuing without it — code anonymization falls back to LIBRARY_NAMES.`);
  }
}

function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') {
    throw new Error(`This script is for macOS only (detected platform: ${process.platform}).`);
  }

  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  assertToolchain();

  if (!options.skipModel) prepareModel(options);

  if (!run('Build (wasm + extension)', 'npm', ['run', 'build'])) {
    throw new Error('Build failed.');
  }

  console.log('\nBuild complete: dist/');
  console.log('Load it via chrome://extensions -> "Developer mode" -> "Load unpacked".');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs };
