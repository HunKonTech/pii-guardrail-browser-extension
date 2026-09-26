import {
  DEFAULT_LIB_THRESHOLD,
  IDENTIFIER_CLASSIFIER_MODEL_ID,
  IDENTIFIER_CLASSIFIER_REQUIRED_ASSETS,
  type IdentifierVerdict,
} from '../shared/identifier-classifier-constants';
import { IDENTIFIER_WORD_RE } from '../shared/code-rename';
import { debugLog } from './debug';
import { alignTokensToText, alignmentCoverage, type TokenCharRange } from './token-offsets';
import { NerProviderUnavailableError, type TokenClassificationItem, type NerTokenizerLike } from './ner-provider';

/**
 * Classifies the code identifiers in `texts` (paste code regions, with
 * context — this is a context-aware model, not a bag-of-names lookup) as
 * OWN (declared elsewhere in the user's project) or LIB (framework/stdlib),
 * using the small token-classifier trained in `tools/identifier-classifier`.
 *
 * Best-effort: any region the model can't confidently align, or that fails
 * to load at all, is simply absent from the result. Callers must fall back
 * to the hardcoded `LIBRARY_NAMES` list for names missing from the map.
 */
export interface IdentifierClassifierResult {
  classifications: Map<string, IdentifierVerdict>;
  /** False when the model failed to load; `classifications` is then always empty. */
  available: boolean;
}

export interface IdentifierClassifierProvider {
  classify(texts: readonly string[], signal?: AbortSignal): Promise<IdentifierClassifierResult>;
}

type TransformersModule = {
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    useFSCache: boolean;
    useWasmCache: boolean;
    backends: { onnx: { wasm?: { wasmPaths?: string | { mjs?: string; wasm?: string }; numThreads?: number; proxy?: boolean } } };
  };
  pipeline: (
    task: 'token-classification',
    model: string,
    options?: { dtype?: 'q8'; local_files_only?: boolean; device?: 'wasm' }
  ) => Promise<TokenClassificationPipeline>;
};

type TokenClassificationPipeline = ((
  text: string,
  options?: { aggregation_strategy?: 'simple' | 'none'; ignore_labels?: string[] }
) => Promise<TokenClassificationItem[]>) & {
  tokenizer?: NerTokenizerLike;
};

const MODEL_ASSET_ROOT = 'models/';
const ONNX_RUNTIME_ASSET_ROOT = 'vendor/onnxruntime-web/';
const MIN_ALIGNMENT_COVERAGE = 0.8;

interface IdentifierClassifierProviderOptions {
  loadTransformers?: () => Promise<TransformersModule>;
  getExtensionUrl?: (path: string) => string;
  assetExists?: (url: string) => Promise<boolean>;
  libThreshold?: number;
}

function defaultExtensionUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

async function defaultAssetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

async function defaultLoadTransformers(): Promise<TransformersModule> {
  return import(/* webpackMode: "eager" */ '@huggingface/transformers') as Promise<TransformersModule>;
}

/**
 * Configures the shared transformers.js env for the non-asyncify CPU/WASM
 * runtime build — the same one `ner-provider.ts` uses for its CPU path.
 *
 * KNOWN LIMITATION: if the NER pipeline already initialized in this
 * offscreen document under WebGPU (asyncify wasm), the wasm module is
 * already instantiated and this reconfiguration will not take effect —
 * ONNX Runtime Web caches the wasm module after first instantiation. That
 * combination (WebGPU NER active, then a rename-enabled paste in the same
 * offscreen-document lifetime) is untested; if it turns out to misbehave,
 * the fix is to have both providers agree on one wasm build up front
 * (e.g. via a shared "runtime device" decided once per document).
 */
function configureEnvironment(transformers: TransformersModule, getExtensionUrl: (path: string) => string): void {
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = getExtensionUrl(MODEL_ASSET_ROOT);
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;
  transformers.env.useWasmCache = false;

  const wasmEnv = transformers.env.backends.onnx.wasm;
  if (!wasmEnv) {
    throw new NerProviderUnavailableError(
      'Transformers.js did not expose an onnx.wasm environment to configure.'
    );
  }
  const runtimeRoot = getExtensionUrl(ONNX_RUNTIME_ASSET_ROOT);
  wasmEnv.wasmPaths = {
    mjs: `${runtimeRoot}ort-wasm-simd-threaded.mjs`,
    wasm: `${runtimeRoot}ort-wasm-simd-threaded.wasm`,
  };
  wasmEnv.numThreads = 1;
  wasmEnv.proxy = false;
}

async function assertAssetsAvailable(
  getExtensionUrl: (path: string) => string,
  assetExists: (url: string) => Promise<boolean>
): Promise<void> {
  for (const path of IDENTIFIER_CLASSIFIER_REQUIRED_ASSETS) {
    const url = getExtensionUrl(path);
    if (!(await assetExists(url))) {
      throw new NerProviderUnavailableError(`Missing identifier-classifier asset: ${path}`);
    }
  }
}

