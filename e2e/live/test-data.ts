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
  // The run suffix stays outside the name: Local AI rightly leaves it unreplaced,
  // and a reply echoing it would never match the bare placeholder.
  const rawValue = 'Johanna Prüfling';
  return {
    rawValue,
    prompt: `Live check ${suffix(runId)}. Reply with exactly this name and nothing else: ${rawValue}`,
    expectedReplacementType: 'PERSON',
  };
}
