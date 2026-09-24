#!/usr/bin/env node

/**
 * Build Privacy Guardrail for Microsoft Edge.
 *
 * Edge runs the same Manifest V3 extension as Chrome, so this builds the
 * regular `dist/` output and stages it for Edge:
 *
 *   release/edge/privacy-guardrail-edge-<version>/      unpacked, for "Load unpacked"
 *   release/edge/privacy-guardrail-edge-<version>.zip   for Edge Add-ons (Partner Center)
 *   release/edge/privacy-guardrail-edge-<version>.sha256
 *
 * The package contents go through the same filter as the Chrome release
 * package (no source maps, no nested manifest.json, required legal files).
 *
 * Usage: node scripts/edge/build-edge.js [--skip-build] [--require-model]
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const { missingPreparedModelAssets } = require('../extension-packaging');
const { listPackageEntries, readPackageVersion, sha256File } = require('../package-release');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'release', 'edge');

function parseArgs(argv) {
  const options = { skipBuild: false, requireModel: false };
  for (const arg of argv) {
    if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--require-model') options.requireModel = true;
    else throw new Error(`Unknown option: ${arg}\nUsage: node scripts/edge/build-edge.js [--skip-build] [--require-model]`);
  }
  return options;
}

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return childProcess.spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

function run(label, command, args, env = {}) {
  console.log(`\n> ${label}`);
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function assertBuildTools() {
  const missing = [];
  if (!fs.existsSync(path.join(ROOT_DIR, 'node_modules'))) missing.push('node_modules (run `npm install`)');
  if (!commandExists('cargo')) missing.push('cargo (install Rust from https://rustup.rs)');
  if (!commandExists('wasm-bindgen')) missing.push('wasm-bindgen (run `cargo install wasm-bindgen-cli --version 0.2.118`)');
  if (missing.length > 0) {
    throw new Error(`Missing build prerequisites:\n${missing.map((item) => `  - ${item}`).join('\n')}`);
  }
}

function build(options) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  assertBuildTools();
  run('WASM build', npm, ['run', 'build:wasm']);
  run('Extension build', npm, ['run', 'build:ext'], options.requireModel ? { NER_MODEL_ASSETS_REQUIRED: '1' } : {});
}

function stage(version) {
  const { entries, excluded } = listPackageEntries(path.join(ROOT_DIR, 'dist'));
  const baseName = `privacy-guardrail-edge-${version}`;
  const unpackedDir = path.join(OUTPUT_DIR, baseName);
  const zipPath = path.join(OUTPUT_DIR, `${baseName}.zip`);
  const checksumPath = path.join(OUTPUT_DIR, `${baseName}.sha256`);

  fs.rmSync(unpackedDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(unpackedDir, { recursive: true });

  const zip = new AdmZip();
  for (const entry of entries) {
    const target = path.join(unpackedDir, entry.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.absolutePath, target);
    zip.addFile(entry.relativePath, fs.readFileSync(entry.absolutePath));
  }
  zip.writeZip(zipPath);
  const checksum = sha256File(zipPath);
  fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(zipPath)}\n`);

  return { unpackedDir, zipPath, checksum, fileCount: entries.length, excludedCount: excluded.length };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const version = readPackageVersion(ROOT_DIR);

  const missingModel = missingPreparedModelAssets(ROOT_DIR);
  if (missingModel.length > 0) {
    if (options.requireModel) {
      throw new Error(
        `Local AI model assets are missing (${missingModel.join(', ')}). See docs/developer/model-assets.md.`
      );
    }
    console.warn(
      '\nNote: Local AI model assets are not prepared, so this build runs pattern-only detection ' +
        '(secrets, emails, IBANs, ...). See docs/developer/model-assets.md to include Local AI.'
    );
  }

  if (!options.skipBuild) build(options);
  const result = stage(version);

  console.log(`\nEdge build ready (${result.fileCount} files, ${result.excludedCount} excluded):`);
  console.log(`  Unpacked: ${path.relative(ROOT_DIR, result.unpackedDir)}`);
  console.log(`  Zip:      ${path.relative(ROOT_DIR, result.zipPath)}`);
  console.log(`  SHA-256:  ${result.checksum}`);
  console.log('\nInstall: open edge://extensions, turn on "Developer mode", click "Load unpacked",');
  console.log(`and select ${result.unpackedDir}`);
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
