import {
  LiveE2EError,
  attributeToProviderBlocker,
  classifyLiveError,
  overallExitCode,
} from '../../e2e/live/classifier';

describe('live E2E result classification', () => {
  const context = {
    provider: 'chatgpt' as const,
    startedAt: '2026-09-04T10:00:00.000Z',
    endedAt: '2026-09-04T10:00:01.000Z',
  };

  test.each([
    ['incompatible', 'incompatible'],
    ['unavailable', 'unavailable'],
    ['vendor-error', 'vendor-error'],
    ['harness-error', 'harness-error'],
  ] as const)('preserves the explicit %s failure class', (kind, expected) => {
    const result = classifyLiveError(
      new LiveE2EError(kind, 'composer', 'bounded diagnostic'),
      context,
    );

    expect(result).toMatchObject({
      provider: 'chatgpt',
      status: expected,
      phase: 'composer',
      cause: 'bounded diagnostic',
    });
  });

  test('maps an unknown exception to a harness error without its stack', () => {
    const error = new Error('unexpected harness failure');
    error.stack = 'SECRET STACK CONTENT';

    expect(classifyLiveError(error, context)).toEqual({
      ...context,
      status: 'harness-error',
      phase: 'unknown',
      cause: 'unexpected harness failure',
      artifacts: [],
      timings: {},
    });
  });

  test('requires every configured provider to pass', () => {
    expect(overallExitCode([{ status: 'passed' }, { status: 'passed' }])).toBe(0);
    expect(overallExitCode([{ status: 'passed' }, { status: 'unavailable' }])).toBe(1);
  });

  test('redacts synthetic values from bounded failure causes', () => {
    const result = classifyLiveError(new Error('Timeout for live-e2e-secret@example.invalid'), {
      ...context,
      redactions: ['live-e2e-secret@example.invalid'],
    });

    expect(result.cause).toBe('Timeout for [redacted]');
  });

  test.each([
    ['incompatible', 'submit'],
    ['harness-error', 'review'],
  ] as const)('attributes a %s failure under a provider blocker to the provider', (kind, phase) => {
    const attributed = attributeToProviderBlocker(new LiveE2EError(kind, phase, 'no Send control'), true);

    expect(classifyLiveError(attributed, context)).toMatchObject({
      status: 'unavailable',
      phase,
      cause: 'A provider dialog or access wall covered the page: no Send control',
    });
  });

  test('attributes an unclassified exception under a provider blocker to the provider', () => {
    const attributed = attributeToProviderBlocker(new Error('click intercepted'), true);

    expect(classifyLiveError(attributed, context)).toMatchObject({ status: 'unavailable', phase: 'unknown' });
  });

  test('keeps the original failure when no provider blocker is visible', () => {
    const error = new LiveE2EError('incompatible', 'submit', 'no Send control');

    expect(attributeToProviderBlocker(error, false)).toBe(error);
  });

  test('keeps vendor errors under a provider blocker', () => {
    const error = new LiveE2EError('vendor-error', 'navigation', 'HTTP 503');

    expect(attributeToProviderBlocker(error, true)).toBe(error);
  });
});
