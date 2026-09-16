import path from 'node:path';
import type { Locator } from '@playwright/test';
import { LiveE2EError, attributeToProviderBlocker, classifyLiveError } from './classifier';
import { ClipboardGuard } from './clipboard';
import { clickExtensionShadowControl } from './closed-shadow-control';
import type {
  CommonFlowPort,
  LivePhase,
  LiveProviderResult,
  LiveRunMetadata,
  ProviderName,
} from './contracts';
import { FailureDiagnostics } from './diagnostics';
import { executeCommonFlow } from './flow';
import { ExtensionHarness } from './harness';
import { createLiveSurfaceDriver, type LiveSurfaceDriver } from './surface-driver';
import { patternTestCase, transformerTestCase, type LiveTestCase } from './test-data';

const PLACEHOLDER = /\[([A-Z_]+)_\d+\]/g;

function pasteShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V';
}

function copyShortcut(): string {
  return process.platform === 'darwin' ? 'Meta+C' : 'Control+C';
}

class ProviderFlowPort implements CommonFlowPort {
  private composer: Locator | null = null;
  private submittedText = '';
  response: Locator | null = null;

  constructor(
    private readonly driver: LiveSurfaceDriver,
    private readonly clipboard: ClipboardGuard,
    readonly testCase: LiveTestCase,
    private readonly timings: Partial<Record<LivePhase, number>>,
    private readonly skipNavigation = false,
  ) {}

  private async timed<T>(phase: LivePhase, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await action();
    } finally {
      this.timings[phase] = Math.round(performance.now() - started);
    }
  }

  navigate(): Promise<void> {
    return this.skipNavigation
      ? Promise.resolve()
      : this.timed('navigation', () => this.driver.navigate());
  }

  handleKnownBlockers(): Promise<void> {
    return this.timed('blockers', () => this.driver.handleKnownBlockers());
  }

  async findComposer(): Promise<void> {
    await this.timed('composer', async () => {
      this.composer = await this.driver.findComposer();
      await this.composer.focus();
    });
  }

  async pasteWithSystemClipboard(): Promise<void> {
    await this.timed('paste', async () => {
      if (!this.composer) throw new LiveE2EError('harness-error', 'paste', 'Composer was not initialized');
      await this.clipboard.withText(this.testCase.prompt, async () => {
        await this.composer!.focus();
        await this.driver.page.keyboard.press(pasteShortcut());
      });
    });
  }

  async assertRawValueHeld(): Promise<void> {
    await this.timed('paste', async () => {
      if (!this.composer) throw new LiveE2EError('harness-error', 'paste', 'Composer was not initialized');
      const value = await this.driver.readComposer(this.composer);
      if (value.includes(this.testCase.rawValue)) {
        throw new LiveE2EError('incompatible', 'paste', 'The raw synthetic value reached the provider composer');
      }
    });
  }

  async confirmReview(): Promise<string> {
    return this.timed('review', async () => {
      if (!this.composer) throw new LiveE2EError('harness-error', 'review', 'Composer was not initialized');
      const host = this.driver.page.locator('#pg-review-overlay-host');
      const reviewTimeout = this.testCase.expectedReplacementType === 'PERSON' ? 120_000 : 30_000;
      await host.waitFor({ state: 'attached', timeout: reviewTimeout }).catch(() => {
        throw new LiveE2EError('incompatible', 'review', 'The Privacy Guardrail review surface did not appear');
      });
      await clickExtensionShadowControl(
        this.driver.page,
        '#pg-review-overlay-host',
        { id: 'pg-confirm-btn' },
        'review',
      );
      await host.waitFor({ state: 'detached', timeout: 10_000 });
      await this.driver.page.waitForFunction(
        (element) => {
          const html = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
          const value = 'value' in html ? String(html.value) : html.innerText || html.textContent || '';
          return /\[[A-Z_]+_\d+\]/.test(value);
        },
        await this.composer.elementHandle(),
        { timeout: 10_000 },
      );
      const value = await this.driver.readComposer(this.composer);
      if (value.includes(this.testCase.rawValue)) {
        throw new LiveE2EError('incompatible', 'replacement', 'The raw synthetic value remained after replacement');
      }
      this.submittedText = value.trim();
      const replacements = Array.from(this.submittedText.matchAll(PLACEHOLDER));
      const expected = replacements.find((match) => match[1] === this.testCase.expectedReplacementType)?.[0];
      if (!expected) {
        throw new LiveE2EError(
          'incompatible',
          'replacement',
          `No ${this.testCase.expectedReplacementType} replacement token reached the composer`,
        );
      }
      return expected;
    });
  }

  async submit(replacement: string): Promise<void> {
    await this.timed('submit', async () => {
      if (!this.composer) throw new LiveE2EError('harness-error', 'submit', 'Composer was not initialized');
      await this.driver.submit(this.composer, replacement);
    });
  }

  assertSentMessage(): Promise<void> {
    return this.timed('sent-message', () =>
      this.driver.waitForSentMessage(this.submittedText, this.testCase.rawValue),
    );
  }

  async waitForResponse(replacement: string): Promise<void> {
    await this.timed('response', async () => {
      this.response = await this.driver.waitForResponse(replacement);
    });
  }

  submitted(): string {
    return this.submittedText;
  }
}

