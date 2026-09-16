import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { overallExitCode } from './classifier';
import type { LiveProviderResult } from './contracts';
import { runProviderFlows } from './flow';
import type { LiveState } from './global-setup';
import { executeLiveProvider } from './provider-flow';

test('live compatibility contract for configured providers', async ({}, testInfo) => {
  const statePath = process.env.PG_LIVE_STATE_PATH;
  if (!statePath) throw new Error('Live E2E preflight state is missing');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as LiveState;
  const results: LiveProviderResult[] = await runProviderFlows(
    state.metadata.providers,
    async (provider) => {
      console.log(`[live-e2e] ${provider}: starting`);
      const result = await executeLiveProvider(provider, state.metadata, state.buildDir, state.outputRoot);
      console.log(`[live-e2e] ${provider}: ${result.status} (${result.phase})`);
      return result;
    },
  );

  for (const result of results) {
    await testInfo.attach('live-provider-result', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    });
  }

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  expect(overallExitCode(results), 'Every configured provider must pass').toBe(0);
});
