import { randomUUID } from 'node:crypto';
import { hostname as operatingSystemHostname, platform, arch } from 'node:os';

import { joomlaCrudBases } from '../catalog/crud-bases.js';
import { loadConfiguration } from '../config/load.js';
import type { SiteConfig, Toolset } from '../config/schema.js';
import { JOOMLA_MCP_VERSION } from '../version.js';
import { liveScenarioCatalog } from './catalog.js';
import {
  crudFixtureDefinitions,
  crudFixtureOrder,
  type LiveFixtureContext,
  type LiveFixtureRecord,
} from './fixtures.js';
import {
  configurationFingerprint,
  statusCounts,
  writeLiveTestReports,
} from './reporting.js';
import {
  expandLiveScenarioValue,
  loadLiveScenarioConfiguration,
  orderedLiveScenarioRecords,
  resolveLiveScenarioValue,
  scenarioActionSelected,
  type LiveScenarioConfiguration,
} from './scenario-config.js';
import {
  progressHeartbeat,
  safeProgressReport,
  withProgressOperation,
} from './progress.js';
import {
  knownUpstreamLimitation,
  verifiedDeletionLimitation,
  verifiedPartialMutationLimitation,
} from './known-limitations.js';
import {
  createHttpLiveSession,
  createStdioLiveSession,
  LiveMcpToolError,
} from './transports.js';
import type {
  LiveJoomlaPath,
  LiveMcpSession,
  LiveRetainedRecord,
  LiveScenario,
  LiveKnownUpstreamLimitation,
  LiveTestAttempt,
  LiveTestOptions,
  LiveTestRunnerDependencies,
  LiveTestStatus,
  LiveTestSummary,
} from './types.js';

interface LaneState {
  readonly lane: string;
  readonly records: Map<string, LiveFixtureRecord>;
  readonly references: Map<string, LiveFixtureRecord>;
  readonly reads: Map<string, unknown>;
  readonly created: LiveRetainedRecord[];
  readonly namedRecords: Map<string, LiveFixtureRecord>;
}

const fixtureMediaPath = 'local-images:/joomla-mcp-live-prerequisite.png';
const fixturePrivacyEmail = 'fixture@example.invalid';
const fixturePrivacyConsentSubject = 'Joomla MCP live prerequisite consent';
const fixtureAdministratorOverride = Object.freeze({
  language: 'en-GB',
  constant: 'JOOMLA_MCP_LIVE_PREREQUISITE_ADMINISTRATOR',
  value: 'Joomla MCP live prerequisite administrator',
});
const fixtureSiteOverride = Object.freeze({
  language: 'en-GB',
  constant: 'JOOMLA_MCP_LIVE_PREREQUISITE_SITE',
  value: 'Joomla MCP live prerequisite site',
});

interface AttemptOutcome {
  readonly response?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly status?: Extract<
    LiveTestStatus,
    'PASS' | 'EXPECTED_DENIAL' | 'KNOWN_UPSTREAM_LIMITATION'
  >;
  readonly reason?: string;
  readonly knownLimitation?: LiveKnownUpstreamLimitation;
}

class BlockedError extends Error {
  readonly dependencyIds: readonly string[];
  readonly rootCauseId?: string;

  constructor(message: string, dependencyIds: readonly string[] = [], rootCauseId?: string) {
    super(message);
    this.name = 'BlockedError';
    this.dependencyIds = dependencyIds;
    if (rootCauseId !== undefined) this.rootCauseId = rootCauseId;
  }
}

export async function runLiveTest(
  options: LiveTestOptions,
  dependencies: LiveTestRunnerDependencies = {},
): Promise<LiveTestSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = `jmcp-${startedAt.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${safeSegment(options.seed).slice(0, 12)}`;
  const scenarioConfiguration = options.scenarioFile === undefined
    ? undefined
    : await loadLiveScenarioConfiguration(options.scenarioFile);
  const progress = scenarioConfiguration?.progress.enabled === false
    ? undefined
    : dependencies.progress;
  const heartbeatSeconds = dependencies.heartbeatSeconds ??
    heartbeatSecondsFromEnvironment(scenarioConfiguration?.progress.heartbeatSeconds ?? 30);
  safeProgressReport(progress, {
    kind: 'run-start',
    timestamp: startedAt,
    runId,
    message: `Starting ${scenarioConfiguration?.name ?? 'legacy catalogue'} live validation.`,
  });
  const configuration = await loadConfiguration(options.configurationFile);
  const siteId = options.site ?? configuration.defaultSite;
  const site = configuration.sites.get(siteId);
  if (site === undefined) throw new Error(`Configured Joomla site ${siteId} does not exist.`);
  validateSelection(options, site);
  const hostname = targetHostname(site);
  const catalogue = liveScenarioCatalog();
  const selected = catalogue.filter((scenario) =>
    (scenarioConfiguration === undefined || scenarioActionSelected(scenario.id, scenarioConfiguration)) &&
    (
      options.families.length === 0 ||
      options.families.includes(scenario.domain) ||
      options.families.some((family) => scenario.id.startsWith(`${family}.`))
    ));
  const attempts: LiveTestAttempt[] = [];
  const latestAttemptByScenario = new Map<string, string>();
  const sessions: LiveMcpSession[] = [];
  const transportDiagnostics: Readonly<Record<string, unknown>>[] = [];
  const retained: LiveRetainedRecord[] = [];
  const retentionLane = `${options.mcpTransports[0]}-${options.joomlaPaths[0]}`;
  let activeTransport = options.mcpTransports[0]!;
  let activeJoomlaPath = options.joomlaPaths[0]!;
  let sequence = 0;

  const reproduction = (
    scenario: LiveScenario,
    mcpTransport: LiveMcpSession['kind'],
    joomlaPath: LiveJoomlaPath,
  ): string => {
    const argumentsList = [
      'npx joomla-mcp-live-test',
      '--config', options.configurationFile,
      '--site', siteId,
      '--profile', options.profile,
      '--joomla-path', joomlaPath,
      '--mcp-transport', mcpTransport,
      '--families', scenario.domain,
      '--seed', options.seed,
      '--output', options.outputDirectory,
      '--non-interactive',
      ...(isMutatingProfile(options.profile) ? ['--confirm-mutations'] : []),
      ...(options.disposable ? ['--disposable'] : []),
      ...(options.scenarioFile === undefined ? [] : ['--scenario', options.scenarioFile]),
    ];
    return argumentsList.map(shellArgument).join(' ');
  };

  const recordAttempt = async (
    session: LiveMcpSession,
    joomlaPath: LiveJoomlaPath,
    scenario: LiveScenario,
    phase: string,
    request: unknown,
    execute: () => Promise<AttemptOutcome>,
    cleanup = false,
  ): Promise<AttemptOutcome | undefined> => {
    const attemptStarted = Date.now();
    const id = `${String(++sequence).padStart(4, '0')}-${safeSegment(session.kind)}-${safeSegment(joomlaPath)}-${safeSegment(scenario.id)}-${safeSegment(phase)}`;
    safeProgressReport(progress, {
      kind: 'attempt-start',
      timestamp: new Date(attemptStarted).toISOString(),
      attemptId: id,
      scenarioId: scenario.id,
      phase,
      transport: session.kind,
      joomlaPath,
      elapsedMs: 0,
    });
    const heartbeat = progressHeartbeat(progress, {
      attemptId: id,
      scenarioId: scenario.id,
      phase,
      transport: session.kind,
      joomlaPath,
    }, attemptStarted, heartbeatSeconds);
    try {
      const outcome = await execute();
      const durationMs = Date.now() - attemptStarted;
      const attempt = Object.freeze({
        id,
        scenarioId: scenario.id,
        title: scenario.title,
        domain: scenario.domain,
        risk: scenario.risk,
        toolset: scenario.toolset,
        operation: scenario.operation,
        mcpTransport: session.kind,
        joomlaPath,
        phase,
        status: outcome.status ?? 'PASS',
        startedAt: new Date(attemptStarted).toISOString(),
        durationMs,
        request,
        ...(outcome.response === undefined ? {} : { response: outcome.response }),
        ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
        ...(outcome.actual === undefined ? {} : { actual: outcome.actual }),
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.knownLimitation === undefined
          ? {}
          : {
              failureCode: outcome.knownLimitation.code,
              knownLimitation: outcome.knownLimitation,
            }),
        reproduction: reproduction(scenario, session.kind, joomlaPath),
        ...(scenario.source === undefined ? {} : { source: scenario.source }),
        ...(cleanup ? { cleanup: true } : {}),
      });
      attempts.push(attempt);
      latestAttemptByScenario.set(scenario.id, id);
      safeProgressReport(progress, {
        kind: 'attempt-result',
        timestamp: new Date().toISOString(),
        attemptId: id,
        scenarioId: scenario.id,
        phase,
        transport: session.kind,
        joomlaPath,
        elapsedMs: durationMs,
        status: attempt.status,
        ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
      });
      return outcome;
    } catch (error) {
      const blocked = error instanceof BlockedError;
      const knownLimitation = blocked
        ? undefined
        : knownUpstreamLimitation({
            options,
            joomlaPath,
            scenarioId: scenario.id,
            phase,
            error: errorMessage(error),
          });
      const status: LiveTestStatus = knownLimitation !== undefined
        ? 'KNOWN_UPSTREAM_LIMITATION'
        : blocked
          ? 'BLOCKED_BY_PREREQUISITE'
          : cleanup
            ? 'CLEANUP_FAILED'
            : 'FAIL';
      const rootCauseId = blocked
        ? error.rootCauseId ??
          error.dependencyIds.map((dependency) => latestAttemptByScenario.get(dependency)).find((value) => value !== undefined)
        : undefined;
      const durationMs = Date.now() - attemptStarted;
      const attempt = Object.freeze({
        id,
        scenarioId: scenario.id,
        title: scenario.title,
        domain: scenario.domain,
        risk: scenario.risk,
        toolset: scenario.toolset,
        operation: scenario.operation,
        mcpTransport: session.kind,
        joomlaPath,
        phase,
        status,
        startedAt: new Date(attemptStarted).toISOString(),
        durationMs,
        request,
        actual: errorResult(error),
        reason: errorMessage(error),
        failureCode: knownLimitation?.code ??
          (blocked ? 'prerequisite_unavailable' : classifyError(error)),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        ...(blocked && error.dependencyIds.length > 0 ? { dependencyIds: error.dependencyIds } : {}),
        ...(rootCauseId === undefined ? {} : { rootCauseId }),
        ...(knownLimitation === undefined ? {} : { knownLimitation }),
        reproduction: reproduction(scenario, session.kind, joomlaPath),
        ...(scenario.source === undefined ? {} : { source: scenario.source }),
        ...(cleanup ? { cleanup: true } : {}),
      });
      attempts.push(attempt);
      latestAttemptByScenario.set(scenario.id, id);
      safeProgressReport(progress, {
        kind: 'attempt-result',
        timestamp: new Date().toISOString(),
        attemptId: id,
        scenarioId: scenario.id,
        phase,
        transport: session.kind,
        joomlaPath,
        elapsedMs: durationMs,
        status,
        reason: attempt.reason,
      });
      if (
        options.failFast &&
        status !== 'BLOCKED_BY_PREREQUISITE' &&
        status !== 'KNOWN_UPSTREAM_LIMITATION'
      ) {
        throw error;
      }
      return knownLimitation === undefined
        ? undefined
        : {
            status: 'KNOWN_UPSTREAM_LIMITATION',
            reason: knownLimitation.explanation,
            knownLimitation,
          };
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }
  };

  try {
    for (const kind of options.mcpTransports) {
      activeTransport = kind;
      safeProgressReport(progress, {
        kind: 'session-start',
        timestamp: new Date().toISOString(),
        transport: kind,
        message: 'Connecting MCP transport.',
      });
      const session = await withProgressOperation(
        progress,
        {
          operationId: `connect-${kind}`,
          operation: 'Connect and initialize MCP transport',
          transport: kind,
        },
        heartbeatSeconds,
        async () => kind === 'stdio'
          ? await createStdioLiveSession({
              configurationFile: options.configurationFile,
              ...(options.stdioCommand === undefined ? {} : { command: options.stdioCommand }),
              ...(options.stdioArguments === undefined ? {} : { arguments: options.stdioArguments }),
            })
          : await createHttpLiveSession(configuration),
      );
      sessions.push(session);
      safeProgressReport(progress, {
        kind: 'session-ready',
        timestamp: new Date().toISOString(),
        transport: kind,
        message: 'MCP transport is ready.',
      });
    }

    for (const session of sessions) {
      activeTransport = session.kind;
      await withProgressOperation(
        progress,
        {
          operationId: `discovery-${session.kind}`,
          operation: 'Verify sites, capabilities, and action discovery through MCP',
          transport: session.kind,
        },
        heartbeatSeconds,
        async () => verifyDiscovery(session, siteId),
      );
      if (isMutatingProfile(options.profile)) {
        await withProgressOperation(
          progress,
          {
            operationId: `permissions-${session.kind}`,
            operation: 'Request and approve the live-test write permission grant',
            transport: session.kind,
          },
          heartbeatSeconds,
          async () => grantPermissions(session, siteId, selected, options),
        );
      }
      for (const joomlaPath of options.joomlaPaths) {
        activeJoomlaPath = joomlaPath;
        safeProgressReport(progress, {
          kind: 'lane-start',
          timestamp: new Date().toISOString(),
          transport: session.kind,
          joomlaPath,
          message: 'Starting Joomla execution lane.',
        });
        const state: LaneState = {
          lane: `${session.kind}-${joomlaPath}`,
          records: new Map(),
          references: new Map(),
          reads: new Map(),
          created: [],
          namedRecords: new Map(),
        };

        if (options.profile === 'read') {
          await runReadProfile(session, joomlaPath, siteId, site, selected, state, recordAttempt);
        } else {
          if (scenarioConfiguration === undefined) {
            await runCrudProfile(session, joomlaPath, siteId, site, selected, state, recordAttempt, options);
          } else {
            await runConfiguredCrudProfile(
              session,
              joomlaPath,
              siteId,
              site,
              selected,
              state,
              recordAttempt,
              options,
              scenarioConfiguration,
            );
          }
          if (options.profile === 'full') {
            await runSpecialProfile(session, joomlaPath, siteId, site, selected, state, recordAttempt, options);
          }
        }

        if (scenarioConfiguration !== undefined) {
          if (options.cleanup) {
            await cleanupConfiguredRecords(
              session,
              joomlaPath,
              siteId,
              state,
              recordAttempt,
              options,
              scenarioConfiguration,
            );
          }
          retained.push(...state.created);
        } else if (options.cleanup || (options.retainDemo && state.lane !== retentionLane)) {
          await cleanupRecords(session, joomlaPath, siteId, state, recordAttempt, options);
          retained.push(...state.created);
        } else {
          retained.push(...state.created);
        }
        safeProgressReport(progress, {
          kind: 'lane-complete',
          timestamp: new Date().toISOString(),
          transport: session.kind,
          joomlaPath,
          message: `Completed lane with ${state.created.length} retained records.`,
        });
      }
    }

    for (const session of sessions) {
      if (!options.joomlaPaths.includes('api')) continue;
      for (const scenario of selected.filter((candidate) => candidate.sourceOnlyReason !== undefined)) {
        const id = `${String(++sequence).padStart(4, '0')}-${session.kind}-api-${safeSegment(scenario.id)}-source-gate`;
        safeProgressReport(progress, {
          kind: 'attempt-start',
          timestamp: new Date().toISOString(),
          attemptId: id,
          scenarioId: scenario.id,
          phase: 'source-gate',
          transport: session.kind,
          joomlaPath: 'api',
          elapsedMs: 0,
        });
        attempts.push(Object.freeze({
          id,
          scenarioId: scenario.id,
          title: scenario.title,
          domain: scenario.domain,
          risk: scenario.risk,
          toolset: scenario.toolset,
          operation: scenario.operation,
          mcpTransport: session.kind,
          joomlaPath: 'api',
          phase: 'source-gate',
          status: 'SOURCE_ONLY_GATED',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          reason: scenario.sourceOnlyReason!,
          expected: 'MCP rejects the source-catalogued action before transport dispatch.',
          reproduction: reproduction(scenario, session.kind, 'api'),
          ...(scenario.source === undefined ? {} : { source: scenario.source }),
        }));
        safeProgressReport(progress, {
          kind: 'attempt-result',
          timestamp: new Date().toISOString(),
          attemptId: id,
          scenarioId: scenario.id,
          phase: 'source-gate',
          transport: session.kind,
          joomlaPath: 'api',
          elapsedMs: 0,
          status: 'SOURCE_ONLY_GATED',
          reason: scenario.sourceOnlyReason!,
        });
      }
    }
  } catch (error) {
    const reason = errorMessage(error);
    const lastAttempt = attempts.at(-1);
    const alreadyRecorded =
      (lastAttempt?.status === 'FAIL' || lastAttempt?.status === 'CLEANUP_FAILED') &&
      lastAttempt.reason === reason;
    if (!alreadyRecorded) {
      const scenario: LiveScenario = {
        id: 'live-test.harness',
        title: 'Live-test harness execution',
        domain: 'system',
        risk: 'read',
        toolset: 'discovery',
        operation: 'execute',
        joomlaPaths: [activeJoomlaPath],
      };
      const attemptStarted = Date.now();
      attempts.push(Object.freeze({
        id: `${String(++sequence).padStart(4, '0')}-${safeSegment(activeTransport)}-${safeSegment(activeJoomlaPath)}-live-test-harness-fatal`,
        scenarioId: scenario.id,
        title: scenario.title,
        domain: scenario.domain,
        risk: scenario.risk,
        toolset: scenario.toolset,
        operation: scenario.operation,
        mcpTransport: activeTransport,
        joomlaPath: activeJoomlaPath,
        phase: 'harness',
        status: 'FAIL',
        startedAt: new Date(attemptStarted).toISOString(),
        durationMs: Date.now() - attemptStarted,
        request: {
          profile: options.profile,
          joomlaPath: activeJoomlaPath,
          mcpTransport: activeTransport,
        },
        actual: errorResult(error),
        reason,
        failureCode: classifyError(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        reproduction: reproduction(scenario, activeTransport, activeJoomlaPath),
      }));
    }
  } finally {
    transportDiagnostics.push(...sessions.map((session) => session.diagnostics()));
    await Promise.allSettled(sessions.map(async (session) => {
      await withProgressOperation(
        progress,
        {
          operationId: `close-${session.kind}`,
          operation: 'Close MCP transport',
          transport: session.kind,
        },
        heartbeatSeconds,
        async () => session.close(),
      );
      safeProgressReport(progress, {
        kind: 'session-close',
        timestamp: new Date().toISOString(),
        transport: session.kind,
        message: 'MCP transport closed.',
      });
    }));
  }

  const completedAtMs = Date.now();
  const counts = statusCounts(attempts);
  const exitCode = liveTestExitCode(options, counts);
  const summary: LiveTestSummary = Object.freeze({
    schema: 'joomengine.joomla-mcp.live-test/v1',
    runId,
    site: siteId,
    hostname,
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
    selection: Object.freeze({
      profile: options.profile,
      joomlaPaths: Object.freeze([...options.joomlaPaths]),
      mcpTransports: Object.freeze([...options.mcpTransports]),
      families: Object.freeze([...options.families]),
    }),
    ...(scenarioConfiguration === undefined || options.scenarioFile === undefined
      ? {}
      : {
          scenario: Object.freeze({
            name: scenarioConfiguration.name,
            file: options.scenarioFile,
            fingerprint: configurationFingerprint(scenarioConfiguration),
            cleanup: options.cleanup ? 'always' as const : 'never' as const,
          }),
        }),
    environment: Object.freeze({
      packageVersion: JOOMLA_MCP_VERSION,
      nodeVersion: process.version,
      platform: platform(),
      architecture: arch(),
      repositoryCommit: options.repositoryCommit ?? process.env['GITHUB_SHA'] ?? 'local',
      seed: options.seed,
      configurationFingerprint: configurationFingerprint(configurationForFingerprint(configuration, siteId)),
      fixtureDigests: Object.freeze({ ...(options.fixtureDigests ?? {}) }),
      transportDiagnostics: Object.freeze(transportDiagnostics),
    }),
    catalogue: Object.freeze({
      total: catalogue.length,
      selected: selected.length,
      sourceOnly: selected.filter((scenario) => scenario.sourceOnlyReason !== undefined).length,
    }),
    counts,
    attempts: Object.freeze(attempts),
    retainedRecords: Object.freeze(retained),
    exitCode,
  });
  safeProgressReport(progress, {
    kind: 'report-start',
    timestamp: new Date().toISOString(),
    message: `Writing evidence to ${options.outputDirectory}.`,
  });
  await withProgressOperation(
    progress,
    {
      operationId: 'write-evidence',
      operation: `Write live-test evidence to ${options.outputDirectory}`,
    },
    heartbeatSeconds,
    async () => writeLiveTestReports(options.outputDirectory, summary),
  );
  safeProgressReport(progress, {
    kind: 'report-complete',
    timestamp: new Date().toISOString(),
    message: `Evidence written to ${options.outputDirectory}.`,
  });
  safeProgressReport(progress, {
    kind: 'run-complete',
    timestamp: new Date().toISOString(),
    runId,
    message: `Live validation ${exitCode === 0 ? 'passed' : 'failed'} with ${attempts.length} attempts.`,
  });
  return summary;
}

