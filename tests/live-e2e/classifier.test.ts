import {
  LiveE2EError,
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
});
