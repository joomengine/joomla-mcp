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
  createHttpLiveSession,
  createStdioLiveSession,
  LiveMcpToolError,
} from './transports.js';
import type {
  LiveJoomlaPath,
  LiveMcpSession,
  LiveRetainedRecord,
  LiveScenario,
  LiveTestAttempt,
  LiveTestOptions,
  LiveTestStatus,
  LiveTestSummary,
} from './types.js';

interface LaneState {
  readonly lane: string;
  readonly records: Map<string, LiveFixtureRecord>;
  readonly references: Map<string, LiveFixtureRecord>;
  readonly reads: Map<string, unknown>;
  readonly created: LiveRetainedRecord[];
}

interface AttemptOutcome {
  readonly response?: unknown;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly status?: Extract<LiveTestStatus, 'PASS' | 'EXPECTED_DENIAL'>;
  readonly reason?: string;
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

export async function runLiveTest(options: LiveTestOptions): Promise<LiveTestSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = `jmcp-${startedAt.replace(/[-:.TZ]/gu, '').slice(0, 14)}-${safeSegment(options.seed).slice(0, 12)}`;
  const configuration = await loadConfiguration(options.configurationFile);
  const siteId = options.site ?? configuration.defaultSite;
  const site = configuration.sites.get(siteId);
  if (site === undefined) throw new Error(`Configured Joomla site ${siteId} does not exist.`);
  validateSelection(options, site);
  const hostname = targetHostname(site);
  const catalogue = liveScenarioCatalog();
  const selected = catalogue.filter((scenario) =>
    options.families.length === 0 ||
    options.families.includes(scenario.domain) ||
    options.families.some((family) => scenario.id.startsWith(`${family}.`)));
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
    try {
      const outcome = await execute();
      attempts.push(Object.freeze({
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
        durationMs: Date.now() - attemptStarted,
        request,
        ...(outcome.response === undefined ? {} : { response: outcome.response }),
        ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
        ...(outcome.actual === undefined ? {} : { actual: outcome.actual }),
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        reproduction: reproduction(scenario, session.kind, joomlaPath),
        ...(scenario.source === undefined ? {} : { source: scenario.source }),
        ...(cleanup ? { cleanup: true } : {}),
      }));
      latestAttemptByScenario.set(scenario.id, id);
      return outcome;
    } catch (error) {
      const blocked = error instanceof BlockedError;
      const status: LiveTestStatus = blocked
        ? 'BLOCKED_BY_PREREQUISITE'
        : cleanup
          ? 'CLEANUP_FAILED'
          : 'FAIL';
      const rootCauseId = blocked
        ? error.rootCauseId ??
          error.dependencyIds.map((dependency) => latestAttemptByScenario.get(dependency)).find((value) => value !== undefined)
        : undefined;
      attempts.push(Object.freeze({
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
        durationMs: Date.now() - attemptStarted,
        request,
        actual: errorResult(error),
        reason: errorMessage(error),
        failureCode: blocked ? 'prerequisite_unavailable' : classifyError(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        ...(blocked && error.dependencyIds.length > 0 ? { dependencyIds: error.dependencyIds } : {}),
        ...(rootCauseId === undefined ? {} : { rootCauseId }),
        reproduction: reproduction(scenario, session.kind, joomlaPath),
        ...(scenario.source === undefined ? {} : { source: scenario.source }),
        ...(cleanup ? { cleanup: true } : {}),
      }));
      latestAttemptByScenario.set(scenario.id, id);
      if (options.failFast && status !== 'BLOCKED_BY_PREREQUISITE') throw error;
      return undefined;
    }
  };