async function verifyDiscovery(session: LiveMcpSession, site: string): Promise<void> {
  await session.call({ name: 'joomla_sites_list', arguments: {} });
  await session.call({ name: 'joomla_capabilities', arguments: { site } });
  await session.call({
    name: 'joomla_actions_search',
    arguments: { site, includeSensitive: true, includeWrites: true },
  });
}

async function grantPermissions(
  session: LiveMcpSession,
  site: string,
  scenarios: readonly LiveScenario[],
  options: LiveTestOptions,
): Promise<void> {
  if (!options.confirmMutations) {
    throw new Error('Mutation profiles require explicit mutation confirmation.');
  }
  const toolsets = [...new Set(
    scenarios
      .filter((scenario) => scenario.risk === 'write' || scenario.risk === 'destructive' || scenario.risk === 'high')
      .map((scenario) => scenario.toolset)
      .filter((toolset) => toolset.endsWith('.write') || toolset.endsWith('.admin') || toolset === 'core-update'),
  )] as Toolset[];
  if (toolsets.length === 0) return;
  const requested = asRecord(await session.call({
    name: 'joomla_permission_request',
    arguments: {
      site,
      toolsets,
      duration: '30-minutes',
      reason: `Run approved Joomla MCP live validation profile ${options.profile}.`,
    },
  }));
  const requestId = requested['requestId'];
  const acknowledgement = requested['acknowledgement'];
  if (typeof requestId !== 'string' || typeof acknowledgement !== 'string') {
    throw new Error('Permission request did not return an approval contract.');
  }
  await session.call({
    name: 'joomla_permission_approve',
    arguments: { requestId, acknowledgement },
  });
}

export function liveTestExitCode(
  options: Pick<LiveTestOptions, 'profile' | 'disposable' | 'families'>,
  counts: Readonly<Record<LiveTestStatus, number>>,
): number {
  const requiresCompletePrerequisites =
    options.profile === 'full' &&
    options.disposable &&
    options.families.length === 0;
  return (
    counts.FAIL +
    counts.CLEANUP_FAILED +
    (requiresCompletePrerequisites ? counts.BLOCKED_BY_PREREQUISITE : 0) >
    0
  )
    ? 1
    : 0;
}

type AttemptRecorder = (
  session: LiveMcpSession,
  joomlaPath: LiveJoomlaPath,
  scenario: LiveScenario,
  phase: string,
  request: unknown,
  execute: () => Promise<AttemptOutcome>,
  cleanup?: boolean,
) => Promise<AttemptOutcome | undefined>;

async function runReadProfile(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  siteConfiguration: SiteConfig,
  scenarios: readonly LiveScenario[],
  state: LaneState,
  record: AttemptRecorder,
): Promise<void> {
  const reads = scenarios
    .filter((candidate) => isRead(candidate) && candidate.joomlaPaths.includes(path))
    .sort((left, right) => readPriority(left.id) - readPriority(right.id) || left.id.localeCompare(right.id));
  for (const scenario of reads) {
    if (scenario.id.startsWith('joomla-update.') && siteConfiguration.api?.updateToken === undefined) {
      await record(session, path, scenario, 'read', {}, async () => {
        throw new BlockedError(
          'Joomla Update actions require a separately configured X-JUpdate-Token.',
          ['site.api.updateToken'],
        );
      });
      continue;
    }
    const input = await prepareScenarioInput(
      session,
      path,
      scenario,
      'read',
      { action: scenario.id },
      record,
      () => readInput(scenario.id, state),
    );
    if (input === undefined) continue;
    const request = { site, action: scenario.id, input, transport: path };
    const outcome = await record(session, path, scenario, 'read', request, async () => {
      const response = await callRead(session, site, scenario.id, input, path);
      validateReadResult(scenario.id, input, response);
      state.reads.set(scenario.id, response);
      rememberReference(scenario.id, response, state);
      return { response };
    });
    if (outcome === undefined) continue;
  }
}

