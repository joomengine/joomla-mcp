import type { LiveTestAttempt, LiveTestSummary } from './types.js';

const directStatuses = new Set(['FAIL', 'CLEANUP_FAILED']);

export function renderLiveTestConsoleDiagnostics(summary: LiveTestSummary): string {
  const direct = summary.attempts.filter((attempt) => directStatuses.has(attempt.status));
  const blocked = summary.attempts.filter((attempt) => attempt.status === 'BLOCKED_BY_PREREQUISITE');
  if (direct.length === 0 && blocked.length === 0) return '';

  const groups = new Map<string, LiveTestAttempt[]>();
  for (const attempt of direct) {
    const key = `${attempt.failureCode ?? 'unclassified'}\u0000${normalizeReason(attempt.reason)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [attempt]);
    else group.push(attempt);
  }

  const lines = [
    '',
    '=== Joomla MCP live validation diagnostics ===',
    `Direct failures: ${direct.filter((attempt) => attempt.status === 'FAIL').length}; cleanup failures: ${direct.filter((attempt) => attempt.status === 'CLEANUP_FAILED').length}; blocked descendants: ${blocked.length}; root-cause groups: ${groups.size}.`,
    'The suite completed all independent scenarios before producing this report.',
  ];

  let groupNumber = 0;
  for (const attempts of groups.values()) {
    groupNumber += 1;
    const first = attempts[0]!;
    lines.push(
      '',
      `ROOT CAUSE ${groupNumber}/${groups.size}: ${first.failureCode ?? 'unclassified'} (${attempts.length} occurrence${attempts.length === 1 ? '' : 's'})`,
      `Reason: ${oneLine(first.reason ?? 'No failure reason was captured.')}`,
    );
    for (const attempt of attempts) lines.push(...renderAttempt(attempt));
  }

  if (blocked.length > 0) {
    const byRoot = new Map<string, LiveTestAttempt[]>();
    for (const attempt of blocked) {
      const key = attempt.rootCauseId ?? 'unlinked';
      const entries = byRoot.get(key);
      if (entries === undefined) byRoot.set(key, [attempt]);
      else entries.push(attempt);
    }
    lines.push('', 'BLOCKED DESCENDANTS (not counted as additional root failures)');
    for (const [rootCauseId, attempts] of byRoot) {
      const actions = [...new Set(attempts.map((attempt) => attempt.scenarioId))];
      lines.push(
        `- root=${rootCauseId}; count=${attempts.length}; actions=${actions.join(', ')}`,
      );
    }
  }

  lines.push('', 'Complete redacted evidence: summary.md, summary.json, junit.xml, and actions/*.json', '');
  return `${lines.join('\n')}\n`;
}

function renderAttempt(attempt: LiveTestAttempt): string[] {
  const lines = [
    `  [${attempt.status}] ${attempt.id}`,
    `    action=${attempt.scenarioId}; phase=${attempt.phase}; lane=${attempt.mcpTransport}/${attempt.joomlaPath}; durationMs=${attempt.durationMs}`,
    `    reason=${oneLine(attempt.reason ?? 'No failure reason was captured.')}`,
  ];
  if (attempt.expected !== undefined) lines.push(`    expected=${boundedJson(attempt.expected)}`);
  if (attempt.actual !== undefined) lines.push(`    actual=${boundedJson(attempt.actual)}`);
  lines.push(`    reproduce=${oneLine(attempt.reproduction)}`);
  return lines;
}

function normalizeReason(value: string | undefined): string {
  return oneLine(value ?? 'No failure reason was captured.')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '<uuid>')
    .replace(/\b\d{4,}\b/gu, '<number>');
}

function boundedJson(value: unknown): string {
  const rendered = oneLine(JSON.stringify(value) ?? String(value));
  return rendered.length <= 2_000 ? rendered : `${rendered.slice(0, 2_000)}…[truncated]`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}
