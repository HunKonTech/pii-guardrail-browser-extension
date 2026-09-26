#!/usr/bin/env node

const path = require('path');
const {
  prepareLocalNerModel,
} = require('./prepare-ai4privacy-model');

const DEFAULT_MODEL_ID = 'identifier-classifier';
const DEFAULT_OUTPUT_DIR = path.join('generated', 'models', 'identifier-classifier');

function usage() {
  return `
Prepare local code-identifier-classifier model assets for the Chrome extension.

Classifies pasted code identifiers as OWN (declared elsewhere in the user's
project) or LIB (framework/stdlib), so 'code-rename.ts' can rename OWN names
beyond what the hardcoded LIBRARY_NAMES list would catch. Trained by
'tools/identifier-classifier' (see its README); this script only stages the
exported ONNX artifacts into the runtime layout the extension loads, the same
way 'prepare:model:*' does for the PII NER models.

Usage:
  npm run prepare:model:identifier-classifier -- --source-dir <dir> [--output-dir <dir>]

Options:
  --source-dir <dir>   Directory produced by 'tools/identifier-classifier/export_onnx.py'
                        (defaults to its own default: work/export/code-identifier-classifier).
  --output-dir <dir>   Generated runtime directory. Default: ${DEFAULT_OUTPUT_DIR}
  --force              Remove an existing output directory before writing.
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

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
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
  parseArgs,
};