async function runCrudProfile(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  siteConfiguration: SiteConfig,
  selected: readonly LiveScenario[],
  state: LaneState,
  record: AttemptRecorder,
  options: LiveTestOptions,
): Promise<void> {
  const scenarioById = new Map(selected.map((scenario) => [scenario.id, scenario]));
  const context: LiveFixtureContext = {
    lane: state.lane,
    seed: options.seed,
    get: (baseId) => state.records.get(baseId),
    reference: (baseId) => state.references.get(baseId),
  };

  for (const baseId of crudFixtureOrder) {
    const listScenario = scenarioById.get(`${baseId}.list`);
    if (listScenario !== undefined && listScenario.joomlaPaths.includes(path)) {
      const input = { offset: 0, limit: 20 };
      const outcome = await record(session, path, listScenario, 'list-before', input, async () => {
        const response = await callRead(session, site, listScenario.id, input, path);
        const first = firstEntity(response);
        if (first !== undefined) state.references.set(baseId, first);
        state.reads.set(listScenario.id, response);
        return { response };
      });
      if (outcome === undefined && options.failFast) return;
    }

    const definition = crudFixtureDefinitions.get(baseId);
    if (definition === undefined) continue;
    const missingDependency = definition.dependencies.find((dependency) => state.records.get(dependency) === undefined);
    if (missingDependency !== undefined) {
      for (const operation of ['create', 'get', 'update', 'delete'] as const) {
        const scenario = scenarioById.get(`${baseId}.${operation}`);
        if (scenario === undefined || !scenario.joomlaPaths.includes(path)) continue;
        const blocked = new BlockedError(
          `CRUD family ${baseId} requires a successfully created ${missingDependency} fixture.`,
          [`${missingDependency}.create`],
        );
        await record(session, path, scenario, operation, {}, async () => { throw blocked; });
      }
      continue;
    }

    const createScenario = scenarioById.get(`${baseId}.create`);
    if (createScenario !== undefined && createScenario.joomlaPaths.includes(path)) {
      for (const purpose of ['showcase', 'deletion'] as const) {
        const input = await prepareScenarioInput(
          session,
          path,
          createScenario,
          `create-${purpose}`,
          { purpose },
          record,
          () => ({ data: createFixtureData(baseId, definition.create(context, purpose), purpose) }),
        );
        if (input === undefined) {
          if (purpose === 'showcase') break;
          continue;
        }
        const outcome = await record(session, path, createScenario, `create-${purpose}`, input, async () => {
          const submitted = asRecord(input['data']);
          let response: unknown;
          let knownLimitation: LiveKnownUpstreamLimitation | undefined;
          try {
            response = await callWrite(session, site, createScenario.id, input, path);
          } catch (error) {
            knownLimitation = verifiedPartialMutationLimitation({
              options,
              joomlaPath: path,
              scenarioId: createScenario.id,
              phase: `create-${purpose}`,
              error: errorMessage(error),
            });
            if (knownLimitation === undefined || createScenario.id !== 'messages.messages.create') {
              throw error;
            }
            const verification = await callRead(
              session,
              site,
              'messages.messages.list',
              { offset: 0, limit: 100 },
              path,
            );
            const subject = submitted['subject'];
            const recovered = collectEntities(verification).find((entity) =>
              looselyEqual(entity.attributes['subject'], subject));
            if (recovered === undefined) throw error;
            response = {
              upstreamError: errorResult(error),
              recoveryVerification: verification,
              result: recovered,
            };
          }
          const entity = entityFromMutation(response, submitted);
          if (entity === undefined) {
            throw new Error(`Create action ${createScenario.id} returned no positive resource identifier.`);
          }
          rememberCrudCreate(baseId, purpose, entity, state);
          return {
            response,
            expected: { created: true, purpose },
            actual: { id: entity.id },
            ...(knownLimitation === undefined
              ? {}
              : {
                  status: 'KNOWN_UPSTREAM_LIMITATION' as const,
                  reason: knownLimitation.explanation,
                  knownLimitation,
                }),
          };
        });
        if (
          outcome?.status === 'KNOWN_UPSTREAM_LIMITATION' &&
          path === 'api' &&
          (baseId === 'modules.site' || baseId === 'modules.administrator')
        ) {
          await record(
            session,
            'cli',
            createScenario,
            `create-${purpose}-api-prerequisite`,
            input,
            async () => {
              if (siteConfiguration.cli === undefined) {
                throw new Error(
                  `${createScenario.id} requires the companion CLI to provision an API-readable fixture after the reviewed Joomla API create defect.`,
                );
              }
              const submitted = asRecord(input['data']);
              const response = await callWrite(session, site, createScenario.id, input, 'cli');
              const entity = entityFromMutation(response, submitted);
              if (entity === undefined) {
                throw new Error(
                  `Companion prerequisite creation for ${createScenario.id} returned no positive resource identifier.`,
                );
              }
              rememberCrudCreate(baseId, purpose, entity, state);
              return {
                response,
                expected: {
                  created: true,
                  purpose,
                  prerequisiteFor: `${createScenario.id} API get/update/delete`,
                },
                actual: { id: entity.id },
              };
            },
          );
        }
        if (outcome === undefined && purpose === 'showcase') break;
      }
    }

    const showcase = state.records.get(baseId);
    if (showcase === undefined) {
      for (const [operation, phase] of [
        ['get', 'read-back-created'],
        ['update', 'update-showcase'],
        ['delete', 'delete-candidate'],
      ] as const) {
        const scenario = scenarioById.get(`${baseId}.${operation}`);
        if (scenario === undefined || !scenario.joomlaPaths.includes(path)) continue;
        const blocked = new BlockedError(
          `${scenario.id} requires a successfully created ${baseId} showcase fixture.`,
          [`${baseId}.create`],
        );
        await record(session, path, scenario, phase, {}, async () => { throw blocked; });
      }
      continue;
    }
    const getScenario = scenarioById.get(`${baseId}.get`);
    if (getScenario !== undefined && getScenario.joomlaPaths.includes(path)) {
      const input = await prepareScenarioInput(
        session,
        path,
        getScenario,
        'read-back-created',
        { id: showcase.id },
        record,
        () => ({ id: numericId(showcase.id) }),
      );
      if (input !== undefined) {
        await record(session, path, getScenario, 'read-back-created', input, async () => {
          const response = await callRead(session, site, getScenario.id, input, path);
          const actual = firstEntity(response);
          assertEntityId(actual, showcase.id, getScenario.id);
          return { response, expected: { id: showcase.id }, actual };
        });
      }
    }

    const updateScenario = scenarioById.get(`${baseId}.update`);
    if (updateScenario !== undefined && updateScenario.joomlaPaths.includes(path)) {
      let changes: Readonly<Record<string, unknown>> = {};
      const input = await prepareScenarioInput(
        session,
        path,
        updateScenario,
        'update-showcase',
        { id: showcase.id },
        record,
        () => {
          changes = definition.update(context, showcase);
          return { id: numericId(showcase.id), data: changes };
        },
      );
      if (input === undefined) continue;
      const outcome = await record(session, path, updateScenario, 'update-showcase', input, async () => {
        try {
          const response = await callWrite(session, site, updateScenario.id, input, path);
          return { response, expected: changes };
        } catch (error) {
          const knownLimitation = verifiedPartialMutationLimitation({
            options,
            joomlaPath: path,
            scenarioId: updateScenario.id,
            phase: 'update-showcase',
            error: errorMessage(error),
          });
          if (knownLimitation === undefined || updateScenario.id !== 'languages.content.update') {
            throw error;
          }
          if (getScenario === undefined || !getScenario.joomlaPaths.includes(path)) throw error;
          const verification = await callRead(
            session,
            site,
            getScenario.id,
            { id: numericId(showcase.id) },
            path,
          );
          assertChangedFields(verification, changes, baseId);
          return {
            status: 'KNOWN_UPSTREAM_LIMITATION' as const,
            response: { upstreamError: errorResult(error), verification },
            expected: changes,
            actual: firstEntity(verification)?.attributes,
            reason: knownLimitation.explanation,
            knownLimitation,
          };
        }
      });
      if (outcome !== undefined && getScenario !== undefined && getScenario.joomlaPaths.includes(path)) {
        const readInputValue = await prepareScenarioInput(
          session,
          path,
          getScenario,
          'read-back-updated',
          { id: showcase.id },
          record,
          () => ({ id: numericId(showcase.id) }),
        );
        if (readInputValue !== undefined) {
          await record(session, path, getScenario, 'read-back-updated', readInputValue, async () => {
            const response = await callRead(session, site, getScenario.id, readInputValue, path);
            const entity = firstEntity(response);
            assertEntityId(entity, showcase.id, getScenario.id);
            try {
              const attributes = assertChangedFields(response, changes, baseId);
              state.records.set(baseId, entity!);
              return { response, expected: changes, actual: attributes };
            } catch (error) {
              const knownLimitation = verifiedPartialMutationLimitation({
                options,
                joomlaPath: path,
                scenarioId: getScenario.id,
                phase: 'read-back-updated',
                error: errorMessage(error),
              });
              if (knownLimitation === undefined || baseId !== 'messages.messages') throw error;
              const collection = await callRead(
                session,
                site,
                'messages.messages.list',
                { offset: 0, limit: 100 },
                path,
              );
              const replacement = collectEntities(collection).find((candidate) =>
                !looselyEqual(candidate.id, showcase.id) &&
                entityMatchesFields(candidate, changes));
              if (replacement === undefined) throw error;
              const replacementCleanup = await callWrite(
                session,
                site,
                'messages.messages.delete',
                { id: numericId(replacement.id) },
                path,
              );
              const cleanupVerification = await callRead(
                session,
                site,
                'messages.messages.list',
                { offset: 0, limit: 100 },
                path,
              );
              if (collectEntities(cleanupVerification).some((candidate) =>
                looselyEqual(candidate.id, replacement.id))) {
                throw new Error(
                  `Joomla created replacement message ${replacement.id} during PATCH and its cleanup did not remove it.`,
                );
              }
              return {
                status: 'KNOWN_UPSTREAM_LIMITATION',
                response: {
                  originalReadBack: response,
                  replacementVerification: collection,
                  replacementCleanup,
                  cleanupVerification,
                },
                expected: changes,
                actual: {
                  original: entity?.attributes,
                  replacement,
                  replacementRemoved: true,
                },
                reason: knownLimitation.explanation,
                knownLimitation,
              };
            }
          });
        }
      }
    }

    const deletion = state.records.get(`${baseId}#deletion`);
    const deleteScenario = scenarioById.get(`${baseId}.delete`);
    if (
      deletion !== undefined &&
      deleteScenario !== undefined &&
      deleteScenario.joomlaPaths.includes(path) &&
      (options.disposable || deleteScenario.risk !== 'destructive')
    ) {
      const input = await prepareScenarioInput(
        session,
        path,
        deleteScenario,
        'delete-candidate',
        { id: deletion.id },
        record,
        () => ({ id: numericId(deletion.id) }),
      );
      if (input === undefined) continue;
      const outcome = await record(session, path, deleteScenario, 'delete-candidate', input, async () => {
        const response = await callWrite(session, site, deleteScenario.id, input, path);
        return { response, expected: { deletedOrTrashed: deletion.id } };
      });
      if (outcome !== undefined && getScenario !== undefined && getScenario.joomlaPaths.includes(path)) {
        if (await verifyDeletion(session, path, site, getScenario, deletion, record, options)) {
          removeRetainedRecord(state, baseId, deletion.id);
        }
      }
    } else if (deletion !== undefined && deleteScenario !== undefined && deleteScenario.joomlaPaths.includes(path)) {
      await addExpectedDenial(
        session,
        path,
        deleteScenario,
        'delete-candidate',
        `Destructive action ${deleteScenario.id} requires --disposable.`,
        record,
      );
    }
  }
}

