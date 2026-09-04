import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clickExtensionShadowControl } from './closed-shadow-control';
import { discoverComposer } from './composer';
import { FailureDiagnostics } from './diagnostics';
import { handleKnownBlockers } from './known-blockers';
import { ChatGptLiveSurfaceDriver } from './surface-driver';

test('discovers the accessible visible composer without product selectors', async ({ page }) => {
  await page.setContent(`
    <textarea style="display:none">hidden</textarea>
    <form><textarea disabled>disabled</textarea></form>
    <form aria-label="chat"><div role="textbox" contenteditable="true" style="width:400px;height:80px"></div><button type="submit">Send</button></form>
  `);

  const composer = await discoverComposer(page);
  expect(await composer.getAttribute('role')).toBe('textbox');
});

test('known blocker handling leaves an unknown Continue action untouched', async ({ page }) => {
  await page.setContent(`
    <button onclick="document.body.dataset.accepted='yes';this.remove()">Accept all</button>
    <button onclick="document.body.dataset.continued='yes'">Continue</button>
  `);

  await handleKnownBlockers(page, 'chatgpt');
  expect(await page.locator('body').getAttribute('data-accepted')).toBe('yes');
  expect(await page.locator('body').getAttribute('data-continued')).toBeNull();
});

test('known blocker handling waits until the dismissed action disappears', async ({ page }) => {
  await page.setContent(`
    <button onclick="setTimeout(() => this.remove(), 100)">Accept all</button>
  `);

  await handleKnownBlockers(page, 'chatgpt');

  expect(await page.getByRole('button', { name: 'Accept all' }).count()).toBe(0);
});

test('new-chat navigation waits until the previous transcript disappears', async ({ page }) => {
  const previousMessage = 'previous sanitized transcript';
  await page.setContent(`
    <a href="#new" aria-label="New chat" onclick="setTimeout(() => document.getElementById('old')?.remove(), 100)">New chat</a>
    <main>
      <div id="old">${previousMessage}</div>
      <form><textarea style="width:400px;height:80px"></textarea><button type="submit">Send</button></form>
    </main>
  `);

  const driver = new ChatGptLiveSurfaceDriver(page);
  await driver.startNewChat(previousMessage);

  expect(await page.getByText(previousMessage, { exact: true }).count()).toBe(0);
});

test('clicks a real pointer target inside nested closed extension shadow roots', async ({ page }) => {
  await page.setContent('<div id="pg-review-overlay-host" style="position:fixed;inset:0"></div>');
  await page.evaluate(() => {
    const host = document.getElementById('pg-review-overlay-host')!;
    const first = host.attachShadow({ mode: 'closed' });
    const nestedHost = document.createElement('div');
    first.appendChild(nestedHost);
    const nested = nestedHost.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.id = 'pg-confirm-btn';
    button.textContent = 'Replace & paste';
    button.style.cssText = 'position:absolute;left:40px;top:40px;width:180px;height:50px';
    button.addEventListener('click', () => { document.body.dataset.clicked = 'yes'; });
    nested.appendChild(button);
  });

  await clickExtensionShadowControl(page, '#pg-review-overlay-host', { id: 'pg-confirm-btn' });
  expect(await page.locator('body').getAttribute('data-clicked')).toBe('yes');
});

test('ignores a provider control with the same ID outside the extension host', async ({ page }) => {
  await page.setContent(`
    <button id="pg-confirm-btn">Provider-owned duplicate</button>
    <div id="pg-review-overlay-host" style="position:fixed;inset:0"></div>
  `);
  await page.evaluate(() => {
    const host = document.getElementById('pg-review-overlay-host')!;
    const root = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.id = 'pg-confirm-btn';
    button.style.cssText = 'position:absolute;left:40px;top:40px;width:180px;height:50px';
    button.addEventListener('click', () => { document.body.dataset.clicked = 'extension'; });
    root.appendChild(button);
  });

  await clickExtensionShadowControl(page, '#pg-review-overlay-host', { id: 'pg-confirm-btn' });
  expect(await page.locator('body').getAttribute('data-clicked')).toBe('extension');
});

