import { executeCommonFlow, runProviderFlows } from '../../e2e/live/flow';
import { LiveE2EError } from '../../e2e/live/classifier';
import type { CommonFlowPort, LiveProviderResult, ProviderName } from '../../e2e/live/contracts';

function fakeFlow(overrides: Partial<CommonFlowPort> = {}): CommonFlowPort {
  return {
    navigate: jest.fn(async () => undefined),
    handleKnownBlockers: jest.fn(async () => undefined),
    findComposer: jest.fn(async () => undefined),
    pasteWithSystemClipboard: jest.fn(async () => undefined),
    assertRawValueHeld: jest.fn(async () => undefined),
    confirmReview: jest.fn(async () => '[EMAIL_1]'),
    submit: jest.fn(async () => undefined),
    assertSentMessage: jest.fn(async () => undefined),
    waitForResponse: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('provider-neutral live E2E flow', () => {
  test('executes the common compatibility contract in order', async () => {
    const port = fakeFlow();

    await executeCommonFlow(port);

    expect((port.navigate as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (port.handleKnownBlockers as jest.Mock).mock.invocationCallOrder[0],
    );
    expect((port.confirmReview as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (port.submit as jest.Mock).mock.invocationCallOrder[0],
    );
    expect(port.assertSentMessage).toHaveBeenCalledWith('[EMAIL_1]');
  });

  test('labels a failing phase without rewriting its failure class', async () => {
    const port = fakeFlow({
      confirmReview: jest.fn(async () => {
        throw new LiveE2EError('incompatible', 'review', 'Review surface missing');
      }),
    });

    await expect(executeCommonFlow(port)).rejects.toMatchObject({
      kind: 'incompatible',
      phase: 'review',
    });
  });

  test.each([
    ['navigation', { navigate: jest.fn(async () => { throw new LiveE2EError('incompatible', 'navigation', 'failed'); }) }],
    ['blockers', { handleKnownBlockers: jest.fn(async () => { throw new LiveE2EError('incompatible', 'blockers', 'failed'); }) }],
    ['composer', { findComposer: jest.fn(async () => { throw new LiveE2EError('incompatible', 'composer', 'failed'); }) }],
    ['paste', { pasteWithSystemClipboard: jest.fn(async () => { throw new LiveE2EError('incompatible', 'paste', 'failed'); }) }],
    ['replacement', { confirmReview: jest.fn(async () => { throw new LiveE2EError('incompatible', 'replacement', 'failed'); }) }],
    ['submit', { submit: jest.fn(async () => { throw new LiveE2EError('incompatible', 'submit', 'failed'); }) }],
    ['sent-message', { assertSentMessage: jest.fn(async () => { throw new LiveE2EError('incompatible', 'sent-message', 'failed'); }) }],
    ['response', { waitForResponse: jest.fn(async () => { throw new LiveE2EError('incompatible', 'response', 'failed'); }) }],
  ] as const)('preserves a %s phase failure', async (phase, override) => {
    await expect(executeCommonFlow(fakeFlow(override))).rejects.toMatchObject({ phase });
  });

  test('runs every configured provider after a failure', async () => {
    const calls: ProviderName[] = [];
    const execute = jest.fn(async (provider: ProviderName): Promise<LiveProviderResult> => {
      calls.push(provider);
      return {
        provider,
        status: provider === 'chatgpt' ? 'incompatible' : 'passed',
        phase: provider === 'chatgpt' ? 'review' : 'complete',
        cause: provider === 'chatgpt' ? 'missing' : 'ok',
        startedAt: 'start',
        endedAt: 'end',
        timings: {},
        artifacts: [],
      };
    });

    const results = await runProviderFlows(['chatgpt', 'claude', 'gemini'], execute);

    expect(calls).toEqual(['chatgpt', 'claude', 'gemini']);
    expect(results).toHaveLength(3);
  });
});