async function runConfiguredCrudProfile(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  siteConfiguration: SiteConfig,
  selected: readonly LiveScenario[],
  state: LaneState,
  record: AttemptRecorder,
  options: LiveTestOptions,
  configuration: LiveScenarioConfiguration,
): Promise<void> {
  const scenarioById = new Map(selected.map((scenario) => [scenario.id, scenario]));
  const context: LiveFixtureContext = {
    lane: state.lane,
    seed: options.seed,
    get: (baseId) => state.records.get(baseId),
    reference: (baseId) => state.references.get(baseId),
  };

  for (const configured of orderedLiveScenarioRecords(configuration)) {
    const { baseId, reference, definition: configuredRecord } = configured;
    const fixture = crudFixtureDefinitions.get(baseId);
    if (fixture === undefined) continue;
    const createScenario = scenarioById.get(`${baseId}.create`);
    const getScenario = scenarioById.get(`${baseId}.get`);
    const listScenario = scenarioById.get(`${baseId}.list`);
    const updateScenario = scenarioById.get(`${baseId}.update`);
    if (createScenario === undefined || !createScenario.joomlaPaths.includes(path)) continue;

    const missingDependency = configured.dependencyReferences.find((dependency) =>
      !state.namedRecords.has(dependency));
    if (missingDependency !== undefined) {
      await record(session, path, createScenario, `create-${configuredRecord.key}`, {
        resource: reference,
      }, async () => {
        throw new BlockedError(
          `Configured resource ${reference} requires successfully verified ${missingDependency}.`,
          [missingDependency],
        );
      });
      continue;
    }

    let submitted: Readonly<Record<string, unknown>>;
    try {
      const generated = configuredRecord.generate
        ? fixture.create(context, `configured-${configuredRecord.key}`)
        : {};
      const configuredData = configuredRecord.data === undefined
        ? {}
        : asRecord(resolveLiveScenarioValue(
            expandLiveScenarioValue(configuredRecord.data, {
              scenario: configuration.name,
              seed: options.seed,
              lane: state.lane,
            }),
            state.namedRecords,
          ));
      submitted = Object.freeze({ ...generated, ...configuredData });
    } catch (error) {
      await record(session, path, createScenario, `prepare-${configuredRecord.key}`, {
        resource: reference,
      }, async () => { throw error; });
      continue;
    }

    if (listScenario !== undefined && listScenario.joomlaPaths.includes(path)) {
      await record(
        session,
        path,
        listScenario,
        `collision-check-${configuredRecord.key}`,
        { resource: reference, selector: scenarioIdentity(submitted) },
        async () => {
          const existing = await findConfiguredEntityInCollection(
            session,
            site,
            listScenario.id,
            path,
            scenarioIdentity(submitted),
          );
          if (existing.entity !== undefined) {
            throw new Error(
              `Configured resource ${reference} collides with existing Joomla resource ${existing.entity.id}.`,
            );
          }
          return {
            response: existing.pages,
            expected: { collision: false },
            actual: { collision: false },
          };
        },
      );
    }

    const input = { data: submitted };
    let provisional: LiveFixtureRecord | undefined;
    let createResponse: unknown;
    const outcome = await record(
      session,
      path,
      createScenario,
      `create-${configuredRecord.key}`,
      input,
      async () => {
        let response: unknown;
        let knownLimitation: LiveKnownUpstreamLimitation | undefined;
        try {
          response = await callWrite(session, site, createScenario.id, input, path);
        } catch (error) {
          knownLimitation = verifiedPartialMutationLimitation({
            options,
            joomlaPath: path,
            scenarioId: createScenario.id,
            phase: `create-${configuredRecord.key}`,
            error: errorMessage(error),
          });
          if (knownLimitation === undefined || createScenario.id !== 'messages.messages.create') {
            throw error;
          }
          const verification = await callRead(
            session,
            site,
            'messages.messages.list',
            { offset: 0, limit: 100 },
            path,
          );
          const subject = submitted['subject'];
          const recovered = collectEntities(verification).find((entity) =>
            looselyEqual(entity.attributes['subject'], subject));
          if (recovered === undefined) throw error;
          response = {
            upstreamError: errorResult(error),
            recoveryVerification: verification,
            result: recovered,
          };
        }
        createResponse = response;
        provisional = entityFromMutation(response, submitted);
        if (provisional === undefined) {
          throw new Error(
            `Create action ${createScenario.id} returned no candidate ID for ${reference}; ` +
            'the mutation response is not accepted as persistence proof.',
          );
        }
        return {
          response,
          expected: { candidateId: 'positive', resource: reference },
          actual: { candidateId: provisional.id },
          ...(knownLimitation === undefined
            ? {}
            : {
                status: 'KNOWN_UPSTREAM_LIMITATION' as const,
                reason: knownLimitation.explanation,
                knownLimitation,
              }),
        };
      },
    );

    if (
      outcome?.status === 'KNOWN_UPSTREAM_LIMITATION' &&
      path === 'api' &&
      (baseId === 'modules.site' || baseId === 'modules.administrator')
    ) {
      await record(
        session,
        'cli',
        createScenario,
        `create-${configuredRecord.key}-api-prerequisite`,
        input,
        async () => {
          if (siteConfiguration.cli === undefined) {
            throw new BlockedError(
              `${createScenario.id} needs the companion CLI to provision an API-readable fixture ` +
              'after Joomla API module creation fails.',
              ['site.cli'],
            );
          }
          createResponse = await callWrite(session, site, createScenario.id, input, 'cli');
          provisional = entityFromMutation(createResponse, submitted);
          if (provisional === undefined) {
            throw new Error(
              `Companion prerequisite creation for ${reference} returned no candidate ID.`,
            );
          }
          return {
            response: createResponse,
            expected: { candidateId: 'positive', resource: reference },
            actual: { candidateId: provisional.id },
          };
        },
      );
    }

    if (provisional === undefined || getScenario === undefined || listScenario === undefined) {
      continue;
    }
    const createExpectation = Object.freeze({
      ...submitted,
      ...(configuredRecord.verify === undefined
        ? {}
        : asRecord(resolveLiveScenarioValue(
            expandLiveScenarioValue(configuredRecord.verify, {
              scenario: configuration.name,
              seed: options.seed,
              lane: state.lane,
            }),
            state.namedRecords,
          ))),
    });
    const verified = await verifyConfiguredResource(
      session,
      path,
      site,
      baseId,
      reference,
      configuredRecord.key,
      provisional.id,
      createExpectation,
      getScenario,
      listScenario,
      record,
      options,
    );
    if (verified === undefined) continue;
    state.namedRecords.set(reference, verified);
    if (!state.records.has(baseId)) state.records.set(baseId, verified);
    state.created.push({
      lane: state.lane,
      family: baseId,
      id: verified.id,
      label: `${reference}: ${verified.label}`,
    });

    const updates = configuredRecord.updates.length > 0
      ? configuredRecord.updates
      : configuredRecord.generate
        ? [{
            name: 'generated-update',
            data: fixture.update(context, verified),
          }]
        : [];
    let current = verified;
    for (const configuredUpdate of updates) {
      if (updateScenario === undefined || !updateScenario.joomlaPaths.includes(path)) break;
      let changes: Readonly<Record<string, unknown>>;
      try {
        changes = asRecord(resolveLiveScenarioValue(
          expandLiveScenarioValue(configuredUpdate.data, {
            scenario: configuration.name,
            seed: options.seed,
            lane: state.lane,
          }),
          state.namedRecords,
        ));
      } catch (error) {
        await record(session, path, updateScenario, `prepare-${configuredRecord.key}-${configuredUpdate.name}`, {
          resource: reference,
        }, async () => { throw error; });
        continue;
      }
      const updateInput = { id: numericId(current.id), data: changes };
      const updated = await record(
        session,
        path,
        updateScenario,
        `update-${configuredRecord.key}-${safeSegment(configuredUpdate.name)}`,
        updateInput,
        async () => {
          try {
            return {
              response: await callWrite(session, site, updateScenario.id, updateInput, path),
              expected: changes,
            };
          } catch (error) {
            const knownLimitation = verifiedPartialMutationLimitation({
              options,
              joomlaPath: path,
              scenarioId: updateScenario.id,
              phase: `update-${configuredRecord.key}-${safeSegment(configuredUpdate.name)}`,
              error: errorMessage(error),
            });
            if (knownLimitation === undefined) throw error;
            return {
              response: { upstreamError: errorResult(error) },
              expected: changes,
              status: 'KNOWN_UPSTREAM_LIMITATION' as const,
              reason: knownLimitation.explanation,
              knownLimitation,
            };
          }
        },
      );
      if (updated === undefined) continue;
      const verifiedUpdate = await verifyConfiguredResource(
        session,
        path,
        site,
        baseId,
        reference,
        configuredRecord.key,
        current.id,
        changes,
        getScenario,
        listScenario,
        record,
        options,
        `updated-${safeSegment(configuredUpdate.name)}`,
      );
      if (verifiedUpdate !== undefined) {
        current = verifiedUpdate;
        state.namedRecords.set(reference, current);
        if (state.records.get(baseId)?.id === current.id) state.records.set(baseId, current);
      }
    }

  }

  if (!options.cleanup) return;
  for (const configured of [...orderedLiveScenarioRecords(configuration)].reverse()) {
    if (!configured.definition.deleteAfterVerify) continue;
    const entity = state.namedRecords.get(configured.reference);
    if (entity === undefined) continue;
    const deleteScenario = scenarioById.get(`${configured.baseId}.delete`);
    const getScenario = scenarioById.get(`${configured.baseId}.get`);
    if (
      deleteScenario === undefined ||
      getScenario === undefined ||
      !deleteScenario.joomlaPaths.includes(path) ||
      !getScenario.joomlaPaths.includes(path)
    ) {
      continue;
    }
    const deleted = await deleteConfiguredResource(
      session,
      path,
      site,
      configured.baseId,
      configured.reference,
      entity,
      deleteScenario,
      getScenario,
      record,
      options,
      false,
    );
    if (deleted) {
      state.namedRecords.delete(configured.reference);
      removeRetainedRecord(state, configured.baseId, entity.id);
    }
  }
}

async function verifyConfiguredResource(
  session: LiveMcpSession,
  creatingPath: LiveJoomlaPath,
  site: string,
  baseId: string,
  reference: string,
  key: string,
  id: string | number,
  expected: Readonly<Record<string, unknown>>,
  getScenario: LiveScenario,
  listScenario: LiveScenario,
  record: AttemptRecorder,
  options: LiveTestOptions,
  phasePrefix = 'created',
): Promise<LiveFixtureRecord | undefined> {
  let primary: LiveFixtureRecord | undefined;
  const paths = [
    creatingPath,
    ...options.joomlaPaths.filter((candidate) => candidate !== creatingPath),
  ];
  for (const verificationPath of paths) {
    if (
      !getScenario.joomlaPaths.includes(verificationPath) ||
      !listScenario.joomlaPaths.includes(verificationPath)
    ) {
      continue;
    }
    const getInput = { id: numericId(id) };
    let readBack: LiveFixtureRecord | undefined;
    const getOutcome = await record(
      session,
      verificationPath,
      getScenario,
      `verify-${phasePrefix}-get-${key}`,
      getInput,
      async () => {
        const response = await callRead(session, site, getScenario.id, getInput, verificationPath);
        readBack = firstEntity(response);
        assertEntityId(readBack, id, getScenario.id);
        const attributes = assertChangedFields(response, expected, baseId);
        return {
          response,
          expected: visibleExpectation(expected),
          actual: attributes,
        };
      },
    );
    if (getOutcome === undefined || readBack === undefined) continue;

    const identity = scenarioIdentity({ ...expected, ...readBack.attributes });
    let listed: LiveFixtureRecord | undefined;
    const listOutcome = await record(
      session,
      verificationPath,
      listScenario,
      `verify-${phasePrefix}-visible-${key}`,
      { id, selector: identity },
      async () => {
        const collection = await findConfiguredEntityInCollection(
          session,
          site,
          listScenario.id,
          verificationPath,
          identity,
          id,
        );
        listed = collection.entity;
        if (listed === undefined) {
          throw new Error(
            `${reference} (${id}) is readable by item ID but is absent from ${listScenario.id}; ` +
            'it is not certified as visible in Joomla collection/GUI models.',
          );
        }
        return {
          response: collection.pages,
          expected: { id, visible: true, fields: visibleExpectation(expected) },
          actual: { id: listed.id, visible: true, fields: listed.attributes },
        };
      },
    );
    if (listOutcome === undefined || listed === undefined) continue;
    if (verificationPath === creatingPath) {
      primary = Object.freeze({
        id: readBack.id,
        attributes: Object.freeze({ ...readBack.attributes }),
        label: readBack.label,
      });
    }
  }
  return primary;
}

async function findConfiguredEntityInCollection(
  session: LiveMcpSession,
  site: string,
  action: string,
  path: LiveJoomlaPath,
  identity: Readonly<Record<string, unknown>>,
  requiredId?: string | number,
): Promise<{
  readonly entity?: LiveFixtureRecord;
  readonly pages: readonly unknown[];
}> {
  const pages: unknown[] = [];
  const limit = 100;
  for (let offset = 0; offset < 2_000; offset += limit) {
    const response = await callRead(session, site, action, { offset, limit }, path);
    pages.push(response);
    const entities = collectEntities(response);
    const matches = entities.filter((entity) =>
      (requiredId === undefined || looselyEqual(entity.id, requiredId)) &&
      entityMatchesFields(entity, identity));
    if (matches.length > 1) {
      throw new Error(
        `${action} returned multiple records for selector ${JSON.stringify(visibleExpectation(identity))}.`,
      );
    }
    if (matches.length === 1) return { entity: matches[0]!, pages };
    if (entities.length < limit) break;
  }
  return { pages };
}

function scenarioIdentity(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  for (const key of ['alias', 'username', 'menutype'] as const) {
    if (attributes[key] !== undefined) return Object.freeze({ [key]: attributes[key] });
  }
  for (const key of ['title', 'name', 'subject', 'lang_code', 'email', 'old_url', 'link'] as const) {
    if (attributes[key] !== undefined) return Object.freeze({ [key]: attributes[key] });
  }
  throw new Error(
    'Configured resource has no stable alias, username, email, menutype, title, name, subject, or language code.',
  );
}

function visibleExpectation(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      !/password|password2|secret|token|acknowledgement|confirmation/iu.test(key)),
  );
}

async function cleanupConfiguredRecords(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  state: LaneState,
  record: AttemptRecorder,
  options: LiveTestOptions,
  configuration: LiveScenarioConfiguration,
): Promise<void> {
  for (const configured of [...orderedLiveScenarioRecords(configuration)].reverse()) {
    const entity = state.namedRecords.get(configured.reference);
    if (entity === undefined) continue;
    const deleteScenario = liveScenarioCatalog().find((candidate) =>
      candidate.id === `${configured.baseId}.delete`);
    const getScenario = liveScenarioCatalog().find((candidate) =>
      candidate.id === `${configured.baseId}.get`);
    if (
      deleteScenario === undefined ||
      getScenario === undefined ||
      !deleteScenario.joomlaPaths.includes(path) ||
      !getScenario.joomlaPaths.includes(path)
    ) {
      continue;
    }
    const deleted = await deleteConfiguredResource(
      session,
      path,
      site,
      configured.baseId,
      configured.reference,
      entity,
      deleteScenario,
      getScenario,
      record,
      options,
      true,
    );
    if (deleted) {
      state.namedRecords.delete(configured.reference);
      removeRetainedRecord(state, configured.baseId, entity.id);
    }
  }
}

async function deleteConfiguredResource(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  baseId: string,
  reference: string,
  entity: LiveFixtureRecord,
  deleteScenario: LiveScenario,
  getScenario: LiveScenario,
  record: AttemptRecorder,
  options: LiveTestOptions,
  cleanup: boolean,
): Promise<boolean> {
  const trash = deleteSemantics(baseId) === 'permanent'
    ? undefined
    : trashData(baseId, entity.attributes);
  if (trash !== undefined) {
    const updateScenario = liveScenarioCatalog().find((candidate) =>
      candidate.id === `${baseId}.update`);
    if (updateScenario !== undefined && updateScenario.joomlaPaths.includes(path)) {
      const trashInput = { id: numericId(entity.id), data: trash };
      const trashed = await record(
        session,
        path,
        updateScenario,
        `${cleanup ? 'cleanup' : 'delete'}-trash-${safeSegment(reference)}`,
        trashInput,
        async () => ({
          response: await callWrite(session, site, updateScenario.id, trashInput, path),
          expected: trash,
        }),
        cleanup,
      );
      if (trashed === undefined) return false;
    }
  }
  const input = { id: numericId(entity.id) };
  const outcome = await record(
    session,
    path,
    deleteScenario,
    `${cleanup ? 'cleanup' : 'delete'}-${safeSegment(reference)}`,
    input,
    async () => ({
      response: await callWrite(session, site, deleteScenario.id, input, path),
      expected: { removed: entity.id, resource: reference },
    }),
    cleanup,
  );
  return outcome !== undefined &&
    await verifyDeletion(session, path, site, getScenario, entity, record, options, cleanup);
}

