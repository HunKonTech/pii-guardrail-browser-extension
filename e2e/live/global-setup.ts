import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { PROVIDERS, type ProviderName } from './contracts';
import { runPreflight } from './preflight';

export interface LiveState {
  buildDir: string;
  outputRoot: string;
  metadata: Awaited<ReturnType<typeof runPreflight>>['metadata'];
}

function selectedProviders(): ProviderName[] {
  return (process.env.PG_LIVE_PROVIDERS ?? PROVIDERS.join(','))
    .split(',')
    .filter(Boolean) as ProviderName[];
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const preflight = await runPreflight({
    providers: selectedProviders(),
    headless: process.env.PG_LIVE_HEADLESS === '1',
    deepDiagnostics: process.env.PG_LIVE_DEEP_DIAGNOSTICS === '1',
    skipBuild: process.env.PG_LIVE_SKIP_BUILD === '1',
  });
  const outputRoot = path.resolve('.artifacts', 'live-e2e', preflight.metadata.runId);
  const statePath = path.join(outputRoot, 'run-state.json');
  const state: LiveState = { ...preflight, outputRoot };
  await mkdir(outputRoot, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  process.env.PG_LIVE_STATE_PATH = statePath;

  if (!preflight.metadata.authoritative) {
    console.warn('Live E2E diagnostic mode: this run is not an authoritative compatibility result.');
  }
  if (preflight.metadata.deepDiagnostics) {
    console.warn('Deep diagnostics enabled: failure traces may contain additional local page state.');
  }
}
