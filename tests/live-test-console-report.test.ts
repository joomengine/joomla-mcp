import { describe, expect, it } from 'vitest';

import { renderLiveTestConsoleDiagnostics } from '../src/live-test/console-report.js';
import { statusCounts } from '../src/live-test/reporting.js';
import type { LiveTestAttempt, LiveTestSummary } from '../src/live-test/types.js';

describe('live-test console diagnostics', () => {
  it('prints every direct failure and groups blocked descendants after the complete run', () => {
    const failures: LiveTestAttempt[] = [
      attempt('one', 'FAIL', 'content.articles.create', 'create-showcase', 'HTTP 400: required field missing', 'joomla_http_400'),
      attempt('two', 'FAIL', 'modules.site.create', 'create-showcase', 'HTTP 400: required field missing', 'joomla_http_400'),
      { ...attempt('cleanup', 'CLEANUP_FAILED', 'menus.site-items.update', 'cleanup-trash-showcase', 'HTTP 500', 'joomla_http_500'), expected: { state: -2 }, actual: { state: 1 } },
      { ...attempt('blocked', 'BLOCKED_BY_PREREQUISITE', 'content.articles.update', 'update-showcase', 'Create failed', 'prerequisite_unavailable'), rootCauseId: 'one' },
    ];
    const output = renderLiveTestConsoleDiagnostics(summary(failures));

    expect(output).toContain('Direct failures: 2; cleanup failures: 1; blocked descendants: 1');
    expect(output).toContain('root-cause groups: 2');
    expect(output).toContain('[FAIL] one');
    expect(output).toContain('[FAIL] two');
    expect(output).toContain('[CLEANUP_FAILED] cleanup');
    expect(output).toContain('expected={"state":-2}');
    expect(output).toContain('actual={"state":1}');
    expect(output).toContain('root=one; count=1; actions=content.articles.update');
    expect(output).toContain('reproduce=npx joomla-mcp-live-test');
  });
});

function attempt(
  id: string,
  status: LiveTestAttempt['status'],
  scenarioId: string,
  phase: string,
  reason: string,
  failureCode: string,
): LiveTestAttempt {
  return {
    id,
    scenarioId,
    title: scenarioId,
    domain: scenarioId.split('.')[0]!,
    risk: 'write',
    toolset: 'content.write',
    operation: 'create',
    mcpTransport: 'stdio',
    joomlaPath: 'api',
    phase,
    status,
    startedAt: '2026-07-24T00:00:00.000Z',
    durationMs: 12,
    reason,
    failureCode,
    reproduction: 'npx joomla-mcp-live-test --families content',
  };
}

function summary(attempts: LiveTestAttempt[]): LiveTestSummary {
  return {
    schema: 'joomengine.joomla-mcp.live-test/v1',
    runId: 'console-test',
    site: 'fixture',
    hostname: '127.0.0.1',
    startedAt: '2026-07-24T00:00:00.000Z',
    completedAt: '2026-07-24T00:00:01.000Z',
    durationMs: 1_000,
    selection: { profile: 'full', joomlaPaths: ['api'], mcpTransports: ['stdio'], families: [] },
    environment: {
      packageVersion: '0.7.0',
      nodeVersion: 'v22',
      platform: 'linux',
      architecture: 'x64',
      repositoryCommit: 'abc',
      seed: 'test',
      configurationFingerprint: 'fingerprint',
      fixtureDigests: {},
      transportDiagnostics: [],
    },
    catalogue: { total: attempts.length, selected: attempts.length, sourceOnly: 0 },
    counts: statusCounts(attempts),
    attempts,
    retainedRecords: [],
    exitCode: 1,
  };
}
