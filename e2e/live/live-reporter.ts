import { readFile, writeFile } from 'node:fs/promises';
import type { Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';
import type { LiveProviderResult } from './contracts';
import type { LiveState } from './global-setup';
import { buildLiveReport, renderConsoleSummary } from './reporter';

export default class LiveReporter implements Reporter {
  private readonly results: LiveProviderResult[] = [];

  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name !== 'live-provider-result' || !attachment.body) continue;
      this.results.push(JSON.parse(attachment.body.toString('utf8')) as LiveProviderResult);
    }
  }

  onError(error: TestError): void {
    console.error(error.message);
  }

  async onEnd(): Promise<void> {
    const statePath = process.env.PG_LIVE_STATE_PATH;
    if (!statePath) return;
    const state = JSON.parse(await readFile(statePath, 'utf8')) as LiveState;
    const report = buildLiveReport(state.metadata, this.results);
    const reportPath = `${state.outputRoot}/report.json`;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n${renderConsoleSummary(report)}\n\nJSON report: ${reportPath}`);
  }
}