/** Strips a BIO prefix ('B-OWN' -> 'OWN'); 'O' and unknown labels map to null. */
function verdictOf(label: string | undefined): IdentifierVerdict | null {
  if (label === 'B-OWN' || label === 'I-OWN') return 'OWN';
  if (label === 'B-LIB' || label === 'I-LIB') return 'LIB';
  return null;
}

interface WordEvidence {
  ownScore: number;
  libScore: number;
}

/**
 * Aggregates per-token predictions onto identifier-shaped words in `text`,
 * matching `IDENTIFIER_WORD_RE` — the same word shape `code-rename.ts` uses.
 */
function collectWordEvidence(
  text: string,
  output: readonly TokenClassificationItem[],
  ranges: readonly (TokenCharRange | null)[]
): Map<string, WordEvidence> {
  const byWord = new Map<string, WordEvidence>();

  IDENTIFIER_WORD_RE.lastIndex = 0;
  const words: { start: number; end: number; name: string }[] = [];
  for (const match of text.matchAll(IDENTIFIER_WORD_RE)) {
    words.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, name: match[0] });
  }
  if (words.length === 0) return byWord;

  for (const item of output) {
    if (typeof item.index !== 'number') continue;
    const verdict = verdictOf(item.entity_group ?? item.entity);
    if (!verdict) continue;
    const range = ranges[item.index];
    if (!range) continue;

    // A BPE token can span (or sit inside) at most a couple of words; scan
    // linearly since word counts per snippet are small.
    for (const word of words) {
      if (range.start >= word.end || range.end <= word.start) continue;
      const evidence = byWord.get(word.name) ?? { ownScore: 0, libScore: 0 };
      if (verdict === 'OWN') evidence.ownScore += item.score;
      else evidence.libScore += item.score;
      byWord.set(word.name, evidence);
    }
  }

  return byWord;
}

export function createIdentifierClassifierProvider(
  options: IdentifierClassifierProviderOptions = {}
): IdentifierClassifierProvider {
  const loadTransformers = options.loadTransformers ?? defaultLoadTransformers;
  const getExtensionUrl = options.getExtensionUrl ?? defaultExtensionUrl;
  const assetExists = options.assetExists ?? defaultAssetExists;
  const libThreshold = options.libThreshold ?? DEFAULT_LIB_THRESHOLD;
  let pipelinePromise: Promise<TokenClassificationPipeline> | null = null;

  async function ensurePipeline(): Promise<TokenClassificationPipeline> {
    pipelinePromise ??= (async () => {
      await assertAssetsAvailable(getExtensionUrl, assetExists);
      const transformers = await loadTransformers();
      configureEnvironment(transformers, getExtensionUrl);
      const classifier = await transformers.pipeline('token-classification', IDENTIFIER_CLASSIFIER_MODEL_ID, {
        dtype: 'q8',
        local_files_only: true,
        device: 'wasm',
      });
      debugLog('[PG:identifier-classifier] pipeline ready');
      return classifier;
    })();
    return pipelinePromise;
  }

  return {
    async classify(texts: readonly string[], signal?: AbortSignal): Promise<IdentifierClassifierResult> {
      const result = new Map<string, number>(); // name -> min lib share seen

      if (texts.length === 0) return { classifications: new Map(), available: true };

      let classifier: TokenClassificationPipeline;
      try {
        classifier = await ensurePipeline();
      } catch (err) {
        debugLog('[PG:identifier-classifier] unavailable, caller falls back to LIBRARY_NAMES', err);
        return { classifications: new Map(), available: false };
      }
      if (signal?.aborted) return { classifications: new Map(), available: true };

      const tokenizer = classifier.tokenizer;
      for (const text of texts) {
        if (signal?.aborted) break;
        if (!text.trim()) continue;

        let pieces: string[] | null = null;
        try {
          pieces = tokenizer ? tokenizer.tokenize(text, { add_special_tokens: true }) : null;
        } catch (err) {
          debugLog('[PG:identifier-classifier] tokenize failed, skipping region', err);
          continue;
        }
        const ranges = pieces ? alignTokensToText(text, pieces) : null;
        const coverage = ranges && pieces ? alignmentCoverage(ranges, pieces) : 0;
        if (!ranges || coverage < MIN_ALIGNMENT_COVERAGE) continue;

        let output: TokenClassificationItem[];
        try {
          output = await classifier(text, { aggregation_strategy: 'none' });
        } catch (err) {
          debugLog('[PG:identifier-classifier] inference failed, skipping region', err);
          continue;
        }

        const evidence = collectWordEvidence(text, output, ranges);
        for (const [name, { ownScore, libScore }] of evidence) {
          const denom = ownScore + libScore;
          if (denom <= 0) continue;
          const libShare = libScore / denom;
          const previous = result.get(name);
          result.set(name, previous === undefined ? libShare : Math.min(previous, libShare));
        }
      }

      const verdicts = new Map<string, IdentifierVerdict>();
      for (const [name, minLibShare] of result) {
        verdicts.set(name, minLibShare >= libThreshold ? 'LIB' : 'OWN');
      }
      return { classifications: verdicts, available: true };
    },
  };
}
