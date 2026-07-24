import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyAuditResult,
  runAuditWithRetry,
} from '../scripts/ci/npm-audit.mjs';

const cleanReport = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 2,
      high: 0,
      critical: 0,
      total: 2,
    },
  },
});

const vulnerableReport = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    example: { severity: 'high' },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
      total: 1,
    },
  },
});

const gatewayTimeout = {
  exitCode: 1,
  stdout: '<title>npmjs.org | 504: Gateway time-out</title>',
  stderr: 'npm warn audit 504 Gateway Timeout',
};

describe('npm audit CI retry policy', () => {
  it('is the fail-closed production audit gate used by CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const auditStep = workflow.match(
      /      - name: Audit production dependencies\n((?:        .*\n)*)/,
    )?.[0];

    expect(auditStep).toContain('node scripts/ci/npm-audit.mjs');
    expect(auditStep).toContain('NPM_AUDIT_ATTEMPTS: 3');
    expect(auditStep).toContain('NPM_AUDIT_RETRY_DELAY_MS: 5000');
    expect(auditStep).not.toContain('continue-on-error');
  });

  it('classifies registry timeouts as transient', () => {
    expect(classifyAuditResult(gatewayTimeout)).toEqual({
      kind: 'transient',
      report: null,
    });
  });

  it('retries a transient registry failure with bounded exponential backoff', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(gatewayTimeout)
      .mockResolvedValueOnce({ exitCode: 0, stdout: cleanReport, stderr: '' });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const output = createOutput();

    await expect(runAuditWithRetry({
      attempts: 3,
      retryDelayMs: 250,
      execute,
      sleep,
      ...output.streams,
    })).resolves.toMatchObject({
      metadata: {
        vulnerabilities: {
          moderate: 2,
          high: 0,
          critical: 0,
        },
      },
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
    expect(output.stderr).toContain('attempt 1/3');
    expect(output.stdout).toContain('high=0, critical=0');
  });

  it('fails immediately when npm reports a high severity vulnerability', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: vulnerableReport,
      stderr: '',
    });
    const sleep = vi.fn();

    await expect(runAuditWithRetry({
      attempts: 3,
      retryDelayMs: 0,
      execute,
      sleep,
      ...createOutput().streams,
    })).rejects.toThrow('production dependency vulnerability');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails closed without retrying malformed or unexplained output', async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: 'not an audit report',
      stderr: 'unknown npm failure',
    });
    const sleep = vi.fn();

    await expect(runAuditWithRetry({
      attempts: 3,
      retryDelayMs: 0,
      execute,
      sleep,
      ...createOutput().streams,
    })).rejects.toThrow('unexpected result');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails after the configured number of transient attempts', async () => {
    const execute = vi.fn().mockResolvedValue(gatewayTimeout);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const output = createOutput();

    await expect(runAuditWithRetry({
      attempts: 3,
      retryDelayMs: 100,
      execute,
      sleep,
      ...output.streams,
    })).rejects.toThrow('unavailable after 3 attempts');

    expect(execute).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
    expect(output.stdout).toContain('Gateway time-out');
    expect(output.stderr).toContain('Gateway Timeout');
  });
});

function createOutput() {
  let stdout = '';
  let stderr = '';

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    streams: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
  };
}
