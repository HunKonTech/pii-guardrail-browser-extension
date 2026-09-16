import { access } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ExtensionHarness } from './harness';

test('loads the unpacked extension, configures storage, and removes its temporary profile', async () => {
  const buildDir = path.resolve('dist');
  await access(path.join(buildDir, 'manifest.json'));
  const harness = await ExtensionHarness.launch({
    buildDir,
    headless: true,
    viewport: { width: 1200, height: 800 },
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    deepDiagnostics: false,
    recordTrace: false,
  });
  const profileDir = harness.profileDir;
  try {
    expect(harness.extensionId).toMatch(/^[a-p]{32}$/);
    await harness.configure({ nerProvider: 'off', enabled: true });
    const settings = await harness.serviceWorker.evaluate(async () => {
      const result = await chrome.storage.local.get('pg_settings');
      return result.pg_settings as { nerProvider?: string; enabled?: boolean };
    });
    expect(settings).toMatchObject({ nerProvider: 'off', enabled: true });
  } finally {
    await harness.close();
  }
  await expect(access(profileDir)).rejects.toThrow();
});

test('gives each browser harness a fresh temporary profile', async () => {
  const options = {
    buildDir: path.resolve('dist'),
    headless: true,
    viewport: { width: 1200, height: 800 },
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    deepDiagnostics: false,
    recordTrace: false,
  } as const;
  const first = await ExtensionHarness.launch(options);
  const firstProfile = first.profileDir;
  await first.close();
  const second = await ExtensionHarness.launch(options);
  try {
    expect(second.profileDir).not.toBe(firstProfile);
  } finally {
    await second.close();
  }
});
