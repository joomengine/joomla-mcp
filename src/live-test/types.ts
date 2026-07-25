import type { Toolset } from '../config/schema.js';
import type { LiveProgressReporter } from './progress.js';

export const liveTestStatuses = [
  'PASS',
  'FAIL',
  'EXPECTED_DENIAL',
  'KNOWN_UPSTREAM_LIMITATION',
  'SOURCE_ONLY_GATED',
  'BLOCKED_BY_PREREQUISITE',
  'CLEANUP_FAILED',
] as const;

export type LiveTestStatus = (typeof liveTestStatuses)[number];
export type LiveTestProfile = 'read' | 'crud' | 'full';
export type LiveJoomlaPath = 'api' | 'cli';
export type LiveMcpTransport = 'stdio' | 'http';

export interface LiveScenarioSource {
  readonly repository?: string;
  readonly commit?: string;
  readonly path?: string;
  readonly registration?: string;
}

export interface LiveScenario {
  readonly id: string;
  readonly title: string;
  readonly domain: string;
  readonly risk: string;
  readonly toolset: Toolset;
  readonly operation: string;
  readonly joomlaPaths: readonly LiveJoomlaPath[];
  readonly sourceOnlyReason?: string;
  readonly source?: LiveScenarioSource;
}

export interface LiveTestSelection {
  readonly profile: LiveTestProfile;
  readonly joomlaPaths: readonly LiveJoomlaPath[];
  readonly mcpTransports: readonly LiveMcpTransport[];
  readonly families: readonly string[];
}

export interface LiveTestOptions extends LiveTestSelection {
  readonly configurationFile: string;
  readonly scenarioFile?: string;
  readonly site?: string;
  readonly outputDirectory: string;
  readonly nonInteractive: boolean;
  readonly confirmMutations: boolean;
  readonly disposable: boolean;
  readonly cleanup: boolean;
  readonly retainDemo: boolean;
  readonly failFast: boolean;
  readonly seed: string;
  readonly repositoryCommit?: string;
  readonly fixtureDigests?: Readonly<Record<string, string>>;
  readonly stdioCommand?: string;
  readonly stdioArguments?: readonly string[];
}

export interface LiveTestRunnerDependencies {
  readonly progress?: LiveProgressReporter;
  readonly heartbeatSeconds?: number;
}

export interface LiveTestAttempt {
  readonly id: string;
  readonly scenarioId: string;
  readonly title: string;
  readonly domain: string;
  readonly risk: string;
  readonly toolset: Toolset;
  readonly operation: string;
  readonly mcpTransport: LiveMcpTransport;
  readonly joomlaPath: LiveJoomlaPath;
  readonly phase: string;
  readonly status: LiveTestStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly request?: unknown;
  readonly response?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly reason?: string;
  readonly failureCode?: string;
  readonly stack?: string;
  readonly dependencyIds?: readonly string[];
  readonly rootCauseId?: string;
  readonly reproduction: string;
  readonly source?: LiveScenarioSource;
  readonly knownLimitation?: LiveKnownUpstreamLimitation;
  readonly cleanup?: boolean;
}

export interface LiveKnownUpstreamLimitation {
  readonly code: string;
  readonly fixture: string;
  readonly explanation: string;
  readonly reference: string;
  readonly observedError: string;
}

export interface LiveTestEnvironment {
  readonly packageVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly repositoryCommit: string;
  readonly seed: string;
  readonly configurationFingerprint: string;
  readonly fixtureDigests: Readonly<Record<string, string>>;
  readonly transportDiagnostics: readonly Readonly<Record<string, unknown>>[];
}

export interface LiveTestSummary {
  readonly schema: 'joomengine.joomla-mcp.live-test/v1';
  readonly runId: string;
  readonly site: string;
  readonly hostname: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly selection: LiveTestSelection;
  readonly scenario?: {
    readonly name: string;
    readonly file: string;
    readonly fingerprint: string;
    readonly cleanup: 'always' | 'never';
  };
  readonly environment: LiveTestEnvironment;
  readonly catalogue: {
    readonly total: number;
    readonly selected: number;
    readonly sourceOnly: number;
  };
  readonly counts: Readonly<Record<LiveTestStatus, number>>;
  readonly attempts: readonly LiveTestAttempt[];
  readonly retainedRecords: readonly LiveRetainedRecord[];
  readonly exitCode: number;
}

export interface LiveRetainedRecord {
  readonly lane: string;
  readonly family: string;
  readonly id: string | number;
  readonly label: string;
}

export interface LiveMcpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface LiveMcpSession {
  readonly kind: LiveMcpTransport;
  call(call: LiveMcpCall): Promise<unknown>;
  close(): Promise<void>;
  diagnostics(): Readonly<Record<string, unknown>>;
}