test('rejects a missing closed-shadow control', async ({ page }) => {
  await page.setContent('<div id="pg-review-overlay-host"></div>');
  await page.evaluate(() => {
    document.getElementById('pg-review-overlay-host')!.attachShadow({ mode: 'closed' });
  });

  await expect(
    clickExtensionShadowControl(page, '#pg-review-overlay-host', { id: 'pg-confirm-btn' }),
  ).rejects.toThrow('not found');
});

test('rejects an ambiguous closed-shadow control', async ({ page }) => {
  await page.setContent('<div id="pg-review-overlay-host"></div>');
  await page.evaluate(() => {
    const root = document.getElementById('pg-review-overlay-host')!.attachShadow({ mode: 'closed' });
    for (let index = 0; index < 2; index += 1) {
      const button = document.createElement('button');
      button.id = 'pg-confirm-btn';
      root.appendChild(button);
    }
  });

  await expect(
    clickExtensionShadowControl(page, '#pg-review-overlay-host', { id: 'pg-confirm-btn' }),
  ).rejects.toThrow('ambiguous');
});

test('clicks an explicitly selected extension host when several banners exist', async ({ page }) => {
  await page.setContent(`
    <div class="pg-deanon-host"></div>
    <div class="pg-deanon-host"></div>
  `);
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('.pg-deanon-host').forEach((host, index) => {
      const root = host.attachShadow({ mode: 'closed' });
      const button = document.createElement('button');
      button.id = 'pg-reveal-btn';
      button.style.cssText = `position:absolute;left:${40 + index * 220}px;top:40px;width:180px;height:50px`;
      button.addEventListener('click', () => { document.body.dataset.clicked = String(index); });
      root.appendChild(button);
    });
  });

  await clickExtensionShadowControl(
    page,
    '.pg-deanon-host',
    { id: 'pg-reveal-btn', hostIndex: 1 },
  );
  expect(await page.locator('body').getAttribute('data-clicked')).toBe('1');
});

test('rejects a covered closed-shadow control', async ({ page }) => {
  await page.setContent('<div id="pg-review-overlay-host" style="position:fixed;inset:0"></div>');
  await page.evaluate(() => {
    const root = document.getElementById('pg-review-overlay-host')!.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.id = 'pg-confirm-btn';
    button.style.cssText = 'position:absolute;left:40px;top:40px;width:180px;height:50px';
    root.appendChild(button);
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px;z-index:9999';
    document.body.appendChild(cover);
  });

  await expect(
    clickExtensionShadowControl(page, '#pg-review-overlay-host', { id: 'pg-confirm-btn' }),
  ).rejects.toThrow('covered');
});

test('rejects closed-shadow access outside Privacy Guardrail surfaces', async ({ page }) => {
  await expect(
    clickExtensionShadowControl(page, '#provider-dialog', { id: 'continue' }),
  ).rejects.toMatchObject({ kind: 'harness-error' });
});

test('failure diagnostics create a screenshot, trace, and minimized structure data', async ({ page, context }, testInfo) => {
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  await page.setContent('<main><div role="dialog"><textarea style="width:100px;height:50px"></textarea></div></main>');
  const directory = testInfo.outputPath('intentional-failure');
  const diagnostics = new FailureDiagnostics(page, 'chatgpt', directory, ['SECRET']);
  const result = await diagnostics.captureFailure();
  await context.tracing.stop({ path: result.tracePath });

  await access(path.join(directory, 'failure.png'));
  await access(path.join(directory, 'trace.zip'));
  const fingerprint = JSON.parse(await readFile(path.join(directory, 'fingerprint.json'), 'utf8')) as { dialogCount: number };
  expect(fingerprint.dialogCount).toBe(1);
  expect(result.tracePath).toBe(path.join(directory, 'trace.zip'));
  await rm(directory, { recursive: true, force: true });
});
