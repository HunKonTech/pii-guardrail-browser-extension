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

// A step that fails while a provider dialog or access wall covers the page was
// blocked by the provider, which the report must not present as an extension or
// harness failure. Blockers can appear at any point, not only before the composer.
export function attributeToProviderBlocker(error: unknown, blocked: boolean): unknown {
  if (!blocked) return error;
  if (error instanceof LiveE2EError && (error.kind === 'unavailable' || error.kind === 'vendor-error')) {
    return error;
  }
  const phase = error instanceof LiveE2EError ? error.phase : 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  return new LiveE2EError('unavailable', phase, `A provider dialog or access wall covered the page: ${message}`);
}

export function overallExitCode(
  results: ReadonlyArray<Pick<LiveProviderResult, 'status'>>,
): 0 | 1 {
  return results.every((result) => result.status === 'passed') ? 0 : 1;
}