function createFixtureData(
  baseId: string,
  data: Readonly<Record<string, unknown>>,
  purpose: 'showcase' | 'deletion',
): Readonly<Record<string, unknown>> {
  if (purpose !== 'deletion' || deleteSemantics(baseId) === 'permanent') return data;
  const trash = trashData(baseId, data);
  return trash === undefined ? data : Object.freeze({ ...data, ...trash });
}

function rememberCrudCreate(
  baseId: string,
  purpose: 'showcase' | 'deletion',
  entity: LiveFixtureRecord,
  state: LaneState,
): void {
  if (purpose === 'showcase') {
    state.records.set(baseId, entity);
  } else {
    state.records.set(`${baseId}#deletion`, entity);
  }
  state.created.push({
    lane: state.lane,
    family: baseId,
    id: entity.id,
    label: `${entity.label}${purpose === 'deletion' ? ' [deletion candidate]' : ''}`,
  });
}

function deleteSemantics(baseId: string): 'resource-model-defined' | 'permanent' {
  return joomlaCrudBases.find((base) => base.id === baseId)?.deleteSemantics ?? 'resource-model-defined';
}

function trashData(
  baseId: string,
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (baseId === 'contacts.contacts') return Object.freeze({ published: -2 });
  if (baseId === 'modules.site' || baseId === 'modules.administrator') {
    const params = asRecord(attributes['params']);
    return Object.freeze({
      ...selectAttributes(attributes, [
        'title', 'content', 'module', 'position', 'showtitle', 'access',
        'language', 'assigned',
      ]),
      published: -2,
      params: {
        ...params,
        layout: typeof params['layout'] === 'string' && params['layout'].length > 0
          ? params['layout']
          : '_:default',
      },
    });
  }
  if (baseId === 'menus.site-items' || baseId === 'menus.administrator-items') {
    return Object.freeze({
      ...selectAttributes(attributes, [
        'menutype', 'title', 'alias', 'note', 'link', 'type', 'parent_id',
        'browserNav', 'access', 'img', 'template_style_id', 'params', 'home',
        'language', 'ordering',
      ]),
      published: -2,
    });
  }
  if (baseId === 'languages.content') {
    return Object.freeze({
      ...selectAttributes(attributes, [
        'lang_code', 'title', 'title_native', 'sef', 'image', 'description',
        'metadesc', 'sitename', 'access', 'ordering',
      ]),
      published: -2,
    });
  }
  if (Object.hasOwn(attributes, 'published')) return Object.freeze({ published: -2 });
  if (Object.hasOwn(attributes, 'state')) return Object.freeze({ state: -2 });
  return undefined;
}

async function runSpecialProfile(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  siteId: string,
  site: SiteConfig,
  selected: readonly LiveScenario[],
  state: LaneState,
  record: AttemptRecorder,
  options: LiveTestOptions,
): Promise<void> {
  const crudIds = new Set(joomlaCrudBases.flatMap((base) =>
    ['list', 'get', 'create', 'update', 'delete'].map((operation) => `${base.id}.${operation}`)));
  const special = selected.filter((scenario) =>
    !crudIds.has(scenario.id) &&
    scenario.sourceOnlyReason === undefined &&
    scenario.joomlaPaths.includes(path));

  for (const scenario of special.filter(isRead)
    .sort((left, right) => readPriority(left.id) - readPriority(right.id) || left.id.localeCompare(right.id))) {
    if (scenario.id.startsWith('joomla-update.') && site.api?.updateToken === undefined) {
      await record(session, path, scenario, 'read', {}, async () => {
        throw new BlockedError(
          'Joomla Update actions require a separately configured X-JUpdate-Token.',
          ['site.api.updateToken'],
        );
      });
      continue;
    }
    const input = await prepareScenarioInput(
      session,
      path,
      scenario,
      'read',
      { action: scenario.id },
      record,
      () => readInput(scenario.id, state),
    );
    if (input === undefined) continue;
    await record(session, path, scenario, 'read', input, async () => {
      const response = await callRead(session, siteId, scenario.id, input, path);
      validateReadResult(scenario.id, input, response);
      state.reads.set(scenario.id, response);
      return { response };
    });
  }

  for (const scenario of special.filter((candidate) => !isRead(candidate))
    .sort((left, right) =>
      specialWritePriority(left.id) - specialWritePriority(right.id) ||
      left.id.localeCompare(right.id))) {
    if (scenario.id.startsWith('joomla-update.') && site.api?.updateToken === undefined) {
      await record(session, path, scenario, 'write', {}, async () => {
        throw new BlockedError(
          'Joomla Update actions require a separately configured X-JUpdate-Token.',
          ['site.api.updateToken'],
        );
      });
      continue;
    }
    if ((scenario.risk === 'destructive' || scenario.risk === 'high') && !options.disposable) {
      await addExpectedDenial(
        session,
        path,
        scenario,
        'write',
        `High-risk action ${scenario.id} requires --disposable.`,
        record,
      );
      continue;
    }
    const input = await prepareScenarioInput(
      session,
      path,
      scenario,
      'write',
      { action: scenario.id },
      record,
      () => specialWriteInput(scenario.id, state, options.seed),
    );
    if (input === undefined) continue;
    const outcome = await record(session, path, scenario, 'write', input, async () => {
      const response = await executeSpecialWrite(
        session,
        path,
        siteId,
        scenario,
        input,
        state,
        options.seed,
      );
      if (
        scenario.id === 'languages.overrides.site.create' ||
        scenario.id === 'languages.overrides.administrator.create'
      ) {
        const data = asRecord(input['data']);
        assertLanguageOverride(
          response,
          String(data['key'] ?? ''),
          String(data['override'] ?? ''),
          scenario.id,
        );
        rememberSpecialWrite(scenario.id, input, response, state);
        return {
          response,
          expected: { id: data['key'], value: data['override'] },
          actual: firstEntity(response),
        };
      }
      rememberSpecialWrite(scenario.id, input, response, state);
      return { response };
    });
    if (outcome !== undefined && outcome.status !== 'KNOWN_UPSTREAM_LIMITATION') {
      await runSpecialReadBack(
        session,
        path,
        siteId,
        scenario,
        input,
        outcome.response,
        selected,
        record,
      );
    }
  }
}

async function runSpecialReadBack(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  writeScenario: LiveScenario,
  writeInput: Readonly<Record<string, unknown>>,
  writeResponse: unknown,
  selected: readonly LiveScenario[],
  record: AttemptRecorder,
): Promise<void> {
  if (writeScenario.id === 'privacy.requests.create') {
    const created = firstEntity(writeResponse);
    if (created === undefined) return;
    const getScenario = selected.find((scenario) => scenario.id === 'privacy.requests.get');
    if (getScenario !== undefined && getScenario.joomlaPaths.includes(path)) {
      const input = { id: numericId(created.id) };
      await record(session, path, getScenario, 'read-back-created', input, async () => {
        const response = await callRead(session, site, getScenario.id, input, path);
        const actual = firstEntity(response);
        assertEntityId(actual, created.id, getScenario.id);
        const expectedEmail = asRecord(writeInput['data'])['email'];
        if (!looselyEqual(actual?.attributes['email'], expectedEmail)) {
          throw new Error('Created privacy request did not return the submitted email address.');
        }
        return { response, expected: { id: created.id, email: expectedEmail }, actual };
      });
    }
    const exportScenario = selected.find((scenario) => scenario.id === 'privacy.requests.export');
    if (exportScenario !== undefined && exportScenario.joomlaPaths.includes(path)) {
      const input = { id: numericId(created.id) };
      await record(session, path, exportScenario, 'read-back-pending', input, async () => {
        try {
          return { response: await callRead(session, site, exportScenario.id, input, path) };
        } catch (error) {
          if (!isJoomlaHttpError(error, 404)) throw error;
          return {
            status: 'EXPECTED_DENIAL',
            response: errorResult(error),
            expected: 'Joomla denies export until the newly created privacy request is confirmed and processed.',
            reason: 'The newly created privacy request is pending, so Joomla correctly returned HTTP 404 instead of exporting data.',
          };
        }
      });
    }
    return;
  }

  if (
    writeScenario.id === 'languages.overrides.site.create' ||
    writeScenario.id === 'languages.overrides.administrator.create'
  ) {
    const getScenario = selected.find((scenario) =>
      scenario.id === writeScenario.id.replace('.create', '.get'));
    if (getScenario === undefined || !getScenario.joomlaPaths.includes(path)) return;
    const data = asRecord(writeInput['data']);
    const input = { language: writeInput['language'], constant: data['key'] };
    await record(session, path, getScenario, 'read-back-created', input, async () => {
      const response = await callRead(session, site, getScenario.id, input, path);
      assertLanguageOverride(
        response,
        String(data['key'] ?? ''),
        String(data['override'] ?? ''),
        getScenario.id,
      );
      return {
        response,
        expected: { id: data['key'], value: data['override'] },
        actual: firstEntity(response),
      };
    });
  }
}

async function cleanupRecords(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  state: LaneState,
  record: AttemptRecorder,
  options: LiveTestOptions,
): Promise<void> {
  for (const baseId of [...crudFixtureOrder].reverse()) {
    const entity = state.records.get(baseId);
    if (entity === undefined) continue;
    const scenario = liveScenarioCatalog().find((candidate) => candidate.id === `${baseId}.delete`);
    if (scenario === undefined || !scenario.joomlaPaths.includes(path)) continue;
    const trash = deleteSemantics(baseId) === 'permanent'
      ? undefined
      : trashData(baseId, entity.attributes);
    if (trash !== undefined) {
      const updateScenario = liveScenarioCatalog().find((candidate) => candidate.id === `${baseId}.update`);
      if (updateScenario !== undefined && updateScenario.joomlaPaths.includes(path)) {
        const trashInput = { id: numericId(entity.id), data: trash };
        const trashed = await record(session, path, updateScenario, 'cleanup-trash-showcase', trashInput, async () => {
          try {
            return {
              response: await callWrite(session, site, updateScenario.id, trashInput, path),
              expected: trash,
            };
          } catch (error) {
            const knownLimitation = verifiedPartialMutationLimitation({
              options,
              joomlaPath: path,
              scenarioId: updateScenario.id,
              phase: 'cleanup-trash-showcase',
              error: errorMessage(error),
            });
            if (knownLimitation === undefined || updateScenario.id !== 'languages.content.update') {
              throw error;
            }
            const getScenario = liveScenarioCatalog().find((candidate) =>
              candidate.id === `${baseId}.get`);
            if (getScenario === undefined || !getScenario.joomlaPaths.includes(path)) throw error;
            const verification = await callRead(
              session,
              site,
              getScenario.id,
              { id: numericId(entity.id) },
              path,
            );
            assertChangedFields(verification, trash, baseId);
            return {
              status: 'KNOWN_UPSTREAM_LIMITATION' as const,
              response: { upstreamError: errorResult(error), verification },
              expected: trash,
              actual: firstEntity(verification)?.attributes,
              reason: knownLimitation.explanation,
              knownLimitation,
            };
          }
        }, true);
        if (trashed === undefined) continue;
      }
    }
    const input = await prepareScenarioInput(
      session,
      path,
      scenario,
      'cleanup-showcase',
      { id: entity.id },
      record,
      () => ({ id: numericId(entity.id) }),
      true,
    );
    if (input === undefined) continue;
    const outcome = await record(session, path, scenario, 'cleanup-showcase', input, async () => ({
      response: await callWrite(session, site, scenario.id, input, path),
      expected: { removed: entity.id },
    }), true);
    if (outcome !== undefined) {
      const getScenario = liveScenarioCatalog().find((candidate) => candidate.id === `${baseId}.get`);
      const verified = getScenario !== undefined && getScenario.joomlaPaths.includes(path)
        ? await verifyDeletion(session, path, site, getScenario, entity, record, options, true)
        : true;
      if (verified) removeRetainedRecord(state, baseId, entity.id);
    }
  }
}

async function verifyDeletion(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  getScenario: LiveScenario,
  entity: LiveFixtureRecord,
  record: AttemptRecorder,
  options: LiveTestOptions,
  cleanup = false,
): Promise<boolean> {
  const request = { id: entity.id };
  const outcome = await record(session, path, getScenario, 'verify-deleted', request, async () => {
    const input = { id: numericId(entity.id) };
    try {
      const response = await callRead(session, site, getScenario.id, input, path);
      const found = firstEntity(response);
      const state = found?.attributes['state'] ?? found?.attributes['published'];
      if (found !== undefined && state !== -2 && state !== '-2') {
        throw new Error(`Deleted candidate ${entity.id} remains readable and is not in Joomla trash state.`);
      }
      return {
        response,
        expected: { absentOrTrashState: -2 },
        actual: found === undefined ? { absent: true } : found.attributes,
      };
    } catch (error) {
      if (error instanceof LiveMcpToolError && /(?:404|not found|does not exist)/iu.test(error.message)) {
        return { expected: { absent: true }, actual: { denied: error.message } };
      }
      const knownLimitation = verifiedDeletionLimitation({
        options,
        joomlaPath: path,
        scenarioId: getScenario.id,
        phase: 'verify-deleted',
        error: errorMessage(error),
      });
      if (knownLimitation !== undefined) {
        const listAction = getScenario.id.replace(/\.get$/u, '.list');
        const verification = await callRead(
          session,
          site,
          listAction,
          { offset: 0, limit: 100 },
          path,
        );
        const found = collectEntities(verification).find((candidate) =>
          looselyEqual(candidate.id, entity.id));
        const state = found?.attributes['state'] ?? found?.attributes['published'];
        if (found !== undefined && state !== -2 && state !== '-2') {
          throw new Error(
            `${getScenario.id} returned its reviewed post-delete error, but ${entity.id} remains in the active collection.`,
          );
        }
        return {
          status: 'KNOWN_UPSTREAM_LIMITATION',
          response: { upstreamError: errorResult(error), collectionVerification: verification },
          expected: { absentOrTrashState: -2 },
          actual: found === undefined ? { absent: true } : found.attributes,
          reason: knownLimitation.explanation,
          knownLimitation,
        };
      }
      throw error;
    }
  }, cleanup);
  return outcome !== undefined;
}

