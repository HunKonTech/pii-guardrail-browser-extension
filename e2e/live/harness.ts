import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { LiveE2EError } from './classifier';
import type { Settings } from '../../src/shared/message-types';

export interface ExtensionHarnessOptions {
  buildDir: string;
  headless: boolean;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  deepDiagnostics: boolean;
  recordTrace?: boolean;
}

export class ExtensionHarness {
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly serviceWorker: Worker,
    readonly extensionId: string,
    readonly profileDir: string,
    private readonly traceStarted: boolean,
  ) {}

  static async launch(options: ExtensionHarnessOptions): Promise<ExtensionHarness> {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'privacy-guardrail-live-e2e-'));
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chromium',
        headless: options.headless,
        viewport: options.viewport,
        locale: options.locale,
        timezoneId: options.timezoneId,
        permissions: ['clipboard-read', 'clipboard-write'],
        args: [
          `--disable-extensions-except=${options.buildDir}`,
          `--load-extension=${options.buildDir}`,
        ],
      });

      const serviceWorker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => null));
      if (!serviceWorker) {
        throw new LiveE2EError('harness-error', 'browser', 'Extension service worker did not start');
      }
      const match = /^chrome-extension:\/\/([^/]+)\//.exec(serviceWorker.url());
      if (!match) {
        throw new LiveE2EError('harness-error', 'browser', 'Could not derive the unpacked extension ID');
      }

      const pages = context.pages();
      const page = pages[0] ?? (await context.newPage());
      const traceStarted = options.recordTrace !== false;
      if (traceStarted) {
        await context.tracing.start({
          screenshots: options.deepDiagnostics,
          snapshots: options.deepDiagnostics,
          sources: options.deepDiagnostics,
        });
      }
      return new ExtensionHarness(context, page, serviceWorker, match[1], profileDir, traceStarted);
    } catch (error) {
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async configure(settings: Partial<Settings>): Promise<void> {
    await this.serviceWorker.evaluate(async (patch) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const initialized = await chrome.storage.local.get(['pg_settings', 'pg_system_check']);
        if (initialized.pg_settings && initialized.pg_system_check) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const stored = await chrome.storage.local.get('pg_settings');
      const current = (stored.pg_settings ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({ pg_settings: { ...current, ...patch } });

      const configured = await chrome.storage.local.get('pg_settings');
      const actual = (configured.pg_settings ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (actual[key] !== value) throw new Error(`Extension setting ${key} did not persist`);
      }
    }, settings);
  }

  async browserVersion(): Promise<string> {
    return this.context.browser()?.version() ?? 'unknown';
  }

  async close(tracePath?: string): Promise<boolean> {
    let traceCreated = false;
    try {
      if (this.traceStarted) {
        if (tracePath) {
          await this.context.tracing.stop({ path: tracePath });
          traceCreated = true;
        } else {
          await this.context.tracing.stop();
        }
      }
    } finally {
      await this.context.close().catch(() => undefined);
      await rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return traceCreated;
  }
}
