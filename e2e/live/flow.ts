import type { CommonFlowPort, LiveProviderResult, ProviderName } from './contracts';

export async function executeCommonFlow(port: CommonFlowPort): Promise<string> {
  await port.navigate();
  await port.handleKnownBlockers();
  await port.findComposer();
  await port.pasteWithSystemClipboard();
  await port.assertRawValueHeld();
  const replacement = await port.confirmReview();
  await port.submit(replacement);
  await port.assertSentMessage(replacement);
  await port.waitForResponse(replacement);
  return replacement;
}

export async function runProviderFlows(
  providers: readonly ProviderName[],
  execute: (provider: ProviderName) => Promise<LiveProviderResult>,
): Promise<LiveProviderResult[]> {
  const results: LiveProviderResult[] = [];
  for (const provider of providers) {
    results.push(await execute(provider));
  }
  return results;
}
