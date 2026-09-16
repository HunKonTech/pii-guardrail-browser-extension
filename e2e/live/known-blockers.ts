import type { Page } from '@playwright/test';
import type { ProviderName } from './contracts';

const LABELS: Record<ProviderName, RegExp[]> = {
  chatgpt: [/^Accept all$/i, /^Stay logged out$/i, /^Okay, let(?:'|’)s go$/i],
  claude: [/^Accept all cookies$/i],
  // Each run uses a throwaway profile, so accepting Google's cookie consent keeps nothing.
  gemini: [/^I agree$/i, /^Got it$/i, /^Accept all$/i],
};

// Confirmations a provider asks for only after New chat is clicked. They are
// answered in that step alone, so the same label never fires elsewhere in a run.
const NEW_CHAT_CONFIRMATIONS: Record<ProviderName, RegExp[]> = {
  chatgpt: [/^Clear chat$/i],
  claude: [],
  gemini: [],
};

export function knownBlockerLabels(provider: ProviderName): RegExp[] {
  return [...LABELS[provider]];
}

export function newChatConfirmationLabels(provider: ProviderName): RegExp[] {
  return [...NEW_CHAT_CONFIRMATIONS[provider]];
}

export async function handleKnownBlockers(page: Page, provider: ProviderName): Promise<void> {
  for (const label of LABELS[provider]) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000 });
      await button.waitFor({ state: 'hidden', timeout: 3_000 });
    }
  }
}

export async function confirmNewChat(page: Page, provider: ProviderName): Promise<void> {
  for (const label of NEW_CHAT_CONFIRMATIONS[provider]) {
    // ChatGPT renders "Clear chat" as a link that navigates, not as a button.
    const dialog = page.getByRole('dialog');
    const button = dialog.getByRole('link', { name: label }).or(dialog.getByRole('button', { name: label })).first();
    const appeared = await button
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await button.click({ timeout: 3_000 });
      await button.waitFor({ state: 'hidden', timeout: 3_000 });
    }
  }
}
