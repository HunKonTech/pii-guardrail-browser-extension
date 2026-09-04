import type { Page } from '@playwright/test';
import type { ProviderName } from './contracts';

const LABELS: Record<ProviderName, RegExp[]> = {
  chatgpt: [/^Accept all$/i, /^Stay logged out$/i, /^Okay, let(?:'|’)s go$/i],
  claude: [/^Accept all cookies$/i],
  gemini: [/^I agree$/i, /^Got it$/i],
};

export function knownBlockerLabels(provider: ProviderName): RegExp[] {
  return [...LABELS[provider]];
}

export async function handleKnownBlockers(page: Page, provider: ProviderName): Promise<void> {
  for (const label of LABELS[provider]) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000 });
    }
  }
}