async function prepareScenarioInput(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  scenario: LiveScenario,
  phase: string,
  requestHint: unknown,
  record: AttemptRecorder,
  prepare: () => Readonly<Record<string, unknown>> | BlockedError,
  cleanup = false,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const input = prepare();
    if (input instanceof BlockedError) {
      await record(session, path, scenario, phase, requestHint, async () => { throw input; }, cleanup);
      return undefined;
    }
    return input;
  } catch (error) {
    await record(session, path, scenario, phase, requestHint, async () => { throw error; }, cleanup);
    return undefined;
  }
}

async function callRead(
  session: LiveMcpSession,
  site: string,
  action: string,
  input: Readonly<Record<string, unknown>>,
  path: LiveJoomlaPath,
): Promise<unknown> {
  return session.call({
    name: 'joomla_action_read',
    arguments: { site, action, input, transport: path },
  });
}

async function callWrite(
  session: LiveMcpSession,
  site: string,
  action: string,
  input: Readonly<Record<string, unknown>>,
  path: LiveJoomlaPath,
): Promise<unknown> {
  const dryRunRequest = {
    site,
    action,
    input,
    transport: path,
    idempotencyKey: randomUUID(),
    dryRun: true,
  };
  const preview = await session.call({ name: 'joomla_action_write_plan', arguments: dryRunRequest });
  const executable = asRecord(await session.call({
    name: 'joomla_action_write_plan',
    arguments: { ...dryRunRequest, idempotencyKey: randomUUID(), dryRun: false },
  }));
  const confirmationToken = executable['confirmationToken'];
  if (typeof confirmationToken !== 'string') {
    throw new Error(`Executable plan for ${action} returned no confirmation token.`);
  }
  const applied = await session.call({
    name: 'joomla_write_apply',
    arguments: { confirmationToken },
  });
  return { preview, plan: executable, applied };
}

function readInput(actionId: string, state: LaneState): Readonly<Record<string, unknown>> | BlockedError {
  if ([
    'configuration.application.get',
    'configuration.get_safe',
    'site.state.get',
    'system.info',
    'core.update.status',
  ].includes(actionId)) return {};
  if (actionId === 'media.directory.list') return { path: 'local-images:', offset: 0, limit: 20 };
  if ([
    'menus.administrator-item-types.list',
    'menus.site-item-types.list',
    'modules.administrator-types.list',
    'modules.site-types.list',
  ].includes(actionId)) return {};
  if (actionId.endsWith('.list')) {
    if (actionId.startsWith('languages.overrides.')) return { language: 'en-GB', offset: 0, limit: 20 };
    if (actionId.includes('-history.')) {
      const base = historyBase(actionId);
      const record = base === undefined ? undefined : state.records.get(base);
      return record === undefined
        ? new BlockedError(`${actionId} requires a created ${base ?? 'content'} record.`, base === undefined ? [] : [`${base}.create`])
        : { id: numericId(record.id), offset: 0, limit: 20 };
    }
    return { offset: 0, limit: 20 };
  }
  if (actionId.endsWith('.get')) {
    const baseId = actionId.slice(0, -'.get'.length);
    const record = state.records.get(baseId) ?? state.references.get(baseId);
    if (record !== undefined) return { id: numericId(record.id) };
    if (actionId === 'media.adapters.get') {
      const adapter = firstEntity(state.reads.get('media.adapters.list'));
      const id = adapter?.id;
      return id === undefined
        ? new BlockedError('No media adapter was returned by media.adapters.list.', ['media.adapters.list'])
        : { adapter: String(id) };
    }
    if (actionId === 'media.files.get') {
      return { path: fixtureMediaPath };
    }
    if (actionId === 'plugins.plugins.get') {
      return idFromRead(state, 'plugins.plugins.list');
    }
    if (actionId === 'privacy.requests.get') {
      return idFromMatchingRead(state, 'privacy.requests.list', 'email', fixturePrivacyEmail);
    }
    if (actionId === 'privacy.consents.get') {
      return idFromMatchingRead(
        state,
        'privacy.consents.list',
        'subject',
        fixturePrivacyConsentSubject,
      );
    }
    if (actionId.startsWith('languages.overrides.')) {
      const fixture = actionId.startsWith('languages.overrides.site.')
        ? fixtureSiteOverride
        : fixtureAdministratorOverride;
      return { language: fixture.language, constant: fixture.constant };
    }
    return new BlockedError(`${actionId} requires an existing catalogue record.`, [`${baseId}.list`]);
  }
  if (actionId === 'privacy.requests.export') {
    return idFromMatchingRead(
      state,
      'privacy.requests.list',
      'email',
      fixturePrivacyEmail,
    );
  }
  if (actionId.endsWith('.export')) return idFromRead(state, actionId.replace('.export', '.list'));
  if (actionId === 'joomla-update.healthcheck' || actionId === 'joomla-update.status') return {};
  return {};
}

function validateReadResult(
  actionId: string,
  input: Readonly<Record<string, unknown>>,
  response: unknown,
): void {
  if (actionId === 'media.files.get') {
    const expectedPath = String(input['path'] ?? '');
    const actualPath = findDeepValue(response, 'path');
    if (
      typeof actualPath !== 'string' ||
      normalizeCreatedMediaPath(actualPath) !== normalizeCreatedMediaPath(expectedPath)
    ) {
      throw new Error(`media.files.get did not return prerequisite media path ${expectedPath}.`);
    }
  }

  if (actionId === 'privacy.requests.get' || actionId === 'privacy.consents.get') {
    const entity = firstEntity(response);
    assertEntityId(entity, Number(input['id']), actionId);
    const attribute = actionId === 'privacy.requests.get' ? 'email' : 'subject';
    const expected = actionId === 'privacy.requests.get'
      ? fixturePrivacyEmail
      : fixturePrivacyConsentSubject;
    if (!looselyEqual(entity?.attributes[attribute], expected)) {
      throw new Error(`${actionId} did not return the deterministic fixture ${attribute}.`);
    }
  }

  if (
    actionId === 'languages.overrides.site.get' ||
    actionId === 'languages.overrides.administrator.get'
  ) {
    const fixture = actionId === 'languages.overrides.site.get'
      ? fixtureSiteOverride
      : fixtureAdministratorOverride;
    assertLanguageOverride(response, fixture.constant, fixture.value, actionId);
  }

  if (actionId === 'joomla-update.healthcheck') {
    const version = findDeepValue(response, 'cms_version');
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error('Joomla Update healthcheck did not return cms_version.');
    }
  }

  if (actionId === 'joomla-update.status') {
    const availableUpdate = findDeepValue(response, 'availableUpdate');
    if (typeof availableUpdate !== 'string' || availableUpdate.length === 0) {
      throw new Error('Joomla Update status did not return a concrete availableUpdate.');
    }
  }
}

function requiredJoomlaUpdateVersion(state: LaneState): string {
  const version = findDeepValue(state.reads.get('joomla-update.status'), 'availableUpdate');
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Joomla Update prepare requires the version returned by joomla-update.status.');
  }
  return version;
}

function requiredCurrentJoomlaVersion(state: LaneState): string {
  const healthcheckVersion = findDeepValue(
    state.reads.get('joomla-update.healthcheck'),
    'cms_version',
  );
  if (typeof healthcheckVersion === 'string' && healthcheckVersion.length > 0) {
    return healthcheckVersion;
  }
  const systemVersion = findDeepValue(state.reads.get('system.info'), 'joomlaVersion');
  if (typeof systemVersion === 'string' && systemVersion.length > 0) return systemVersion;
  throw new Error(
    'Joomla Update actions require the current Joomla version returned by healthcheck or system.info.',
  );
}

function requiredJoomlaUpdateFile(state: LaneState): string {
  const filename = state.reads.get('live.joomla-update.filename');
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('Joomla Update finalize requires the filename returned by joomla-update.prepare.');
  }
  return filename;
}

function specialWriteInput(
  actionId: string,
  state: LaneState,
  seed: string,
): Readonly<Record<string, unknown>> | BlockedError {
  const safeSeed = safeSegment(seed).toUpperCase().replaceAll('-', '_').slice(0, 24);
  if (actionId.includes('-history.')) {
    const readId = actionId.replace(/\.(?:keep|delete)$/u, '.list');
    return idFromRead(state, readId);
  }
  if (actionId === 'contacts.form.submit') {
    const contact = state.records.get('contacts.contacts');
    return contact === undefined
      ? new BlockedError('Contact form submission requires a created contact.', ['contacts.contacts.create'])
      : {
          id: numericId(contact.id),
          data: {
            contact_name: 'Joomla MCP live test',
            contact_email: `live-${safeSegment(seed)}@example.invalid`,
            contact_subject: `Joomla MCP live ${seed}`,
            contact_message: `Disposable live validation message for ${seed}.`,
            contact_email_copy: false,
          },
        };
  }
  if (actionId === 'media.files.create') {
    const directory = `joomla-mcp-live-${safeSegment(seed)}-${safeSegment(state.lane)}`;
    return {
      data: {
        path: `local-images:${directory}/fixture.png`,
        content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        override: false,
      },
    };
  }
  if (actionId === 'media.files.update') {
    const path = state.reads.get('live.media.path');
    return typeof path !== 'string'
      ? new BlockedError('Media update requires a successful media.files.create.', ['media.files.create'])
      : {
          path: mediaUpdateRoutePath(path),
          data: {
            path: mediaAdapterSelector(path),
            content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
            override: true,
          },
        };
  }
  if (actionId === 'media.files.delete') {
    const path = state.reads.get('live.media.path');
    return typeof path !== 'string'
      ? new BlockedError('Media delete requires a successful media.files.create.', ['media.files.create'])
      : { path };
  }
  if (actionId === 'configuration.application.update') {
    return { data: { sitename: `Joomla MCP Live ${seed}` } };
  }
  if (actionId === 'plugins.plugins.update') {
    const plugin = toggleCandidate(state.reads.get('plugins.plugins.list'));
    if (plugin === undefined) return new BlockedError('Plugin update requires plugins.plugins.list.', ['plugins.plugins.list']);
    const enabled = Number(plugin.attributes['enabled'] ?? 1);
    return { id: numericId(plugin.id), data: { enabled: enabled === 1 ? 0 : 1 } };
  }
  if (actionId === 'privacy.requests.create') {
    return {
      data: {
        email: `privacy-${safeSegment(seed)}-${safeSegment(state.lane)}@example.invalid`,
        request_type: 'export',
      },
    };
  }
  if (actionId === 'languages.overrides.site.create' || actionId === 'languages.overrides.administrator.create') {
    const lane = safeSegment(state.lane).toUpperCase().replaceAll('-', '_');
    const constant = `JOOMLA_MCP_LIVE_${safeSeed}_${lane}`;
    return {
      language: 'en-GB',
      data: { id: '', key: constant, override: `Joomla MCP live ${seed}`, both: false },
    };
  }
  if (actionId === 'languages.overrides.site.delete' || actionId === 'languages.overrides.administrator.delete') {
    const lane = safeSegment(state.lane).toUpperCase().replaceAll('-', '_');
    return { language: 'en-GB', constant: `JOOMLA_MCP_LIVE_${safeSeed}_${lane}` };
  }
  if (actionId === 'languages.overrides.search') {
    const lane = safeSegment(state.lane).toUpperCase().replaceAll('-', '_');
    return { data: { searchstring: `JOOMLA_MCP_LIVE_${safeSeed}_${lane}`, searchtype: 'constant' } };
  }
  if (actionId === 'languages.overrides.refresh') return {};
  if (actionId === 'joomla-update.prepare') {
    return { data: { targetVersion: requiredJoomlaUpdateVersion(state) } };
  }
  if (actionId === 'joomla-update.finalize') {
    return {
      data: {
        fromVersion: requiredCurrentJoomlaVersion(state),
        updateFileName: requiredJoomlaUpdateFile(state),
      },
    };
  }
  if (actionId.startsWith('joomla-update.notification.')) {
    return {
      data: {
        fromVersion: requiredCurrentJoomlaVersion(state),
        toVersion: requiredJoomlaUpdateVersion(state),
      },
    };
  }
  if (actionId === 'cache.clean') return { groups: ['_system'] };
  if (['cache.expired.purge', 'extensions.discovered.refresh', 'extensions.updates.refresh', 'sessions.metadata.gc'].includes(actionId)) return {};
  if (actionId === 'site.state.set') return { offline: true };
  if (actionId === 'sessions.data.gc') return { application: 'site' };
  if (actionId === 'extensions.state.set') {
    const extension = toggleCandidate(state.reads.get('extensions.list'));
    if (extension === undefined) return new BlockedError('extensions.list did not return a usable item.', ['extensions.list']);
    const enabled = Number(extension.attributes['enabled'] ?? 1);
    return { id: numericId(extension.id), enabled: enabled !== 1 };
  }
  if (actionId === 'extensions.update-sites.state.set') {
    const updateSite = firstEntity(state.reads.get('extensions.update-sites.list'));
    if (updateSite === undefined) {
      return new BlockedError('extensions.update-sites.list did not return a usable item.', ['extensions.update-sites.list']);
    }
    const enabled = Number(updateSite.attributes['enabled'] ?? 1);
    return { id: numericId(updateSite.id), enabled: enabled !== 1 };
  }
  if (actionId === 'scheduler.tasks.state.set') {
    const task = firstEntity(state.reads.get('scheduler.tasks.list'));
    if (task === undefined) return new BlockedError('scheduler.tasks.list did not return a usable item.', ['scheduler.tasks.list']);
    const current = Number(task.attributes['state'] ?? 1);
    return { id: numericId(task.id), state: current === 1 ? 0 : 1 };
  }
  if (actionId === 'scheduler.tasks.run') {
    return firstCompanionId(state, 'scheduler.tasks.list');
  }
  if (actionId.endsWith('.state')) {
    const baseId = actionId.slice(0, -'.state'.length);
    const entity = state.records.get(baseId);
    return entity === undefined
      ? new BlockedError(`${actionId} requires a created ${baseId} record.`, [`${baseId}.create`])
      : { id: numericId(entity.id), state: 0 };
  }
  return new BlockedError(`No deterministic live fixture is defined for special write ${actionId}.`);
}

