import { describe, expect, it, vi } from 'vitest';

import {
  createConsoleProgressReporter,
  safeProgressReport,
  withProgressOperation,
} from '../src/live-test/progress.js';

describe('live-test progress output', () => {
  it('prints immediate start, result, lane, and failure context without payloads', () => {
    const lines: string[] = [];
    const reporter = createConsoleProgressReporter((value) => lines.push(value));
    reporter({
      kind: 'attempt-start',
      timestamp: '2026-07-25T10:00:00.000Z',
      attemptId: '0001-stdio-api-content-articles-create',
      scenarioId: 'content.articles.create',
      phase: 'create-welcome',
      transport: 'stdio',
      joomlaPath: 'api',
      elapsedMs: 0,
    });
    reporter({
      kind: 'attempt-result',
      timestamp: '2026-07-25T10:00:01.250Z',
      attemptId: '0001-stdio-api-content-articles-create',
      scenarioId: 'content.articles.create',
      phase: 'create-welcome',
      transport: 'stdio',
      joomlaPath: 'api',
      elapsedMs: 1_250,
      status: 'PASS',
    });

    expect(lines.join('')).toContain('START 0001-stdio-api-content-articles-create');
    expect(lines.join('')).toContain('PASS');
    expect(lines.join('')).toContain('duration=1.3s');
    expect(lines.join('')).not.toContain('password');
  });

  it('does not allow a consumer reporter failure to change test execution', () => {
    const reporter = vi.fn(() => {
      throw new Error('broken output sink');
    });
    expect(() => safeProgressReport(reporter, {
      kind: 'report-start',
      timestamp: new Date(0).toISOString(),
      message: 'Writing evidence',
    })).not.toThrow();
  });

  it('redacts credentials embedded in failure text before writing stdout', () => {
    const lines: string[] = [];
    const reporter = createConsoleProgressReporter((value) => lines.push(value));
    reporter({
      kind: 'attempt-result',
      timestamp: '2026-07-25T10:00:01.250Z',
      attemptId: '0002-http-api-users-create',
      scenarioId: 'users.users.create',
      phase: 'create-alice',
      transport: 'http',
      joomlaPath: 'api',
      elapsedMs: 1,
      status: 'FAIL',
      reason: 'Authorization: Bearer abcdefghijklmnop password=VisibleNoMore! token=abcdef123456',
    });

    expect(lines.join('')).not.toContain('abcdefghijklmnop');
    expect(lines.join('')).not.toContain('VisibleNoMore');
    expect(lines.join('')).not.toContain('abcdef123456');
    expect(lines.join('')).toContain('[REDACTED]');
  });

  it('reports setup operations and their failures without waiting for a scenario attempt', async () => {
    const lines: string[] = [];
    const reporter = createConsoleProgressReporter((value) => lines.push(value));

    await expect(withProgressOperation(
      reporter,
      {
        operationId: 'discovery-http',
        operation: 'Verify MCP discovery',
        transport: 'http',
      },
      30,
      async () => {
        throw new Error('discovery unavailable');
      },
    )).rejects.toThrow('discovery unavailable');

    expect(lines.join('')).toContain('START discovery-http');
    expect(lines.join('')).toContain('FAIL discovery-http');
    expect(lines.join('')).toContain('discovery unavailable');
  });
});