async function waitForClipboard(clipboard: ClipboardGuard, expected: string, phase: LivePhase): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await clipboard.readText()).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new LiveE2EError('incompatible', phase, 'The restored value did not reach the system clipboard');
}

async function runChatGptDeepFlow(
  harness: ExtensionHarness,
  driver: LiveSurfaceDriver,
  clipboard: ClipboardGuard,
  patternFlow: ProviderFlowPort,
  runId: string,
  timings: Partial<Record<LivePhase, number>>,
  diagnostics: FailureDiagnostics,
): Promise<void> {
  const page = driver.page;
  const patternResponse = patternFlow.response;
  if (!patternResponse) throw new LiveE2EError('harness-error', 'reveal', 'Pattern response was not retained');
  const banner = page.locator('.pg-deanon-host').last();
  await banner.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {
    throw new LiveE2EError('incompatible', 'reveal', 'The response restoration surface did not appear');
  });
  await clickExtensionShadowControl(
    page,
    '.pg-deanon-host',
    { id: 'pg-reveal-btn', hostIndex: -1 },
    'reveal',
  );
  await page.getByText(patternFlow.testCase.rawValue, { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 });

  await clickExtensionShadowControl(
    page,
    '.pg-deanon-host',
    { id: 'pg-copy-btn', hostIndex: -1 },
    'copy',
  );
  await waitForClipboard(clipboard, patternFlow.testCase.rawValue, 'copy');

  await clickExtensionShadowControl(
    page,
    '.pg-deanon-host',
    { id: 'pg-reveal-btn', hostIndex: -1 },
    'reveal',
  );
  await patternResponse.selectText();
  await page.keyboard.press(copyShortcut());
  await page.locator('#pg-clipboard-toast-host').waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {
    throw new LiveE2EError('incompatible', 'clipboard-toast', 'The clipboard restoration toast did not appear');
  });
  await clickExtensionShadowControl(
    page,
    '#pg-clipboard-toast-host',
    { id: 'pg-clipboard-replace-btn' },
    'clipboard-toast',
  );
  await waitForClipboard(clipboard, patternFlow.testCase.rawValue, 'clipboard-toast');

  const navigationStarted = performance.now();
  await driver.startNewChat(patternFlow.submitted());
  timings['spa-navigation'] = Math.round(performance.now() - navigationStarted);
  await harness.configure({
    enabled: true,
    nerProvider: 'transformers',
    nerModel: 'bardsai',
    nerWebGpuDtype: 'q4f16',
    defaultReplacementMode: 'placeholder',
    clipboardInterceptEnabled: true,
  });
  const transformerCase = transformerTestCase(runId);
  diagnostics.addSensitiveValue(transformerCase.rawValue);
  const transformerFlow = new ProviderFlowPort(driver, clipboard, transformerCase, timings, true);
  const transformerStarted = performance.now();
  try {
    await executeCommonFlow(transformerFlow);
  } catch (error) {
    if (error instanceof LiveE2EError) {
      throw new LiveE2EError(
        error.kind,
        'transformer',
        `Transformer flow failed during ${error.phase}: ${error.message}`,
      );
    }
    throw new LiveE2EError('harness-error', 'transformer', 'The ChatGPT transformer reference flow failed');
  } finally {
    timings.transformer = Math.round(performance.now() - transformerStarted);
  }
}