  try {
    for (const kind of options.mcpTransports) {
      activeTransport = kind;
      sessions.push(kind === 'stdio'
        ? await createStdioLiveSession({
            configurationFile: options.configurationFile,
            ...(options.stdioCommand === undefined ? {} : { command: options.stdioCommand }),
            ...(options.stdioArguments === undefined ? {} : { arguments: options.stdioArguments }),
          })
        : await createHttpLiveSession(configuration));
    }

    for (const session of sessions) {
      activeTransport = session.kind;
      await verifyDiscovery(session, siteId);
      if (isMutatingProfile(options.profile)) {
        await grantPermissions(session, siteId, selected, options);
      }
      for (const joomlaPath of options.joomlaPaths) {
        activeJoomlaPath = joomlaPath;
        const state: LaneState = {
          lane: `${session.kind}-${joomlaPath}`,
          records: new Map(),
          references: new Map(),
          reads: new Map(),
          created: [],
        };

        if (options.profile === 'read') {
          await runReadProfile(session, joomlaPath, siteId, site, selected, state, recordAttempt);
        } else {
          await runCrudProfile(session, joomlaPath, siteId, selected, state, recordAttempt, options);
          if (options.profile === 'full') {
            await runSpecialProfile(session, joomlaPath, siteId, site, selected, state, recordAttempt, options);
          }
        }

        if (options.cleanup || (options.retainDemo && state.lane !== retentionLane)) {
          await cleanupRecords(session, joomlaPath, siteId, state, recordAttempt);
          retained.push(...state.created);
        } else {
          retained.push(...state.created);
        }
      }
    }

    for (const session of sessions) {
      if (!options.joomlaPaths.includes('api')) continue;
      for (const scenario of selected.filter((candidate) => candidate.sourceOnlyReason !== undefined)) {
        const id = `${String(++sequence).padStart(4, '0')}-${session.kind}-api-${safeSegment(scenario.id)}-source-gate`;
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
    await Promise.allSettled(sessions.map(async (session) => session.close()));
  }

  const completedAtMs = Date.now();
  const counts = statusCounts(attempts);
  const exitCode = counts.FAIL + counts.CLEANUP_FAILED > 0 ? 1 : 0;
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
  await writeLiveTestReports(options.outputDirectory, summary);
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
          () => ({ data: createFixtureData(definition.create(context, purpose), purpose) }),
        );
        if (input === undefined) {
          if (purpose === 'showcase') break;
          continue;
        }
        const outcome = await record(session, path, createScenario, `create-${purpose}`, input, async () => {
          const response = await callWrite(session, site, createScenario.id, input, path);
          const entity = entityFromMutation(response, asRecord(input['data']));
          if (entity === undefined) {
            throw new Error(`Create action ${createScenario.id} returned no positive resource identifier.`);
          }
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
          return { response, expected: { created: true, purpose }, actual: { id: entity.id } };
        });
        if (outcome === undefined && purpose === 'showcase') break;
      }
    }

    const showcase = state.records.get(baseId);
    if (showcase === undefined) continue;
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
        const response = await callWrite(session, site, updateScenario.id, input, path);
        return { response, expected: changes };
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
            const attributes = entity?.attributes ?? {};
            const matched = Object.entries(changes).filter(([key]) => key !== 'password' && key !== 'password2')
              .every(([key, value]) => looselyEqual(attributes[key], value));
            if (!matched) {
              throw new Error(`Updated ${baseId} did not return the expected changed fields.`);
            }
            state.records.set(baseId, entity!);
            return { response, expected: changes, actual: attributes };
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
        if (await verifyDeletion(session, path, site, getScenario, deletion, record)) {
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

function createFixtureData(
  data: Readonly<Record<string, unknown>>,
  purpose: 'showcase' | 'deletion',
): Readonly<Record<string, unknown>> {
  if (purpose !== 'deletion') return data;
  const trash = trashData(data);
  return trash === undefined ? data : Object.freeze({ ...data, ...trash });
}

function trashData(
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
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
    await record(session, path, scenario, 'write', input, async () => {
      const response = await executeSpecialWrite(
        session,
        path,
        siteId,
        scenario,
        input,
        state,
        options.seed,
      );
      rememberSpecialWrite(scenario.id, input, response, state);
      return { response };
    });
  }
}

