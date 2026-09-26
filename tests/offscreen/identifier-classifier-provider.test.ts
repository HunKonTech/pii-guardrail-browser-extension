import { createIdentifierClassifierProvider } from '../../src/offscreen/identifier-classifier-provider';
import type { TokenClassificationItem } from '../../src/offscreen/ner-provider';

const extensionUrl = (path: string) => `chrome-extension://test/${path}`;

/**
 * "myOwnVar consoleLog" tokenized byte-BPE style: a word-initial piece
 * carries the 'Ġ' space marker, continuations are glued directly — the same
 * shape CodeBERTa/RoBERTa tokenizers produce.
 *   pieces:  <s>  Ġmy  Own  Var  Ġconsole  Log  </s>
 *   ranges:  -    0-2  2-5  5-8  9-16      16-19 -
 */
const TEXT = 'myOwnVar consoleLog';
const PIECES = ['<s>', 'Ġmy', 'Own', 'Var', 'Ġconsole', 'Log', '</s>'];

const OUTPUT: TokenClassificationItem[] = [
  { index: 1, entity: 'B-OWN', score: 0.98, word: 'my' },
  { index: 2, entity: 'I-OWN', score: 0.97, word: 'Own' },
  { index: 3, entity: 'I-OWN', score: 0.96, word: 'Var' },
  { index: 4, entity: 'B-LIB', score: 0.99, word: 'console' },
  { index: 5, entity: 'I-LIB', score: 0.98, word: 'Log' },
];

function buildClassifier(output: TokenClassificationItem[] = OUTPUT) {
  const classifier = jest.fn().mockResolvedValue(output) as any;
  classifier.tokenizer = {
    tokenize: jest.fn().mockReturnValue(PIECES),
    model_max_length: 512,
  };
  return classifier;
}

describe('identifier-classifier provider', () => {
  test('classifies OWN and LIB names using the trained lib_threshold_own98 policy', async () => {
    const classifier = buildClassifier();
    const pipeline = jest.fn().mockResolvedValue(classifier);
    const env: any = { allowRemoteModels: true, allowLocalModels: false, localModelPath: '', useBrowserCache: true, useFSCache: true, useWasmCache: true, backends: { onnx: { wasm: {} } } };
    const provider = createIdentifierClassifierProvider({
      getExtensionUrl: extensionUrl,
      assetExists: jest.fn().mockResolvedValue(true),
      loadTransformers: jest.fn().mockResolvedValue({ env, pipeline }),
    });

    const { classifications, available } = await provider.classify([TEXT]);

    expect(available).toBe(true);
    expect(classifications.get('myOwnVar')).toBe('OWN');
    expect(classifications.get('consoleLog')).toBe('LIB');
    expect(pipeline).toHaveBeenCalledWith('token-classification', 'identifier-classifier', {
      dtype: 'q8',
      local_files_only: true,
      device: 'wasm',
    });
  });

  test('a name stays OWN when its occurrences disagree, even with strong LIB evidence', async () => {
    // Same identifier ("consoleLog") appears twice in one snippet: once with
    // strong LIB evidence, once with weaker but real OWN evidence. Evidence
    // pools per name before the ratio is taken, so one credible OWN signal
    // pulls the combined lib-share below the (deliberately very high)
    // decision threshold. Getting this wrong the other way — OWN
    // misclassified as LIB — is the costly mistake: it leaves the user's
    // real name unrenamed in the pasted text.
    const text = 'consoleLog consoleLog';
    const pieces = ['<s>', 'Ġconsole', 'Log', 'Ġconsole', 'Log', '</s>'];
    const output: TokenClassificationItem[] = [
      { index: 1, entity: 'B-LIB', score: 0.99, word: 'console' },
      { index: 2, entity: 'I-LIB', score: 0.99, word: 'Log' },
      { index: 3, entity: 'B-OWN', score: 0.9, word: 'console' },
      { index: 4, entity: 'I-OWN', score: 0.9, word: 'Log' },
    ];
    const classifier = jest.fn().mockResolvedValue(output) as any;
    classifier.tokenizer = { tokenize: jest.fn().mockReturnValue(pieces), model_max_length: 512 };
    const pipeline = jest.fn().mockResolvedValue(classifier);
    const env: any = { allowRemoteModels: true, allowLocalModels: false, localModelPath: '', useBrowserCache: true, useFSCache: true, useWasmCache: true, backends: { onnx: { wasm: {} } } };
    const provider = createIdentifierClassifierProvider({
      getExtensionUrl: extensionUrl,
      assetExists: jest.fn().mockResolvedValue(true),
      loadTransformers: jest.fn().mockResolvedValue({ env, pipeline }),
    });

    const { classifications } = await provider.classify([text]);

    expect(classifications.get('consoleLog')).toBe('OWN');
  });

  test('resolves to unavailable when a required asset is missing, without throwing', async () => {
    const provider = createIdentifierClassifierProvider({
      getExtensionUrl: extensionUrl,
      assetExists: jest.fn().mockResolvedValue(false),
      loadTransformers: jest.fn(),
    });

    const { classifications, available } = await provider.classify(['const x = 1;']);

    expect(available).toBe(false);
    expect(classifications.size).toBe(0);
  });

  test('returns an empty, available result for no input texts', async () => {
    const provider = createIdentifierClassifierProvider({
      getExtensionUrl: extensionUrl,
      assetExists: jest.fn().mockResolvedValue(true),
      loadTransformers: jest.fn(),
    });

    const { classifications, available } = await provider.classify([]);

    expect(available).toBe(true);
    expect(classifications.size).toBe(0);
  });
});
