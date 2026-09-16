import type { Locator, Page, Response } from '@playwright/test';
import { LiveE2EError } from './classifier';
import { discoverComposer } from './composer';
import type { ProviderName } from './contracts';
import { confirmNewChat, handleKnownBlockers } from './known-blockers';

const UNAVAILABLE_TEXT = /captcha|verify you are human|log in to continue|sign in to continue|not available in your country/i;

function redirectMetadata(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname
      .split('/')
      .map((segment) => (/^[a-z0-9_-]{12,}$/i.test(segment) ? ':id' : segment))
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return 'unparseable-url';
  }
}

function textValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  return element.innerText || element.textContent || '';
}

async function exactVisibleTextCount(page: Page, text: string): Promise<number> {
  return page.locator('main *').evaluateAll((elements, expected) =>
    elements.filter((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') return false;
      if (html.closest('[contenteditable="true"], textarea, input, button, [id^="pg-"], .pg-deanon-host')) return false;
      const own = Array.from(html.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      return own === expected;
    }).length,
  text);
}

export class LiveSurfaceDriver {
  readonly redirects: string[] = [];
  private responseBaseline = 0;

  protected constructor(
    readonly provider: ProviderName,
    readonly page: Page,
    private readonly targetUrl: string,
  ) {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.redirects.push(redirectMetadata(frame.url()));
    });
  }

  async navigate(): Promise<void> {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.page.goto(this.targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient = /ERR_(?:NAME_NOT_RESOLVED|CONNECTION_RESET|TIMED_OUT)|browser has been closed/i.test(message);
        if (!transient || attempt === 1) {
          throw new LiveE2EError('vendor-error', 'navigation', `Provider navigation failed: ${message}`);
        }
      }
    }
    if (response && response.status() >= 500) {
      throw new LiveE2EError('vendor-error', 'navigation', `Provider returned HTTP ${response.status()}`);
    }
  }

  handleKnownBlockers(): Promise<void> {
    return handleKnownBlockers(this.page, this.provider);
  }

  // Privacy Guardrail's own surfaces live in closed shadow roots, so any dialog
  // found here belongs to the provider.
  async providerBlockerVisible(): Promise<boolean> {
    const dialogVisible = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog')).some((element) => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = getComputedStyle(html);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }),
    );
    if (dialogVisible) return true;
    const body = await this.page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
    return UNAVAILABLE_TEXT.test(body);
  }

  async findComposer(): Promise<Locator> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await handleKnownBlockers(this.page, this.provider);
      try {
        return await discoverComposer(this.page);
      } catch (error) {
        lastError = error;
        const body = await this.page.locator('body').innerText({ timeout: 3_000 }).catch(() => '');
        if (UNAVAILABLE_TEXT.test(body)) {
          throw new LiveE2EError('unavailable', 'composer', 'The logged-out provider surface is blocked or unavailable');
        }
        await this.page.waitForTimeout(250);
      }
    }
    if (lastError instanceof LiveE2EError && lastError.kind === 'harness-error') throw lastError;
    throw new LiveE2EError('unavailable', 'composer', 'No usable composer appeared on the logged-out surface');
  }

  readComposer(composer: Locator): Promise<string> {
    return composer.evaluate(textValue);
  }

  async submit(composer: Locator, replacement: string): Promise<void> {
    // Consent dialogs can open after the composer was found, e.g. Google's while the review runs.
    await handleKnownBlockers(this.page, this.provider);
    this.responseBaseline = await exactVisibleTextCount(this.page, replacement);
    await composer.focus();
    await this.page.keyboard.press('Enter');
    const cleared = await this.page
      .waitForFunction((element) => {
        const html = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        const value = 'value' in html ? String(html.value) : html.innerText || html.textContent || '';
        return value.trim().length === 0;
      }, await composer.elementHandle(), { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (cleared) return;

    const form = composer.locator('xpath=ancestor::form[1]');
    const localSend = form.getByRole('button', { name: /^(?:send|submit)(?: message)?$/i }).first();
    const globalSend = this.page.getByRole('button', { name: /^(?:send|submit)(?: message)?$/i }).first();
    const send = (await localSend.isVisible().catch(() => false)) ? localSend : globalSend;
    if (!(await send.isVisible().catch(() => false))) {
      throw new LiveE2EError('incompatible', 'submit', 'The provider did not submit with Enter and no visible Send control was found');
    }
    await send.click();
  }

  async waitForSentMessage(submittedText: string, rawValue: string): Promise<void> {
    await this.page.waitForFunction(
      ({ expected, raw }) =>
        Array.from(document.querySelectorAll<HTMLElement>('main *')).some((element) => {
          if (element.closest('[contenteditable="true"], textarea, input, [id^="pg-"]')) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const text = (element.innerText || element.textContent || '').trim();
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && text === expected && !text.includes(raw);
        }),
      { expected: submittedText, raw: rawValue },
      { timeout: 30_000 },
    ).catch(() => {
      throw new LiveE2EError('incompatible', 'sent-message', 'The cleaned user message was not rendered exactly');
    });
  }

  async waitForResponse(replacement: string): Promise<Locator> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if ((await exactVisibleTextCount(this.page, replacement)) > this.responseBaseline) {
        return this.page.getByText(replacement, { exact: true }).last();
      }
      await this.page.waitForTimeout(250);
    }

    throw new LiveE2EError(
      'unavailable',
      'response',
      'A provider response repeating the replacement token was not observed',
    );
  }

  async startNewChat(previousSubmittedText: string): Promise<Locator> {
    const link = this.page.getByRole('link', { name: /^new chat$/i }).first();
    const button = this.page.getByRole('button', { name: /^new chat$/i }).first();
    const control = (await link.isVisible().catch(() => false)) ? link : button;
    if (!(await control.isVisible().catch(() => false))) {
      throw new LiveE2EError('incompatible', 'spa-navigation', 'A visible New chat control was not found');
    }
    await control.click();
    await confirmNewChat(this.page, this.provider);
    const transcriptCleared = await this.page
      .getByText(previousSubmittedText, { exact: true })
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!transcriptCleared) {
      throw new LiveE2EError('incompatible', 'spa-navigation', 'The previous transcript remained after New chat navigation');
    }
    return this.findComposer();
  }
}

export class ChatGptLiveSurfaceDriver extends LiveSurfaceDriver {
  constructor(page: Page) {
    super('chatgpt', page, 'https://chatgpt.com/');
  }
}

export class ClaudeLiveSurfaceDriver extends LiveSurfaceDriver {
  constructor(page: Page) {
    super('claude', page, 'https://claude.ai/new');
  }
}

export class GeminiLiveSurfaceDriver extends LiveSurfaceDriver {
  constructor(page: Page) {
    super('gemini', page, 'https://gemini.google.com/app');
  }
}

export function createLiveSurfaceDriver(provider: ProviderName, page: Page): LiveSurfaceDriver {
  if (provider === 'chatgpt') return new ChatGptLiveSurfaceDriver(page);
  if (provider === 'claude') return new ClaudeLiveSurfaceDriver(page);
  return new GeminiLiveSurfaceDriver(page);
}
