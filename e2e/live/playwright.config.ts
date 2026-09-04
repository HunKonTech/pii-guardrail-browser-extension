import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: 'providers.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  reporter: [[path.join(__dirname, 'live-reporter.ts')]],
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
