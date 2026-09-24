/**
 * Privacy Guardrail — web search content script.
 *
 * Registered dynamically on the search engines in `SEARCH_ENGINE_ORIGINS`
 * while "Protect web searches" is on and the user has granted those sites.
 * It reviews pastes into the query box and holds each search until the query
 * has been checked, then replaces what the user approves with the same
 * placeholders the chat pages use.
 *
 * Deliberately smaller than the chat content script: search results are not
 * model replies, so there is no conversation scope, no restoration banner and
 * no clipboard reveal.
 */

import { anonymize, anonymizeWithVault, previewIdentifierRenames } from '../shared/anonymizer';
import { EntityMap } from '../shared/entity-map';
import { emptyVaultData, loadIdentityVault, saveIdentityVault, type IdentityVaultData } from '../shared/identity-vault';
import { detectionOptionsFromSettings } from '../shared/detection-config';
import { resolveThreshold } from '../shared/sensitivity-resolver';
import { loadSettings } from '../shared/storage';
import { CHIP_FADE_MS } from '../shared/constants';
import type { DetectPiiRequest, PiiResultResponse, PiiSpan, Settings } from '../shared/message-types';
import { ReviewOverlay } from '../ui/overlay/overlay';
import { ScanningIndicator } from '../ui/scanning-indicator/scanning-indicator';
import { PasteInterceptor } from './paste-interceptor';
import { prepareReviewSpans } from './review-spans';
import { SearchGuard, type SearchReviewOutcome } from './search-guard';
import { SearchAdapter } from './site-adapters/search-adapter';
import { setFormControlValue } from './site-adapters/adapter-interface';

const SETTINGS_KEY = 'pg_settings';

let settings: Settings | null = null;
let identityVault: IdentityVaultData = emptyVaultData();
let requestCounter = 0;

/**
 * The script is only registered while protection is on, so until settings
 * have loaded it assumes it is: an early Enter is held rather than let through.
 */
function isActive(): boolean {
  if (settings === null) return true;
  return settings.enabled && settings.searchProtectionEnabled;
}

async function refreshSettings(): Promise<void> {
  settings = await loadSettings();
  identityVault = settings.identityVaultEnabled ? await loadIdentityVault() : emptyVaultData();
  interceptor.setEnabled(isActive());
}

function showIndicator(text: string, durationMs: number): void {
  document.getElementById('pg-indicator')?.remove();
  const el = document.createElement('div');
  el.id = 'pg-indicator';
  el.textContent = text;
  el.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647', 'padding:8px 14px',
    'border-radius:999px', 'background:#1a1a2e', 'color:#e0e0e0', 'font:13px system-ui,sans-serif',
    'box-shadow:0 4px 12px rgba(0,0,0,0.25)', 'pointer-events:none',
  ].join(';');
  (document.body ?? document.documentElement).appendChild(el);
  window.setTimeout(() => el.remove(), durationMs);
}

async function detect(text: string): Promise<{ spans: PiiSpan[]; timings?: { totalMs: number } }> {
  settings ??= await loadSettings();
  const current = settings;
  const request: DetectPiiRequest = {
    type: 'DETECT_PII',
    payload: { text, requestId: `pg_search_${++requestCounter}_${Date.now()}`, config: detectionOptionsFromSettings(current) },
  };
  const response: PiiResultResponse = await chrome.runtime.sendMessage(request);
  if (response?.type !== 'PII_RESULT') throw new Error('Invalid response from detection pipeline');
  return { spans: response.payload.spans, timings: response.payload.timings };
}

/** Whether code in the query should have its declared identifiers renamed. */
function renameIdentifiersEnabled(): boolean {
  return settings?.codeAnonymization === 'full';
}

/**
 * Replace the approved spans with placeholders and, when switched on, rename
 * the code's own identifiers — consistent with the chat pages.
 */
