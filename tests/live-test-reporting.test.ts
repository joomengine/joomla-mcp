import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configurationFingerprint,
  redact,
  statusCounts,
  writeLiveTestReports,
} from '../src/live-test/reporting.js';
import type { LiveTestAttempt, LiveTestSummary } from '../src/live-test/types.js';

describe('live-test evidence', () => {
  it('redacts secrets recursively and produces stable fingerprints', () => {
    expect(redact({
      authorization: 'Bearer secret',
      nested: { password: 'secret', title: 'safe' },
    })).toEqual({
      authorization: '[REDACTED]',
      nested: { password: '[REDACTED]', title: 'safe' },
    });
    expect(configurationFingerprint({ b: 2, a: 1 }))
      .toBe(configurationFingerprint({ a: 1, b: 2 }));
  });

  it('writes Markdown, JSON, JUnit, and one redacted file per attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-live-report-'));
    const attempt: LiveTestAttempt = {
      id: '0001-stdio-api-content.articles.create',
      scenarioId: 'content.articles.create',
      title: 'Create article',
      domain: 'content',
      risk: 'write',
      toolset: 'content.write',
      operation: 'create',
      mcpTransport: 'stdio',
      joomlaPath: 'api',
      phase: 'create-showcase',
      status: 'FAIL',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 12,
      request: { data: { title: 'Example', password: 'do-not-store' } },
      reason: 'Expected title was not returned.',
      failureCode: 'postcondition_failed',
      reproduction: 'npx joomla-mcp-live-test --families content',
    };
    const summary: LiveTestSummary = {
      schema: 'joomengine.joomla-mcp.live-test/v1',
      runId: 'test',
      site: 'fixture',
      hostname: 'fixture.test',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1_000,
      selection: {
        profile: 'full',
        joomlaPaths: ['api'],
        mcpTransports: ['stdio'],
        families: [],
      },
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
      catalogue: { total: 1, selected: 1, sourceOnly: 0 },
      counts: statusCounts([attempt]),
      attempts: [attempt],
      retainedRecords: [],
      exitCode: 1,
    };

    await writeLiveTestReports(directory, summary);
    expect(await readdir(directory)).toEqual(expect.arrayContaining([
      'actions', 'junit.xml', 'summary.json', 'summary.md',
    ]));
    expect(await readFile(join(directory, 'summary.md'), 'utf8')).toContain('Expected title was not returned');
    expect(await readFile(join(directory, 'junit.xml'), 'utf8')).toContain('postcondition_failed');
    expect(await readFile(join(directory, 'summary.json'), 'utf8')).not.toContain('do-not-store');
  });
});
