import { knownBlockerLabels } from '../../e2e/live/known-blockers';

describe('known live-surface blockers', () => {
  test('contains only explicit provider-specific consent or introduction actions', () => {
    expect(knownBlockerLabels('chatgpt')).toEqual([
      /^Accept all$/i,
      /^Stay logged out$/i,
      /^Okay, let(?:'|’)s go$/i,
    ]);
    expect(knownBlockerLabels('claude')).toEqual([/^Accept all cookies$/i]);
    expect(knownBlockerLabels('gemini')).toEqual([/^I agree$/i, /^Got it$/i]);
  });

  test('does not include generic continue or close controls', () => {
    const patterns = ['chatgpt', 'claude', 'gemini']
      .flatMap((provider) => knownBlockerLabels(provider as 'chatgpt' | 'claude' | 'gemini'))
      .map(String)
      .join(' ');

    expect(patterns).not.toMatch(/Continue|Close/);
  });
});
