#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const transientFailurePatterns = [
  /\b(?:408|425|429|500|502|503|504)\b/,
  /\b(?:EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b/i,
  /audit endpoint returned an error/i,
  /gateway[\s-]+time-?out/i,
  /network (?:error|timeout)/i,
  /service unavailable/i,
  /socket hang up/i,
  /too many requests/i,
];

export function classifyAuditResult(result) {
  const report = parseAuditReport(result.stdout);

  if (result.exitCode === 0) {
    return report === null
      ? { kind: 'unexpected', report: null }
      : { kind: 'success', report };
  }

  if (report !== null) {
    return { kind: 'vulnerabilities', report };
  }

  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (transientFailurePatterns.some((pattern) => pattern.test(diagnostic))) {
    return { kind: 'transient', report: null };
  }

  return { kind: 'unexpected', report: null };
}

export async function runAuditWithRetry({
  attempts = readPositiveInteger('NPM_AUDIT_ATTEMPTS', DEFAULT_ATTEMPTS),
  retryDelayMs = readNonNegativeInteger(
    'NPM_AUDIT_RETRY_DELAY_MS',
    DEFAULT_RETRY_DELAY_MS,
  ),
  execute = executeAudit,
  sleep = delay,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  assertPositiveInteger(attempts, 'attempts');
  assertNonNegativeInteger(retryDelayMs, 'retryDelayMs');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await execute();
    const classification = classifyAuditResult(result);

    if (classification.kind === 'success') {
      stdout.write(`${formatAuditSummary(classification.report)}\n`);
      return classification.report;
    }

    if (classification.kind === 'vulnerabilities') {
      writeCapturedOutput(result, stdout, stderr);
      throw new Error('npm audit found a production dependency vulnerability at or above the high severity threshold.');
    }

    if (classification.kind === 'unexpected') {
      writeCapturedOutput(result, stdout, stderr);
      throw new Error('npm audit returned an unexpected result; refusing to retry or ignore it.');
    }

    if (attempt === attempts) {
      writeCapturedOutput(result, stdout, stderr);
      throw new Error(`npm audit remained unavailable after ${attempts} attempts.`);
    }

    const delayMs = retryDelayMs * (2 ** (attempt - 1));
    stderr.write(
      `[npm audit] Registry request failed transiently on attempt ${attempt}/${attempts}; `
      + `retrying in ${delayMs}ms.\n`,
    );
    await sleep(delayMs);
  }

  throw new Error('npm audit retry loop terminated unexpectedly.');
}

async function executeAudit() {
  try {
    const { stdout, stderr } = await execFileAsync(
      'npm',
      ['audit', '--omit=dev', '--audit-level=high', '--json'],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
      },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: [
        typeof error.stderr === 'string' ? error.stderr : '',
        error instanceof Error ? error.message : String(error),
      ].filter(Boolean).join('\n'),
    };
  }
}

function parseAuditReport(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return null;
  }

  try {
    const report = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const vulnerabilities = report?.metadata?.vulnerabilities;
    if (
      report === null
      || typeof report !== 'object'
      || vulnerabilities === null
      || typeof vulnerabilities !== 'object'
      || Array.isArray(vulnerabilities)
    ) {
      return null;
    }

    for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
      if (
        !Number.isSafeInteger(vulnerabilities[severity])
        || vulnerabilities[severity] < 0
      ) {
        return null;
      }
    }

    return report;
  } catch {
    return null;
  }
}

function formatAuditSummary(report) {
  const { vulnerabilities } = report.metadata;
  return '[npm audit] Production dependency audit passed '
    + `(info=${vulnerabilities.info}, low=${vulnerabilities.low}, `
    + `moderate=${vulnerabilities.moderate}, high=${vulnerabilities.high}, `
    + `critical=${vulnerabilities.critical}).`;
}

function writeCapturedOutput(result, stdout, stderr) {
  if (result.stdout !== '') {
    stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  }
  if (result.stderr !== '') {
    stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  }
}

function readPositiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  assertPositiveInteger(parsed, name);
  return parsed;
}

function readNonNegativeInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  assertNonNegativeInteger(parsed, name);
  return parsed;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runAuditWithRetry().catch((error) => {
    console.error(`[npm audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
