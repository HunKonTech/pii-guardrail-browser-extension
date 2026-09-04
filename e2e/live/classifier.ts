import type {
  LiveArtifact,
  LivePhase,
  LiveProviderResult,
  LiveStatus,
  ProviderName,
} from './contracts';
import { redactBounded } from './redaction';

export class LiveE2EError extends Error {
  constructor(
    readonly kind: Exclude<LiveStatus, 'passed'>,
    readonly phase: LivePhase,
    message: string,
  ) {
    super(message);
    this.name = 'LiveE2EError';
  }
}

interface ClassificationContext {
  provider: ProviderName;
  startedAt: string;
  endedAt: string;
  artifacts?: LiveArtifact[];
  timings?: Partial<Record<LivePhase, number>>;
  redactions?: string[];
}

export function classifyLiveError(
  error: unknown,
  context: ClassificationContext,
): LiveProviderResult {
  const classified = error instanceof LiveE2EError ? error : null;
  return {
    provider: context.provider,
    status: classified?.kind ?? 'harness-error',
    phase: classified?.phase ?? 'unknown',
    cause: redactBounded(
      error instanceof Error ? error.message : String(error),
      context.redactions ?? [],
      300,
    ),
    startedAt: context.startedAt,
    endedAt: context.endedAt,
    artifacts: context.artifacts ?? [],
    timings: context.timings ?? {},
  };
}

export function overallExitCode(
  results: ReadonlyArray<Pick<LiveProviderResult, 'status'>>,
): 0 | 1 {
  return results.every((result) => result.status === 'passed') ? 0 : 1;
}
