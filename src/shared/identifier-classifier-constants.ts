/**
 * Asset layout and decision threshold for the code-identifier OWN/LIB
 * classifier (`tools/identifier-classifier`). Separate from the PII NER
 * model registry in `constants.ts` — this model classifies code identifiers
 * (declared-elsewhere-in-your-project vs. framework/stdlib), not PII entity
 * types, and there is only ever one active model, not a picker.
 */

export const IDENTIFIER_CLASSIFIER_ASSET_BASE_PATH = 'models/identifier-classifier';

export const IDENTIFIER_CLASSIFIER_MODEL_ID = 'identifier-classifier';

export const IDENTIFIER_CLASSIFIER_REQUIRED_ASSETS: readonly string[] = [
  `${IDENTIFIER_CLASSIFIER_ASSET_BASE_PATH}/config.json`,
  `${IDENTIFIER_CLASSIFIER_ASSET_BASE_PATH}/tokenizer.json`,
  `${IDENTIFIER_CLASSIFIER_ASSET_BASE_PATH}/tokenizer_config.json`,
  `${IDENTIFIER_CLASSIFIER_ASSET_BASE_PATH}/onnx/model_quantized.onnx`,
];

/**
 * The BIO label set the token classifier was fine-tuned on
 * (`tools/identifier-classifier/train.py`, `LABELS`). 'O' covers non-identifier
 * tokens (punctuation, keywords); every identifier token gets a B-/I- OWN or
 * LIB tag.
 */
export type IdentifierClassifierLabel = 'O' | 'B-OWN' | 'I-OWN' | 'B-LIB' | 'I-LIB';

export type IdentifierVerdict = 'OWN' | 'LIB';

/**
 * `P(LIB) / (P(OWN) + P(LIB))` threshold above which a name is treated as a
 * library/framework name. Chosen (training run 2026-09-24, see
 * `tools/identifier-classifier/README.md`) as the 98th percentile of that
 * ratio over gold-OWN validation tokens, i.e. the highest bar that still
 * renames 98% of the user's own names (`own_recall` ≈ 95.6% on held-out
 * repos, `lib_recall_at_own98` ≈ 93%). Re-run `train.py` and update this
 * constant (`test_lib_threshold_own98` in its printed metrics) after
 * retraining — it is specific to that model's calibration, not an
 * architectural constant.
 */
export const DEFAULT_LIB_THRESHOLD = 0.9552237391471863;
