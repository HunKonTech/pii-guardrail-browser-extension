export const PROVIDERS = ['chatgpt', 'claude', 'gemini'] as const;

export type ProviderName = (typeof PROVIDERS)[number];
export type LiveStatus =
  | 'passed'
  | 'incompatible'
  | 'unavailable'
  | 'vendor-error'
  | 'harness-error';

export type LivePhase =
  | 'preflight'
  | 'browser'
  | 'navigation'
  | 'blockers'
  | 'composer'
  | 'paste'
  | 'review'
  | 'replacement'
  | 'submit'
  | 'sent-message'
  | 'response'
  | 'transformer'
  | 'reveal'
  | 'copy'
  | 'clipboard-toast'
  | 'spa-navigation'
  | 'complete'
  | 'unknown';

export interface LiveArtifact {
  kind: 'screenshot' | 'trace' | 'console' | 'fingerprint' | 'deep-diagnostics';
  path: string;
}

export interface StructureFingerprint {
  urlOrigin: string;
  pathShape: string;
  dialogCount: number;
  visibleTextboxCount?: number;
  visibleButtonCount?: number;
}

export interface LiveProviderResult {
  provider: ProviderName;
  status: LiveStatus;
  phase: LivePhase;
  cause: string;
  startedAt: string;
  endedAt: string;
  timings: Partial<Record<LivePhase, number>>;
  artifacts: LiveArtifact[];
  redirects?: string[];
  consoleErrors?: string[];
  fingerprint?: StructureFingerprint;
}

export interface LiveRunMetadata {
  runId: string;
  commit: string;
  dirty: boolean;
  authoritative: boolean;
  headed: boolean;
  deepDiagnostics: boolean;
  providers: ProviderName[];
  startedAt: string;
  extensionVersion: string;
  playwrightVersion: string;
  browserVersion?: string;
  viewport: { width: number; height: number };
  locale: 'en-US';
  timezoneId: 'Europe/Berlin';
}

export interface LiveReport {
  schemaVersion: 1;
  metadata: LiveRunMetadata;
  endedAt: string;
  exitCode: 0 | 1;
  results: LiveProviderResult[];
}

export interface CommonFlowPort {
  navigate(): Promise<void>;
  handleKnownBlockers(): Promise<void>;
  findComposer(): Promise<void>;
  pasteWithSystemClipboard(): Promise<void>;
  assertRawValueHeld(): Promise<void>;
  confirmReview(): Promise<string>;
  submit(replacement: string): Promise<void>;
  assertSentMessage(replacement: string): Promise<void>;
  waitForResponse(replacement: string): Promise<void>;
}