function rememberSpecialWrite(
  actionId: string,
  input: Readonly<Record<string, unknown>>,
  response: unknown,
  state: LaneState,
): void {
  if (actionId === 'media.files.create') {
    const data = asRecord(input['data']);
    const responsePath = findDeepValue(asRecord(response)['applied'] ?? response, 'path');
    const mediaPath = typeof responsePath === 'string'
      ? normalizeCreatedMediaPath(responsePath)
      : data['path'];
    if (typeof mediaPath === 'string') {
      const directoryPath = mediaDirectoryPath(mediaPath);
      state.reads.set('live.media.path', mediaPath);
      state.reads.set('live.media.directory', directoryPath);
      state.created.push({
        lane: state.lane,
        family: 'media.files',
        id: mediaPath,
        label: `Live-test media ${mediaPath}`,
      });
      state.created.push({
        lane: state.lane,
        family: 'media.directories',
        id: directoryPath,
        label: `Live-test media directory ${directoryPath}`,
      });
    }
  }
  if (actionId === 'media.files.delete' && typeof input['path'] === 'string') {
    removeRetainedRecord(state, 'media.files', input['path']);
    const directoryPath = state.reads.get('live.media.directory');
    if (typeof directoryPath === 'string') {
      removeRetainedRecord(state, 'media.directories', directoryPath);
      state.reads.delete('live.media.directory');
    }
    state.reads.delete('live.media.path');
  }
  if (
    actionId === 'languages.overrides.site.create' ||
    actionId === 'languages.overrides.administrator.create'
  ) {
    const constant = asRecord(input['data'])['key'];
    if (typeof constant === 'string') {
      state.created.push({
        lane: state.lane,
        family: actionId.startsWith('languages.overrides.site')
          ? 'languages.overrides.site'
          : 'languages.overrides.administrator',
        id: constant,
        label: `${String(input['language'])} ${constant}`,
      });
    }
  }
  if (
    (actionId === 'languages.overrides.site.delete' ||
      actionId === 'languages.overrides.administrator.delete') &&
    typeof input['constant'] === 'string'
  ) {
    removeRetainedRecord(
      state,
      actionId.startsWith('languages.overrides.site')
        ? 'languages.overrides.site'
        : 'languages.overrides.administrator',
      input['constant'],
    );
  }
  if (actionId === 'privacy.requests.create') state.reads.set('privacy.requests.create', response);
  if (actionId === 'joomla-update.prepare') {
    const filename = findDeepValue(response, 'filename');
    if (typeof filename === 'string' && filename.length > 0) {
      state.reads.set('live.joomla-update.filename', filename);
    }
  }
  if (actionId === 'privacy.requests.create') {
    const entity = firstEntity(response);
    if (entity !== undefined) {
      state.created.push({
        lane: state.lane,
        family: 'privacy.requests',
        id: entity.id,
        label: `Privacy request generated by live test ${state.lane}`,
      });
    }
  }
}

async function executeSpecialWrite(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  scenario: LiveScenario,
  input: Readonly<Record<string, unknown>>,
  state: LaneState,
  seed: string,
): Promise<unknown> {
  let directoryCreation: unknown;
  if (scenario.id === 'media.files.create') {
    const filePath = asRecord(input['data'])['path'];
    if (typeof filePath !== 'string') {
      throw new Error('Media fixture creation requires a deterministic file path.');
    }
    const directoryPath = mediaDirectoryPath(filePath);
    directoryCreation = await callWrite(
      session,
      site,
      scenario.id,
      { data: { path: directoryPath, override: false } },
      path,
    );
    try {
      const applied = await callWrite(session, site, scenario.id, input, path);
      const verification = await callRead(
        session,
        site,
        'media.files.get',
        { path: filePath },
        path,
      );
      return { applied, directoryCreation, verification };
    } catch (error) {
      try {
        await callWrite(
          session,
          site,
          'media.files.delete',
          { path: directoryPath },
          path,
        );
      } catch {
        // Preserve the file-creation failure as the primary diagnostic.
      }
      throw error;
    }
  }

  const applied = await callWrite(session, site, scenario.id, input, path);

  if (scenario.id === 'joomla-update.prepare') {
    const filename = findDeepValue(applied, 'filename');
    const filesize = Number(findDeepValue(applied, 'filesize'));
    if (typeof filename !== 'string' || filename.length === 0 || !Number.isFinite(filesize) || filesize < 1) {
      throw new Error('Joomla Update prepare did not return a non-empty filename and positive file size.');
    }
    return applied;
  }

  if (
    scenario.id === 'joomla-update.finalize' ||
    scenario.id === 'joomla-update.notification.failed' ||
    scenario.id === 'joomla-update.notification.success'
  ) {
    const success = findDeepValue(applied, 'success');
    if (success !== true && success !== 1 && success !== '1') {
      throw new Error(
        `${scenario.id} returned success=${String(success)}: ${JSON.stringify(findDeepValue(applied, 'errors') ?? [])}`,
      );
    }
    return applied;
  }

  if (scenario.id === 'configuration.application.update') {
    const verification = await callRead(session, site, 'configuration.application.get', {}, path);
    const current = findDeepValue(state.reads.get('configuration.application.get'), 'sitename');
    if (typeof current !== 'string' || current.length === 0) {
      throw new Error('Application configuration read did not expose the original safe sitename for restoration.');
    }
    const restored = await callWrite(
      session,
      site,
      scenario.id,
      { data: { sitename: current } },
      path,
    );
    return { applied, verification, restoration: restored };
  }

  if (scenario.id.endsWith('-history.keep')) {
    const restored = await callWrite(session, site, scenario.id, input, path);
    return { applied, restoration: restored };
  }

  if (scenario.id === 'plugins.plugins.update') {
    const plugin = toggleCandidate(state.reads.get('plugins.plugins.list'));
    if (plugin === undefined) throw new Error('Plugin state disappeared before restoration.');
    const verification = await callRead(
      session,
      site,
      'plugins.plugins.get',
      { id: numericId(plugin.id) },
      path,
    );
    const originalEnabled = Number(plugin.attributes['enabled'] ?? 1);
    const restored = await callWrite(
      session,
      site,
      scenario.id,
      { id: numericId(plugin.id), data: { enabled: originalEnabled === 1 ? 1 : 0 } },
      path,
    );
    return { applied, verification, restoration: restored };
  }

  if (scenario.id === 'site.state.set') {
    const verification = await callRead(session, site, 'site.state.get', {}, path);
    const restored = await callWrite(session, site, scenario.id, { offline: false }, path);
    return { applied, verification, restoration: restored };
  }

  if (scenario.id === 'extensions.state.set') {
    return restoreBooleanCompanionState(
      session, path, site, scenario.id, input, applied,
      toggleCandidate(state.reads.get('extensions.list'))?.attributes['enabled'],
    );
  }
  if (scenario.id === 'extensions.update-sites.state.set') {
    return restoreBooleanCompanionState(
      session, path, site, scenario.id, input, applied,
      firstEntity(state.reads.get('extensions.update-sites.list'))?.attributes['enabled'],
    );
  }
  if (scenario.id === 'scheduler.tasks.state.set') {
    const current = firstEntity(state.reads.get('scheduler.tasks.list'))?.attributes['state'];
    const restored = await callWrite(session, site, scenario.id, {
      id: input['id'],
      state: Number(current ?? 1),
    }, path);
    return { applied, restoration: restored };
  }
  if (scenario.id.endsWith('.state')) {
    const baseId = scenario.id.slice(0, -'.state'.length);
    const entity = state.records.get(baseId);
    if (entity === undefined) throw new Error(`State restoration lost fixture ${baseId}.`);
    const readAction = `${baseId}.get`;
    const verification = await callRead(
      session,
      site,
      readAction,
      { id: numericId(entity.id) },
      path,
    );
    const originalState = Number(entity.attributes['state'] ?? entity.attributes['published'] ?? 1);
    const restored = await callWrite(session, site, scenario.id, {
      id: numericId(entity.id),
      state: originalState,
    }, path);
    return { applied, verification, restoration: restored };
  }
  if (scenario.id === 'media.files.update') {
    const canonicalPath = state.reads.get('live.media.path');
    const verification = typeof canonicalPath === 'string'
      ? await callRead(session, site, 'media.files.get', { path: canonicalPath }, path)
      : undefined;
    return { applied, verification };
  }
  if (scenario.id === 'media.files.delete') {
    await assertMediaAbsent(session, site, input['path'], path);
    const directoryPath = state.reads.get('live.media.directory');
    let directoryDeletion: unknown;
    if (typeof directoryPath === 'string') {
      directoryDeletion = await callWrite(
        session,
        site,
        scenario.id,
        { path: directoryPath },
        path,
      );
      await assertMediaAbsent(session, site, directoryPath, path);
    }
    return {
      applied,
      ...(directoryDeletion === undefined ? {} : { directoryDeletion }),
      verification: { absent: true, directoryAbsent: directoryDeletion !== undefined },
    };
  }

  void seed;
  return applied;
}

async function restoreBooleanCompanionState(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  action: string,
  input: Readonly<Record<string, unknown>>,
  applied: unknown,
  original: unknown,
): Promise<unknown> {
  const restored = await callWrite(session, site, action, {
    id: input['id'],
    enabled: Number(original ?? 1) === 1,
  }, path);
  return { applied, restoration: restored };
}

async function addExpectedDenial(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  scenario: LiveScenario,
  phase: string,
  reason: string,
  record: AttemptRecorder,
): Promise<void> {
  await record(session, path, scenario, phase, {}, async () => ({
    status: 'EXPECTED_DENIAL',
    reason,
    expected: 'No mutation is dispatched without an explicitly disposable target.',
  }));
}

function rememberReference(actionId: string, response: unknown, state: LaneState): void {
  if (!actionId.endsWith('.list')) return;
  const baseId = actionId.slice(0, -'.list'.length);
  const entity = firstEntity(response);
  if (entity !== undefined) state.references.set(baseId, entity);
}

function removeRetainedRecord(state: LaneState, family: string, id: string | number): void {
  const index = state.created.findIndex((candidate) =>
    candidate.family === family && String(candidate.id) === String(id));
  if (index >= 0) state.created.splice(index, 1);
}

function idFromRead(state: LaneState, readAction: string): Readonly<Record<string, unknown>> | BlockedError {
  const entity = firstEntity(state.reads.get(readAction));
  return entity === undefined
    ? new BlockedError(`${readAction} did not return a usable item.`, [readAction])
    : { id: numericId(entity.id) };
}

function idFromMatchingRead(
  state: LaneState,
  readAction: string,
  attribute: string,
  expected: string,
): Readonly<Record<string, unknown>> | BlockedError {
  const entity = collectEntities(state.reads.get(readAction)).find((candidate) =>
    looselyEqual(candidate.attributes[attribute], expected));
  return entity === undefined
    ? new BlockedError(
        `${readAction} did not return the fixture record with ${attribute}=${expected}.`,
        [readAction],
      )
    : { id: numericId(entity.id) };
}

