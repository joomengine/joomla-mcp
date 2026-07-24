import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  LiveTestAttempt,
  LiveTestStatus,
  LiveTestSummary,
} from './types.js';

const sensitiveKey = /authorization|cookie|password|secret|token|acknowledgement|confirmation/i;
const maximumStringLength = 32_768;
const maximumArrayLength = 10_000;

export async function writeLiveTestReports(
  directory: string,
  summary: LiveTestSummary,
): Promise<void> {
  await mkdir(join(directory, 'actions'), { recursive: true, mode: 0o700 });
  const safeSummary = redact(summary) as LiveTestSummary;
  await Promise.all([
    writeFile(join(directory, 'summary.json'), `${JSON.stringify(safeSummary, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(directory, 'summary.md'), renderMarkdown(safeSummary), { mode: 0o600 }),
    writeFile(join(directory, 'junit.xml'), renderJunit(safeSummary), { mode: 0o600 }),
    ...safeSummary.attempts.map(async (attempt) =>
      writeFile(
        join(directory, 'actions', `${safeFileName(attempt.id)}.json`),
        `${JSON.stringify(attempt, null, 2)}\n`,
        { mode: 0o600 },
      )),
  ]);
}

export function configurationFingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(redact(value))).digest('hex');
}

export function statusCounts(attempts: readonly LiveTestAttempt[]): Readonly<Record<LiveTestStatus, number>> {
  const counts: Record<LiveTestStatus, number> = {
    PASS: 0,
    FAIL: 0,
    EXPECTED_DENIAL: 0,
    SOURCE_ONLY_GATED: 0,
    BLOCKED_BY_PREREQUISITE: 0,
    CLEANUP_FAILED: 0,
  };
  for (const attempt of attempts) counts[attempt.status] += 1;
  return Object.freeze(counts);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[REDACTED: maximum nesting depth]';
  if (typeof value === 'string') {
    return value.length <= maximumStringLength
      ? value
      : `${value.slice(0, maximumStringLength)}…[truncated ${value.length - maximumStringLength} characters]`;
  }
  if (Array.isArray(value)) return value.slice(0, maximumArrayLength).map((entry) => redact(entry, depth + 1));
  if (typeof value !== 'object' || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(entry, depth + 1);
  }
  return output;
}

function renderMarkdown(summary: LiveTestSummary): string {
  const unexpected = summary.attempts.filter((attempt) =>
    attempt.status === 'FAIL' || attempt.status === 'CLEANUP_FAILED');
  const blocked = summary.attempts.filter((attempt) =>
    attempt.status === 'BLOCKED_BY_PREREQUISITE' || attempt.status === 'SOURCE_ONLY_GATED');
  const lines = [
    '# Joomla MCP live validation report',
    '',
    `- Run: \`${summary.runId}\``,
    `- Site: \`${summary.site}\` (\`${summary.hostname}\`)`,
    `- Result: **${summary.exitCode === 0 ? 'PASS' : 'FAIL'}**`,
    `- Started: ${summary.startedAt}`,
    `- Completed: ${summary.completedAt}`,
    `- Seed: \`${summary.environment.seed}\``,
    `- Commit: \`${summary.environment.repositoryCommit}\``,
    `- Configuration fingerprint: \`${summary.environment.configurationFingerprint}\``,
    '',
    '## Counts',
    '',
    '| Status | Count | Meaning |',
    '| --- | ---: | --- |',
    `| PASS | ${summary.counts.PASS} | Request and postcondition passed. |`,
    `| FAIL | ${summary.counts.FAIL} | Unexpected action, transport, or assertion failure. |`,
    `| EXPECTED_DENIAL | ${summary.counts.EXPECTED_DENIAL} | A documented safety or Joomla boundary denied the request. |`,
    `| SOURCE_ONLY_GATED | ${summary.counts.SOURCE_ONLY_GATED} | Joomla registers the route, but this MCP intentionally keeps it fail-closed. |`,
    `| BLOCKED_BY_PREREQUISITE | ${summary.counts.BLOCKED_BY_PREREQUISITE} | A named prerequisite was unavailable; see the root-cause link. |`,
    `| CLEANUP_FAILED | ${summary.counts.CLEANUP_FAILED} | Test data could not be removed or state could not be restored. |`,
    '',
  ];

  if (unexpected.length > 0) {
    lines.push('## Failures', '', '| Attempt | Action | Lane | Phase | Why | Reproduce |', '| --- | --- | --- | --- | --- | --- |');
    for (const attempt of unexpected) {
      lines.push(
        `| \`${attempt.id}\` | \`${attempt.scenarioId}\` | ${attempt.mcpTransport}/${attempt.joomlaPath} | ${attempt.phase} | ${cell(attempt.reason ?? 'No reason captured')} | \`${cell(attempt.reproduction)}\` |`,
      );
    }
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push('## Gated or blocked actions', '', '| Action | Status | Reason | Root cause |', '| --- | --- | --- | --- |');
    for (const attempt of blocked) {
      lines.push(
        `| \`${attempt.scenarioId}\` | ${attempt.status} | ${cell(attempt.reason ?? 'Not supplied')} | ${attempt.rootCauseId === undefined ? '—' : `\`${attempt.rootCauseId}\``} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Debugging a failure',
    '',
    '1. Find the attempt ID above or in `summary.json`.',
    '2. Open `actions/<attempt-id>.json` for the redacted request, response, expected value, actual value, source reference, stack, and exact reproduction command.',
    '3. Follow `rootCauseId` before investigating dependent failures.',
    '4. For CI fixture failures, inspect `compose.log`, `compose-ps.txt`, and the Joomla/PHP/MCP logs captured beside this report before the fixture was destroyed.',
    '5. `CLEANUP_FAILED` is always actionable: do not reuse a non-disposable site until the retained-record list is reviewed.',
    '',
  );

  if (summary.retainedRecords.length > 0) {
    lines.push('## Retained demo records', '', '| Lane | Family | ID | Label |', '| --- | --- | --- | --- |');
    for (const record of summary.retainedRecords) {
      lines.push(`| ${record.lane} | \`${record.family}\` | \`${record.id}\` | ${cell(record.label)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderJunit(summary: LiveTestSummary): string {
  const failures = summary.counts.FAIL + summary.counts.CLEANUP_FAILED;
  const skipped =
    summary.counts.EXPECTED_DENIAL +
    summary.counts.SOURCE_ONLY_GATED +
    summary.counts.BLOCKED_BY_PREREQUISITE;
  const cases = summary.attempts.map((attempt) => {
    const attributes =
      `name="${xml(attempt.scenarioId)} [${xml(attempt.mcpTransport)}/${xml(attempt.joomlaPath)}:${xml(attempt.phase)}]" ` +
      `classname="joomla-mcp.live.${xml(attempt.domain)}" time="${(attempt.durationMs / 1_000).toFixed(3)}"`;
    if (attempt.status === 'FAIL' || attempt.status === 'CLEANUP_FAILED') {
      return `    <testcase ${attributes}><failure type="${xml(attempt.failureCode ?? attempt.status)}" message="${xml(attempt.reason ?? 'Live test failed')}">${xml(attempt.stack ?? JSON.stringify(attempt.actual ?? ''))}</failure></testcase>`;
    }
    if (attempt.status !== 'PASS') {
      return `    <testcase ${attributes}><skipped message="${xml(`${attempt.status}: ${attempt.reason ?? ''}`)}"/></testcase>`;
    }
    return `    <testcase ${attributes}/>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${summary.attempts.length}" failures="${failures}" skipped="${skipped}" time="${(summary.durationMs / 1_000).toFixed(3)}">`,
    `  <testsuite name="Joomla MCP live validation" tests="${summary.attempts.length}" failures="${failures}" skipped="${skipped}" time="${(summary.durationMs / 1_000).toFixed(3)}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 220);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\s+/gu, ' ').trim();
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
