import { buildLiveReport, renderConsoleSummary } from '../../e2e/live/reporter';
import type { LiveProviderResult, LiveRunMetadata } from '../../e2e/live/contracts';

describe('live E2E reporting', () => {
  const metadata: LiveRunMetadata = {
    runId: 'run-1',
    commit: 'abc123',
    dirty: true,
    authoritative: true,
    headed: true,
    deepDiagnostics: false,
    providers: ['chatgpt'],
    startedAt: '2026-09-04T10:00:00.000Z',
    extensionVersion: '0.4.2',
    playwrightVersion: '1.55.0',
    browserVersion: 'Chromium 140',
    viewport: { width: 1440, height: 960 },
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
  };

  const result: LiveProviderResult = {
    provider: 'chatgpt',
    status: 'incompatible',
    phase: 'review',
    cause: 'Review surface did not appear',
    startedAt: '2026-09-04T10:00:01.000Z',
    endedAt: '2026-09-04T10:00:02.000Z',
    timings: { navigation: 120 },
    artifacts: [{ kind: 'screenshot', path: '.artifacts/live-e2e/run-1/chatgpt/failure.png' }],
    redirects: ['https://chatgpt.com/'],
    consoleErrors: ['Refused to load resource'],
    fingerprint: { urlOrigin: 'https://chatgpt.com', pathShape: '/', dialogCount: 0 },
  };

  test('emits one minimized machine-readable report', () => {
    const report = buildLiveReport(metadata, [result], '2026-09-04T10:00:03.000Z');
    const json = JSON.stringify(report);

    expect(report.exitCode).toBe(1);
    expect(report.results).toEqual([result]);
    expect(json).not.toMatch(/prompt|responseText|clipboardValue|outerHTML|SECRET/i);
  });

  test('renders a compact table and source-state line', () => {
    const summary = renderConsoleSummary(buildLiveReport(metadata, [result], '2026-09-04T10:00:03.000Z'));

    expect(summary).toContain('abc123 (dirty)');
    expect(summary).toContain('chatgpt');
    expect(summary).toContain('incompatible');
    expect(summary).toContain('review');
  });

  test('fails a report that is missing a configured provider result', () => {
    const report = buildLiveReport(
      { ...metadata, providers: ['chatgpt', 'claude'] },
      [result],
      '2026-09-04T10:00:03.000Z',
    );

    expect(report.exitCode).toBe(1);
  });
});