export async function executeLiveProvider(
  provider: ProviderName,
  metadata: LiveRunMetadata,
  buildDir: string,
  outputRoot: string,
): Promise<LiveProviderResult> {
  const startedAt = new Date().toISOString();
  const timings: Partial<Record<LivePhase, number>> = {};
  const patternCase = patternTestCase(metadata.runId);
  const transformerCaseForRedaction = transformerTestCase(metadata.runId);
  const redactions = [
    patternCase.prompt,
    transformerCaseForRedaction.prompt,
    patternCase.rawValue,
    transformerCaseForRedaction.rawValue,
  ];
  const clipboard = new ClipboardGuard();
  let harness: ExtensionHarness | null = null;
  let diagnostics: FailureDiagnostics | null = null;
  let driver: LiveSurfaceDriver | null = null;
  try {
    harness = await ExtensionHarness.launch({
      buildDir,
      headless: !metadata.headed,
      viewport: metadata.viewport,
      locale: metadata.locale,
      timezoneId: metadata.timezoneId,
      deepDiagnostics: metadata.deepDiagnostics,
    });
    metadata.browserVersion ??= await harness.browserVersion();
    driver = createLiveSurfaceDriver(provider, harness.page);
    diagnostics = new FailureDiagnostics(
      harness.page,
      provider,
      path.join(outputRoot, provider),
      [...redactions],
    );
    await harness.configure({
      enabled: true,
      nerProvider: 'off',
      defaultReplacementMode: 'placeholder',
      clipboardInterceptEnabled: true,
      debug: true,
    });

    await clipboard.preserve(async () => {
      const flow = new ProviderFlowPort(driver!, clipboard, patternCase, timings);
      await executeCommonFlow(flow);
      if (provider === 'chatgpt') {
        await runChatGptDeepFlow(
          harness!,
          driver!,
          clipboard,
          flow,
          metadata.runId,
          timings,
          diagnostics!,
        );
      }
    });

    diagnostics.dispose();
    await harness.close();
    return {
      provider,
      status: 'passed',
      phase: 'complete',
      cause: 'Compatibility contract passed',
      startedAt,
      endedAt: new Date().toISOString(),
      timings,
      artifacts: [],
      redirects: driver.redirects,
      consoleErrors: diagnostics.consoleErrors,
    };
  } catch (error) {
    const blocked = driver ? await driver.providerBlockerVisible().catch(() => false) : false;
    const endedAt = new Date().toISOString();
    const captured = diagnostics
      ? await diagnostics.captureFailure().catch(() => null)
      : null;
    const traceCreated = harness
      ? await harness.close(captured?.tracePath).catch(() => false)
      : false;
    if (captured && traceCreated) {
      captured.artifacts.push({ kind: 'trace', path: captured.tracePath });
    }
    const result = classifyLiveError(attributeToProviderBlocker(error, blocked), {
      provider,
      startedAt,
      endedAt,
      artifacts: captured?.artifacts ?? [],
      timings,
      redactions,
    });
    result.redirects = driver?.redirects ?? [];
    result.consoleErrors = captured?.consoleErrors ?? [];
    result.fingerprint = captured?.fingerprint;
    return result;
  }
}
