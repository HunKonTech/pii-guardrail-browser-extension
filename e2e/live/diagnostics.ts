import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConsoleMessage, Page } from '@playwright/test';
import type { LiveArtifact, ProviderName, StructureFingerprint } from './contracts';
import { redactBounded } from './redaction';

function safePathShape(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (/^[a-z0-9_-]{12,}$/i.test(segment) ? ':id' : segment))
    .join('/');
}

export class FailureDiagnostics {
  readonly consoleErrors: string[] = [];
  private readonly onConsole: (message: ConsoleMessage) => void;

  constructor(
    private readonly page: Page,
    readonly provider: ProviderName,
    readonly directory: string,
    private readonly sensitiveValues: string[],
  ) {
    this.onConsole = (message) => {
      if (message.type() === 'error') {
        this.consoleErrors.push(redactBounded(message.text(), this.sensitiveValues, 500));
      }
    };
    page.on('console', this.onConsole);
  }

  addSensitiveValue(value: string): void {
    this.sensitiveValues.push(value);
  }

  async fingerprint(): Promise<StructureFingerprint> {
    return this.page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = getComputedStyle(html);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return {
        urlOrigin: location.origin,
        pathShape: location.pathname,
        dialogCount: Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(visible).length,
        visibleTextboxCount: Array.from(
          document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'),
        ).filter(visible).length,
        visibleButtonCount: Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible).length,
      };
    }).then((result) => ({ ...result, pathShape: safePathShape(result.pathShape) }));
  }

  async captureFailure(): Promise<{
    artifacts: LiveArtifact[];
    fingerprint: StructureFingerprint;
    consoleErrors: string[];
    tracePath: string;
  }> {
    await mkdir(this.directory, { recursive: true });
    const screenshotPath = path.join(this.directory, 'failure.png');
    const tracePath = path.join(this.directory, 'trace.zip');
    const consolePath = path.join(this.directory, 'console-errors.json');
    const fingerprintPath = path.join(this.directory, 'fingerprint.json');
    const fingerprint = await this.fingerprint();
    const artifacts: LiveArtifact[] = [];
    const screenshotCreated = await this.page
      .screenshot({ path: screenshotPath, fullPage: false })
      .then(() => true)
      .catch(() => false);
    if (screenshotCreated) artifacts.push({ kind: 'screenshot', path: screenshotPath });
    await writeFile(consolePath, `${JSON.stringify(this.consoleErrors, null, 2)}\n`, 'utf8');
    await writeFile(fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8');
    artifacts.push(
      { kind: 'console', path: consolePath },
      { kind: 'fingerprint', path: fingerprintPath },
    );
    this.page.off('console', this.onConsole);
    return {
      artifacts,
      fingerprint,
      consoleErrors: [...this.consoleErrors],
      tracePath,
    };
  }

  dispose(): void {
    this.page.off('console', this.onConsole);
  }
}
