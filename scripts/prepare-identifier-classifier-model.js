#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  prepareLocalNerModel,
  verifyOutput,
} = require('./prepare-ai4privacy-model');

const DEFAULT_MODEL_ID = 'identifier-classifier';
const DEFAULT_OUTPUT_DIR = path.join('generated', 'models', 'identifier-classifier');
const DEFAULT_HF_REPO_ID = 'koncsik/code-identifier-classifier';
const DEFAULT_DOWNLOAD_DIR = path.join('.model-sources', 'code-identifier-classifier');
const EXTRA_REQUIRED_OUTPUT_FILES = [path.join('onnx', 'model_quantized.onnx')];

function usage() {
  return `
Prepare local code-identifier-classifier model assets for the Chrome extension.

Classifies pasted code identifiers as OWN (declared elsewhere in the user's
project) or LIB (framework/stdlib), so 'code-rename.ts' can rename OWN names
beyond what the hardcoded LIBRARY_NAMES list would catch. Trained by
'tools/identifier-classifier' (see its README); this script only stages the
exported ONNX artifacts into the runtime layout the extension loads, the same
way 'prepare:model:*' does for the PII NER models.

With no --source-dir, it downloads the artifacts from the private Hugging Face
model repo (${DEFAULT_HF_REPO_ID}) via the 'hf' CLI, unless a prepared output
already exists at --output-dir (rerun with --force to refresh it from Hugging
Face).

Usage:
  npm run prepare:model:identifier-classifier -- [--source-dir <dir>] [--output-dir <dir>]

Options:
  --source-dir <dir>   Directory produced by 'tools/identifier-classifier/export_onnx.py'.
                        When omitted, the model is downloaded from Hugging Face instead.
  --repo-id <id>       Hugging Face model repo to download from. Default: ${DEFAULT_HF_REPO_ID}
  --output-dir <dir>   Generated runtime directory. Default: ${DEFAULT_OUTPUT_DIR}
  --force              Remove an existing output directory before writing (also forces a
                        fresh download when no --source-dir is given).
  --help               Show this help.
`.trim();
}

function parseArgs(argv) {
  const options = {
    modelId: DEFAULT_MODEL_ID,
    outputDir: DEFAULT_OUTPUT_DIR,
    // No float/fp16 model is exported for this classifier — only the
    // int8-quantized artifact the WASM/CPU path loads.
    requireFp16: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value.`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--source-dir':
      case '-s':
        options.sourceDir = next();
        break;
      case '--repo-id':
        options.repoId = next();
        break;
      case '--output-dir':
      case '-o':
        options.outputDir = next();
        break;
      case '--force':
        options.force = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function printManifest(manifest) {
  console.log(`Prepared ${manifest.modelId}`);
  console.log(`Quantization: ${manifest.quantization}`);
  console.log('Artifacts:');
  for (const file of manifest.files) {
    console.log(`- ${file.path}: ${formatBytes(file.bytes)}`);
  }
}

function isAlreadyPrepared(outputDir) {
  try {
    verifyOutput(outputDir, EXTRA_REQUIRED_OUTPUT_FILES);
    return true;
  } catch {
    return false;
  }
}

function downloadFromHuggingFace(repoId, downloadDir) {
  const resolvedDownloadDir = path.resolve(downloadDir);
  fs.mkdirSync(resolvedDownloadDir, { recursive: true });

  console.log(`No --source-dir given; downloading ${repoId} from Hugging Face into ${resolvedDownloadDir} ...`);
  const result = spawnSync('hf', ['download', repoId, '--local-dir', resolvedDownloadDir], {
    stdio: 'inherit',
  });

  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(
      "Could not find the 'hf' CLI. Install it (e.g. 'pip install -U huggingface_hub[cli]') and log in " +
        "with 'hf auth login' (a read token is enough), or pass --source-dir to use a local export instead."
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `'hf download ${repoId}' failed (exit code ${result.status}). Make sure you are logged in with ` +
        "'hf auth login' and have access to this private model repo, or pass --source-dir instead."
    );
  }

  return resolvedDownloadDir;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;

  if (!options.sourceDir) {
    if (!options.force && isAlreadyPrepared(outputDir)) {
      console.log(`${outputDir} is already prepared; nothing to do. Rerun with --force to refresh it from Hugging Face.`);
      return;
    }
    options.sourceDir = downloadFromHuggingFace(options.repoId || DEFAULT_HF_REPO_ID, DEFAULT_DOWNLOAD_DIR);
  }

  const manifest = prepareLocalNerModel(options);
  printManifest(manifest);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_HF_REPO_ID,
  DEFAULT_DOWNLOAD_DIR,
  parseArgs,
  isAlreadyPrepared,
};