function firstCompanionId(
  state: LaneState,
  readAction: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> | BlockedError {
  const entity = firstEntity(state.reads.get(readAction));
  return entity === undefined
    ? new BlockedError(`${readAction} did not return a usable item.`, [readAction])
    : { id: numericId(entity.id), ...extra };
}

function historyBase(actionId: string): string | undefined {
  if (actionId.startsWith('content.article-history.')) return 'content.articles';
  if (actionId.startsWith('contacts.contact-history.')) return 'contacts.contacts';
  if (actionId.startsWith('banners.banner-history.')) return 'banners.banners';
  return undefined;
}

function firstEntity(value: unknown): LiveFixtureRecord | undefined {
  const candidate = findEntity(value);
  if (candidate === undefined) return undefined;
  const id = candidate['id'] ?? candidate['lang_id'] ?? candidate['message_id'] ??
    candidate['update_site_id'] ?? candidate['updateSiteId'] ??
    candidate['extension_id'] ?? candidate['extensionId'];
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const attributes = resourceAttributes(candidate);
  const labelValue = attributes['title'] ?? attributes['name'] ?? attributes['subject'] ?? attributes['username'] ?? id;
  return Object.freeze({ id, attributes: Object.freeze(attributes), label: String(labelValue) });
}

function toggleCandidate(value: unknown): LiveFixtureRecord | undefined {
  return collectEntities(value).find((entity) =>
    Number(entity.attributes['enabled'] ?? entity.attributes['state'] ?? 1) === 0 &&
    !/token|authentication|joomla.?mcp/iu.test(String(
      entity.attributes['element'] ?? entity.attributes['name'] ?? entity.label,
    )));
}

function collectEntities(value: unknown): readonly LiveFixtureRecord[] {
  const output: LiveFixtureRecord[] = [];
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 12) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    const record = asRecord(candidate);
    const id = record['id'] ?? record['lang_id'] ?? record['message_id'] ??
      record['update_site_id'] ?? record['updateSiteId'] ??
      record['extension_id'] ?? record['extensionId'];
    if ((typeof id === 'string' || typeof id === 'number') && isResourceEntityRecord(record)) {
      const attributes = resourceAttributes(record);
      output.push({
        id,
        attributes,
        label: String(attributes['title'] ?? attributes['name'] ?? attributes['element'] ?? id),
      });
      return;
    }
    for (const key of ['applied', 'verification', 'mutation', 'result', 'data', 'item', 'items', 'records']) {
      if (record[key] !== undefined) visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
  return output;
}

function findEntity(value: unknown, depth = 0): Readonly<Record<string, unknown>> | undefined {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findEntity(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (
    (typeof record['id'] === 'string' || typeof record['id'] === 'number' ||
      typeof record['lang_id'] === 'number' || typeof record['message_id'] === 'number' ||
      typeof record['update_site_id'] === 'number' || typeof record['update_site_id'] === 'string' ||
      typeof record['updateSiteId'] === 'number' || typeof record['updateSiteId'] === 'string' ||
      typeof record['extension_id'] === 'number' || typeof record['extension_id'] === 'string' ||
      typeof record['extensionId'] === 'number' || typeof record['extensionId'] === 'string') &&
    isResourceEntityRecord(record)
  ) {
    return record;
  }
  for (const key of ['applied', 'verification', 'mutation', 'result', 'data', 'item', 'items', 'records', 'commands']) {
    if (record[key] !== undefined) {
      const found = findEntity(record[key], depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function entityFromMutation(
  response: unknown,
  submitted: Readonly<Record<string, unknown>>,
): LiveFixtureRecord | undefined {
  const entity = firstEntity(response);
  if (entity === undefined) return undefined;
  return Object.freeze({
    id: entity.id,
    attributes: Object.freeze({ ...submitted, ...entity.attributes }),
    label: String(
      entity.attributes['title'] ??
      entity.attributes['name'] ??
      entity.attributes['subject'] ??
      submitted['title'] ??
      submitted['name'] ??
      submitted['subject'] ??
      entity.id,
    ),
  });
}

function isResourceEntityRecord(record: Readonly<Record<string, unknown>>): boolean {
  return !('idempotencyKey' in record) &&
    record['protocol'] !== 'joomla-mcp/1' &&
    record['schema'] !== 'joomengine.joomla-mcp.live-test/v1';
}

function assertEntityId(
  entity: LiveFixtureRecord | undefined,
  expected: string | number,
  action: string,
): void {
  if (entity === undefined || String(entity.id) !== String(expected)) {
    throw new Error(`${action} returned resource ${String(entity?.id ?? 'none')}; expected ${String(expected)}.`);
  }
}

function assertLanguageOverride(
  response: unknown,
  expectedConstant: string,
  expectedValue: string,
  action: string,
): void {
  const entity = firstEntity(response);
  if (
    entity === undefined ||
    String(entity.id) !== expectedConstant ||
    String(entity.attributes['value'] ?? '') !== expectedValue
  ) {
    throw new Error(
      `${action} did not return language override ${expectedConstant} with the submitted value.`,
    );
  }
}

function assertChangedFields(
  response: unknown,
  changes: Readonly<Record<string, unknown>>,
  baseId: string,
): Readonly<Record<string, unknown>> {
  const attributes = firstEntity(response)?.attributes ?? {};
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(changes)) {
    if (key === 'password' || key === 'password2') continue;
    if (
      baseId === 'content.articles' &&
      (key === 'introtext' || key === 'fulltext' || key === 'articletext') &&
      typeof attributes['text'] === 'string'
    ) {
      const actualText = normalizeComparableText(attributes['text']);
      const expectedText = normalizeComparableText(expected);
      const matched = key === 'introtext'
        ? actualText.startsWith(expectedText)
        : key === 'fulltext'
          ? actualText.endsWith(expectedText)
          : actualText === expectedText;
      if (!matched) mismatches.push(fieldMismatch(key, expected, attributes['text']));
      continue;
    }
    if (!Object.hasOwn(attributes, key)) continue;
    if (!looselyEqual(attributes[key], expected)) {
      mismatches.push(fieldMismatch(key, expected, attributes[key]));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Persisted ${baseId} field mismatch: ${mismatches.slice(0, 8).join('; ')}.`,
    );
  }
  return attributes;
}

function entityMatchesFields(
  entity: LiveFixtureRecord,
  changes: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(changes)
    .filter(([key]) => key !== 'password' && key !== 'password2')
    .every(([key, value]) => looselyEqual(entity.attributes[key], value));
}

function selectAttributes(
  attributes: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    fields
      .filter((field) => attributes[field] !== undefined)
      .map((field) => [field, attributes[field]]),
  );
}

export function normalizeCreatedMediaPath(path: string): string {
  return path.replace(/^([A-Za-z0-9][A-Za-z0-9._-]*):\/\.\/(?=.)/u, '$1:/');
}

export function mediaUpdateRoutePath(path: string): string {
  const separator = path.indexOf(':');
  const relative = separator < 0 ? path : path.slice(separator + 1);
  return relative.replace(/^\/+/u, '');
}

export function mediaAdapterSelector(path: string): string {
  const separator = path.indexOf(':');
  if (separator <= 0) {
    throw new Error(`Media fixture path must identify its adapter: ${path}`);
  }
  return `${path.slice(0, separator)}:`;
}

export function mediaDirectoryPath(path: string): string {
  const separator = path.indexOf(':');
  const prefix = separator < 0 ? '' : path.slice(0, separator + 1);
  const relative = (separator < 0 ? path : path.slice(separator + 1)).replace(/^\/+/u, '');
  const directory = relative.slice(0, Math.max(0, relative.lastIndexOf('/')));
  if (directory.length === 0) {
    throw new Error(`Media fixture path must include a directory: ${path}`);
  }
  return `${prefix}${directory}`;
}

async function assertMediaAbsent(
  session: LiveMcpSession,
  site: string,
  mediaPath: unknown,
  path: LiveJoomlaPath,
): Promise<void> {
  try {
    await callRead(session, site, 'media.files.get', { path: mediaPath }, path);
    throw new Error(`Deleted media path ${String(mediaPath)} remains readable.`);
  } catch (error) {
    if (!(error instanceof LiveMcpToolError) || !/(?:404|not found|does not exist)/iu.test(error.message)) {
      throw error;
    }
  }
}

function looselyEqual(actual: unknown, expected: unknown): boolean {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
  if (Array.isArray(expected)) {
    const actualValues = Array.isArray(actual)
      ? actual
      : isPlainRecord(actual)
        ? Object.values(actual)
        : [];
    return JSON.stringify(actualValues.map(String).sort()) ===
      JSON.stringify(expected.map(String).sort());
  }
  if (isPlainRecord(expected)) {
    const decoded = typeof actual === 'string' ? parseJsonRecord(actual) : actual;
    if (!isPlainRecord(decoded)) return false;
    return Object.entries(expected).every(([key, value]) =>
      Object.hasOwn(decoded, key) && looselyEqual(decoded[key], value));
  }
  if (typeof expected === 'number' || typeof expected === 'boolean') return String(actual) === String(Number(expected));
  return String(actual ?? '') === String(expected ?? '');
}

function resourceAttributes(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const attributesValue = asRecord(record['attributes']);
  const attributes: Record<string, unknown> = Object.keys(attributesValue).length > 0
    ? { ...attributesValue }
    : Object.fromEntries(
        Object.entries(record).filter(([key]) =>
          key !== 'id' && key !== 'relationships'),
      );
  const relationships = asRecord(record['relationships']);
  const relationFields: Readonly<Record<string, string>> = {
    category: 'catid',
    client: 'cid',
  };
  for (const [name, relationship] of Object.entries(relationships)) {
    const field = relationFields[name];
    if (field === undefined || Object.hasOwn(attributes, field)) continue;
    const data = asRecord(relationship)['data'];
    if (Array.isArray(data)) {
      attributes[field] = data
        .map((entry) => asRecord(entry)['id'])
        .filter((id) => typeof id === 'string' || typeof id === 'number');
    } else {
      const id = asRecord(data)['id'];
      if (typeof id === 'string' || typeof id === 'number') attributes[field] = id;
    }
  }
  return Object.freeze(attributes);
}

function normalizeComparableText(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function fieldMismatch(key: string, expected: unknown, actual: unknown): string {
  return `${key} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function validateSelection(options: LiveTestOptions, site: SiteConfig): void {
  if (options.joomlaPaths.length === 0 || options.mcpTransports.length === 0) {
    throw new Error('At least one Joomla path and one MCP transport are required.');
  }
  if (options.joomlaPaths.includes('api') && site.api === undefined) {
    throw new Error(`Site ${site.id} does not configure the Joomla API path.`);
  }
  if (options.joomlaPaths.includes('cli') && site.cli === undefined) {
    throw new Error(`Site ${site.id} does not configure the companion CLI path.`);
  }
  if (options.nonInteractive && isMutatingProfile(options.profile) && !options.confirmMutations) {
    throw new Error('Non-interactive mutation profiles require --confirm-mutations.');
  }
  if (options.profile === 'full' && options.nonInteractive && !options.disposable) {
    throw new Error('The non-interactive full profile requires --disposable.');
  }
}

function isRead(scenario: LiveScenario): boolean {
  return scenario.risk === 'read' || scenario.risk === 'sensitive-read';
}

function isMutatingProfile(profile: LiveTestOptions['profile']): boolean {
  return profile === 'crud' || profile === 'full';
}

function targetHostname(site: SiteConfig): string {
  if (site.api !== undefined) return new URL(site.api.baseUrl).hostname;
  return operatingSystemHostname();
}

function configurationForFingerprint(
  configuration: Awaited<ReturnType<typeof loadConfiguration>>,
  siteId: string,
): unknown {
  const site = configuration.sites.get(siteId);
  return {
    defaultSite: configuration.defaultSite,
    selectedSite: siteId,
    toolsets: site === undefined ? [] : [...site.toolsets].sort(),
    api: site?.api === undefined ? false : {
      baseUrl: site.api.baseUrl,
      timeoutMs: site.api.timeoutMs,
      maxResponseBytes: site.api.maxResponseBytes,
      maxPageSize: site.api.maxPageSize,
      updateTokenConfigured: site.api.updateToken !== undefined,
    },
    cli: site?.cli === undefined ? false : {
      root: site.cli.root,
      phpBinary: site.cli.phpBinary,
      timeoutMs: site.cli.timeoutMs,
      maxOutputBytes: site.cli.maxOutputBytes,
    },
  };
}

function numericId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Expected a positive Joomla resource id; received ${String(value)}.`);
  return id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(error: unknown): unknown {
  return error instanceof LiveMcpToolError ? error.result : { message: errorMessage(error) };
}

function classifyError(error: unknown): string {
  const message = errorMessage(error);
  const http = /HTTP\s+(\d{3})/iu.exec(message)?.[1];
  if (http !== undefined) return `joomla_http_${http}`;
  if (/timeout/iu.test(message)) return 'timeout';
  if (/MCP tool/iu.test(message)) return 'mcp_tool_error';
  if (/companion/iu.test(message)) return 'companion_error';
  if (/postcondition|expected|returned resource/iu.test(message)) return 'postcondition_failed';
  return 'unexpected_error';
}

function isJoomlaHttpError(error: unknown, status: number): boolean {
  return error instanceof LiveMcpToolError &&
    new RegExp(`Joomla API returned HTTP ${status}(?:\\D|$)`, 'iu').test(error.message);
}

function findDeepValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDeepValue(entry, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record[key] !== undefined) return record[key];
  for (const entry of Object.values(record)) {
    const found = findDeepValue(entry, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-|-$/gu, '') || 'value';
}

function heartbeatSecondsFromEnvironment(fallbackSeconds: number): number {
  const configured = process.env['JOOMLA_MCP_LIVE_HEARTBEAT_MS'];
  if (configured === undefined) return fallbackSeconds;
  const milliseconds = Number(configured);
  if (!Number.isFinite(milliseconds) || milliseconds < 5_000 || milliseconds > 300_000) {
    return fallbackSeconds;
  }
  return milliseconds / 1_000;
}

function readPriority(actionId: string): number {
  if (actionId.endsWith('.list')) return 0;
  if (actionId.endsWith('.get')) return 1;
  if (actionId.endsWith('.export')) return 2;
  return 0;
}

export function specialWritePriority(actionId: string): number {
  if (actionId.endsWith('-history.keep')) return 10;
  if (actionId.endsWith('-history.delete')) return 20;
  if (actionId === 'media.files.create') return 10;
  if (actionId === 'media.files.update') return 20;
  if (actionId === 'media.files.delete') return 30;
  if (actionId === 'scheduler.tasks.state.set') return 10;
  if (actionId === 'scheduler.tasks.run') return 20;
  if (actionId === 'joomla-update.prepare') return 10;
  if (actionId.startsWith('joomla-update.notification.')) return 20;
  if (actionId === 'joomla-update.finalize') return 30;
  if (actionId.endsWith('.create')) return 10;
  if (actionId.endsWith('.update')) return 20;
  if (actionId.endsWith('.delete')) return 30;
  return 15;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