async function cleanupRecords(
  session: LiveMcpSession,
  path: LiveJoomlaPath,
  site: string,
  state: LaneState,
  record: AttemptRecorder,
): Promise<void> {
  for (const baseId of [...crudFixtureOrder].reverse()) {
    const entity = state.records.get(baseId);
    if (entity === undefined) continue;
    const scenario = liveScenarioCatalog().find((candidate) => candidate.id === `${baseId}.delete`);
    if (scenario === undefined || !scenario.joomlaPaths.includes(path)) continue;
    const trash = trashData(entity.attributes);
    if (trash !== undefined) {
      const updateScenario = liveScenarioCatalog().find((candidate) => candidate.id === `${baseId}.update`);
      if (updateScenario !== undefined && updateScenario.joomlaPaths.includes(path)) {
        const trashInput = { id: numericId(entity.id), data: trash };
        const trashed = await record(session, path, updateScenario, 'cleanup-trash-showcase', trashInput, async () => ({
          response: await callWrite(session, site, updateScenario.id, trashInput, path),
          expected: trash,
        }), true);
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
        ? await verifyDeletion(session, path, site, getScenario, entity, record, true)
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
      const mediaPath = findDeepValue(state.reads.get('media.files.list'), 'path');
      return typeof mediaPath === 'string'
        ? { path: mediaPath }
        : new BlockedError('media.files.list returned no readable media path.', ['media.files.list']);
    }
    if (actionId === 'plugins.plugins.get') {
      return idFromRead(state, 'plugins.plugins.list');
    }
    if (actionId === 'privacy.requests.get') return idFromRead(state, 'privacy.requests.list');
    if (actionId === 'privacy.consents.get') return idFromRead(state, 'privacy.consents.list');
    if (actionId.startsWith('languages.overrides.')) {
      return new BlockedError('No deterministic pre-existing language override is assumed.', [`${actionId.replace('.get', '.list')}`]);
    }
    return new BlockedError(`${actionId} requires an existing catalogue record.`, [`${baseId}.list`]);
  }
  if (actionId.endsWith('.export')) return idFromRead(state, actionId.replace('.export', '.list'));
  if (actionId === 'joomla-update.healthcheck' || actionId === 'joomla-update.status') return {};
  return {};
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
    return {
      data: {
        path: `local-images:joomla-mcp-live-${safeSegment(seed)}-${safeSegment(state.lane)}.txt`,
        content: Buffer.from(`Joomla MCP live fixture ${seed}\n`).toString('base64'),
        override: false,
      },
    };
  }
  if (actionId === 'media.files.update') {
    const path = state.reads.get('live.media.path');
    return typeof path !== 'string'
      ? new BlockedError('Media update requires a successful media.files.create.', ['media.files.create'])
      : {
          path,
          data: {
            content: Buffer.from(`Joomla MCP live fixture ${seed} updated\n`).toString('base64'),
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
    const constant = `JOOMLA_MCP_LIVE_${safeSeed}`;
    return { language: 'en-GB', data: { key: constant, override: `Joomla MCP live ${seed}`, both: false } };
  }
  if (actionId === 'languages.overrides.site.delete' || actionId === 'languages.overrides.administrator.delete') {
    return { language: 'en-GB', constant: `JOOMLA_MCP_LIVE_${safeSeed}` };
  }
  if (actionId === 'languages.overrides.search') {
    return { data: { searchstring: `JOOMLA_MCP_LIVE_${safeSeed}`, searchtype: 'constant' } };
  }
  if (actionId === 'languages.overrides.refresh') return {};
  if (actionId === 'joomla-update.prepare') {
    return { data: { targetVersion: JOOMLA_MCP_VERSION } };
  }
  if (actionId === 'joomla-update.finalize') {
    return { data: { fromVersion: JOOMLA_MCP_VERSION, updateFileName: 'joomla-mcp-live.zip' } };
  }
  if (actionId.startsWith('joomla-update.notification.')) {
    return { data: { fromVersion: JOOMLA_MCP_VERSION, toVersion: JOOMLA_MCP_VERSION } };
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
    if (typeof data['path'] === 'string') {
      state.reads.set('live.media.path', data['path']);
      state.created.push({
        lane: state.lane,
        family: 'media.files',
        id: data['path'],
        label: `Live-test media ${data['path']}`,
      });
    }
  }
  if (actionId === 'media.files.delete' && typeof input['path'] === 'string') {
    removeRetainedRecord(state, 'media.files', input['path']);
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
  const applied = await callWrite(session, site, scenario.id, input, path);

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
  if (scenario.id === 'media.files.create') {
    const mediaPath = asRecord(input['data'])['path'];
    const verification = typeof mediaPath === 'string'
      ? await callRead(session, site, 'media.files.get', { path: mediaPath }, path)
      : undefined;
    return { applied, verification };
  }
  if (scenario.id === 'media.files.update') {
    const mediaPath = input['path'];
    const verification = typeof mediaPath === 'string'
      ? await callRead(session, site, 'media.files.get', { path: mediaPath }, path)
      : undefined;
    return { applied, verification };
  }
  if (
    scenario.id === 'languages.overrides.site.create' ||
    scenario.id === 'languages.overrides.administrator.create'
  ) {
    const data = asRecord(input['data']);
    const constant = data['key'];
    const readAction = scenario.id.replace('.create', '.get');
    const verification = typeof constant === 'string'
      ? await callRead(session, site, readAction, { language: input['language'], constant }, path)
      : undefined;
    state.reads.set(`${scenario.id}.constant`, constant);
    return { applied, verification };
  }
  if (scenario.id === 'media.files.delete') {
    try {
      await callRead(session, site, 'media.files.get', { path: input['path'] }, path);
      throw new Error(`Deleted media path ${String(input['path'])} remains readable.`);
    } catch (error) {
      if (!(error instanceof LiveMcpToolError) || !/(?:404|not found|does not exist)/iu.test(error.message)) {
        throw error;
      }
    }
    return { applied, verification: { absent: true } };
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
    candidate['update_site_id'] ?? candidate['extension_id'];
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const attributesValue = asRecord(candidate['attributes']);
  const attributes = Object.keys(attributesValue).length > 0
    ? attributesValue
    : Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'id'));
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
      record['update_site_id'] ?? record['extension_id'];
    if ((typeof id === 'string' || typeof id === 'number') && isResourceEntityRecord(record)) {
      const attributesValue = asRecord(record['attributes']);
      const attributes = Object.keys(attributesValue).length > 0
        ? attributesValue
        : Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'id'));
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
      typeof record['update_site_id'] === 'number' ||
      typeof record['extension_id'] === 'number') &&
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

function looselyEqual(actual: unknown, expected: unknown): boolean {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
  if (typeof expected === 'number' || typeof expected === 'boolean') return String(actual) === String(Number(expected));
  return String(actual ?? '') === String(expected ?? '');
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

function readPriority(actionId: string): number {
  if (actionId.endsWith('.list')) return 0;
  if (actionId.endsWith('.get')) return 1;
  if (actionId.endsWith('.export')) return 2;
  return 0;
}

function specialWritePriority(actionId: string): number {
  if (actionId.endsWith('-history.keep')) return 10;
  if (actionId.endsWith('-history.delete')) return 20;
  if (actionId === 'media.files.create') return 10;
  if (actionId === 'media.files.update') return 20;
  if (actionId === 'media.files.delete') return 30;
  if (actionId.endsWith('.create')) return 10;
  if (actionId.endsWith('.update')) return 20;
  if (actionId.endsWith('.delete')) return 30;
  return 15;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
