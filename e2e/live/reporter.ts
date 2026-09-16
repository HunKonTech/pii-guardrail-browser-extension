import { overallExitCode } from './classifier';
import type { LiveProviderResult, LiveReport, LiveRunMetadata } from './contracts';

export function buildLiveReport(
  metadata: LiveRunMetadata,
  results: LiveProviderResult[],
  endedAt = new Date().toISOString(),
): LiveReport {
  return {
    schemaVersion: 1,
    metadata,
    endedAt,
    exitCode:
      results.length === metadata.providers.length && overallExitCode(results) === 0 ? 0 : 1,
    results,
  };
}

function cell(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

export function renderConsoleSummary(report: LiveReport): string {
  const rows = report.results.map((result) =>
    [
      cell(result.provider, 10),
      cell(result.status, 14),
      cell(result.phase, 18),
      result.cause,
    ].join('  '),
  );
  const mode = report.metadata.authoritative ? 'authoritative' : 'diagnostic';
  return [
    `Source: ${report.metadata.commit}${report.metadata.dirty ? ' (dirty)' : ''}`,
    `Mode: ${mode}, ${report.metadata.headed ? 'headed' : 'headless'}`,
    '',
    `${cell('Provider', 10)}  ${cell('Status', 14)}  ${cell('Phase', 18)}  Cause`,
    ...rows,
  ].join('\n');
}
