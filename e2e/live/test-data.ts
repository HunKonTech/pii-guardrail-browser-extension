export interface LiveTestCase {
  rawValue: string;
  prompt: string;
  expectedReplacementType: 'EMAIL' | 'PERSON';
}

function suffix(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
}

export function patternTestCase(runId: string): LiveTestCase {
  const rawValue = `live-e2e-${suffix(runId)}@example.invalid`;
  return {
    rawValue,
    prompt: `Reply with exactly this value and nothing else: ${rawValue}`,
    expectedReplacementType: 'EMAIL',
  };
}

export function transformerTestCase(runId: string): LiveTestCase {
  const rawValue = `Johanna Prüfling ${suffix(runId)}`;
  return {
    rawValue,
    prompt: `Reply with exactly this name and nothing else: ${rawValue}`,
    expectedReplacementType: 'PERSON',
  };
}