function anonymizeApproved(text: string, approvedSpans: PiiSpan[]): string {
  const current = settings!;
  const options = { renameIdentifiers: renameIdentifiersEnabled() };
  let result: { text: string; renamedIdentifiers: number };
  if (current.identityVaultEnabled) {
    const vaultResult = anonymizeWithVault(
      text,
      approvedSpans,
      identityVault,
      current.defaultReplacementMode,
      undefined,
      options,
    );
    identityVault = vaultResult.vaultData;
    if (vaultResult.text !== text) {
      saveIdentityVault(identityVault).catch((err) => console.error('[PG:search] vault save failed', err));
    }
    result = vaultResult;
  } else {
    result = anonymize(text, approvedSpans, new EntityMap(), options);
  }

  const parts = [];
  if (approvedSpans.length > 0) parts.push(`${approvedSpans.length} item(s) replaced`);
  if (result.renamedIdentifiers > 0) parts.push(`${result.renamedIdentifiers} identifier(s) renamed`);
  if (parts.length > 0) showIndicator(`\u{1F512} ${parts.join(', ')}`, CHIP_FADE_MS);
  return result.text;
}

/**
 * Show the review overlay for `text`. Resolves with the text to use, the
 * original when the user chooses to send it unchanged, or null on cancel.
 */
function reviewSpans(text: string, rawSpans: PiiSpan[], timings?: { totalMs: number }): Promise<string | null> {
  const current = settings!;
  const spans = prepareReviewSpans(text, rawSpans, current, {});
  if (spans.length === 0) return Promise.resolve(anonymizeApproved(text, []));

  return new Promise((resolve) => {
    const overlay = new ReviewOverlay(
      text,
      spans,
      {
        onConfirm: (approved) => resolve(anonymizeApproved(text, approved)),
        onPasteOriginal: () => resolve(text),
        onCancel: () => resolve(null),
        onFeedback: () => undefined,
        onAddToAllowlist: () => undefined,
        onEditDetails: () => undefined,
      },
      (span: PiiSpan) => resolveThreshold(current, span.entity_type),
      timings,
      current.theme,
      undefined,
      renameIdentifiersEnabled()
        ? (approved) =>
            previewIdentifierRenames(text, approved, {
              vaultData: current.identityVaultEnabled ? identityVault : undefined,
            })
        : undefined,
    );
    overlay.show();
  });
}

async function withScanning<T>(work: () => Promise<T>): Promise<T> {
  const indicator = new ScanningIndicator(settings?.theme ?? 'dark', () => undefined);
  indicator.start();
  try {
    return await work();
  } finally {
    indicator.stop();
  }
}

async function reviewQuery(query: string): Promise<SearchReviewOutcome> {
  const { spans, timings } = await withScanning(() => detect(query));
  if (spans.length === 0) return { kind: 'send', query: anonymizeApproved(query, []) };
  const reviewed = await reviewSpans(query, spans, timings);
  return reviewed === null ? { kind: 'cancel' } : { kind: 'send', query: reviewed };
}

const adapter = new SearchAdapter();

const interceptor = new PasteInterceptor(adapter, {
  onAnalyzing: () => undefined,
  onNoPii: (text) => {
    const renamed = anonymizeApproved(text, []);
    if (renamed === text) interceptor.pasteOriginal(text);
    else interceptor.pasteAnonymized(renamed);
  },
  onPiiDetected: (text, spans, timings) => {
    void reviewSpans(text, spans, timings).then((reviewed) => {
      if (reviewed === null) return;
      if (reviewed === text) interceptor.pasteOriginal(text);
      else interceptor.pasteAnonymized(reviewed);
    });
  },
  onError: (error) => showIndicator(`⚠ Privacy Guardrail error: ${error}`, 3000),
  onCanceled: () => undefined,
}, {
  waitForReady: () => ready,
});

const guard = new SearchGuard({
  isActive,
  review: reviewQuery,
  setQuery: (input, query) => {
    setFormControlValue(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
});

// Register before settings load so an early paste or Enter is still held.
interceptor.start();
guard.start();
const ready = refreshSettings().catch((err) => {
  console.error('[PG:search] failed to load settings', err);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes[SETTINGS_KEY] || changes.pg_identity_vault)) void refreshSettings();
});

void ready.then(() => {
  if (settings?.debug) {
    console.log(`[PG:search] Privacy Guardrail search protection ${isActive() ? 'active' : 'inactive'} on ${location.hostname}`);
  }
});
