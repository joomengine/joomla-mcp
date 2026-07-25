import type {
  LiveJoomlaPath,
  LiveMcpTransport,
  LiveTestStatus,
} from './types.js';
import { redactText } from './reporting.js';

export type LiveProgressEvent =
  | {
      readonly kind: 'run-start' | 'run-complete';
      readonly timestamp: string;
      readonly runId: string;
      readonly message: string;
    }
  | {
      readonly kind: 'session-start' | 'session-ready' | 'session-close';
      readonly timestamp: string;
      readonly transport: LiveMcpTransport;
      readonly message: string;
    }
  | {
      readonly kind: 'lane-start' | 'lane-complete';
      readonly timestamp: string;
      readonly transport: LiveMcpTransport;
      readonly joomlaPath: LiveJoomlaPath;
      readonly message: string;
    }
  | {
      readonly kind: 'attempt-start' | 'attempt-heartbeat' | 'attempt-result';
      readonly timestamp: string;
      readonly attemptId: string;
      readonly scenarioId: string;
      readonly phase: string;
      readonly transport: LiveMcpTransport;
      readonly joomlaPath: LiveJoomlaPath;
      readonly elapsedMs: number;
      readonly status?: LiveTestStatus;
      readonly reason?: string;
    }
  | {
      readonly kind: 'report-start' | 'report-complete';
      readonly timestamp: string;
      readonly message: string;
    }
  | {
      readonly kind: 'operation-start' | 'operation-heartbeat' | 'operation-result';
      readonly timestamp: string;
      readonly operationId: string;
      readonly operation: string;
      readonly transport?: LiveMcpTransport;
      readonly joomlaPath?: LiveJoomlaPath;
      readonly elapsedMs: number;
      readonly status?: 'PASS' | 'FAIL';
      readonly reason?: string;
    };

export type LiveProgressReporter = (event: LiveProgressEvent) => void;

export function createConsoleProgressReporter(
  write: (value: string) => void,
): LiveProgressReporter {
  return (event): void => {
    const prefix = `[live-test ${event.timestamp}]`;
    switch (event.kind) {
      case 'attempt-start':
        write(
          `${prefix} START ${event.attemptId} ${event.transport}/${event.joomlaPath} ` +
          `${event.scenarioId} phase=${event.phase}\n`,
        );
        break;
      case 'attempt-heartbeat':
        write(
          `${prefix} WAIT  ${event.attemptId} ${event.transport}/${event.joomlaPath} ` +
          `${event.scenarioId} phase=${event.phase} elapsed=${formatDuration(event.elapsedMs)}\n`,
        );
        break;
      case 'attempt-result':
        write(
          `${prefix} ${padStatus(event.status ?? 'FAIL')} ${event.attemptId} ` +
          `${event.transport}/${event.joomlaPath} ${event.scenarioId} phase=${event.phase} ` +
          `duration=${formatDuration(event.elapsedMs)}` +
          (event.reason === undefined ? '' : ` reason=${oneLine(event.reason)}`) +
          '\n',
        );
        break;
      case 'operation-start':
        write(
          `${prefix} START ${event.operationId}${operationLane(event)} ` +
          `${oneLine(event.operation)}\n`,
        );
        break;
      case 'operation-heartbeat':
        write(
          `${prefix} WAIT  ${event.operationId}${operationLane(event)} ` +
          `${oneLine(event.operation)} elapsed=${formatDuration(event.elapsedMs)}\n`,
        );
        break;
      case 'operation-result':
        write(
          `${prefix} ${(event.status ?? 'FAIL').padEnd(4)} ${event.operationId}` +
          `${operationLane(event)} ${oneLine(event.operation)} ` +
          `duration=${formatDuration(event.elapsedMs)}` +
          (event.reason === undefined ? '' : ` reason=${oneLine(event.reason)}`) +
          '\n',
        );
        break;
      case 'session-start':
      case 'session-ready':
      case 'session-close':
        write(`${prefix} ${event.kind.toUpperCase()} transport=${event.transport} ${oneLine(event.message)}\n`);
        break;
      case 'lane-start':
      case 'lane-complete':
        write(
          `${prefix} ${event.kind.toUpperCase()} lane=${event.transport}/${event.joomlaPath} ` +
          `${oneLine(event.message)}\n`,
        );
        break;
      default:
        write(`${prefix} ${event.kind.toUpperCase()} ${oneLine(event.message)}\n`);
    }
  };
}

export async function withProgressOperation<T>(
  reporter: LiveProgressReporter | undefined,
  operation: {
    readonly operationId: string;
    readonly operation: string;
    readonly transport?: LiveMcpTransport;
    readonly joomlaPath?: LiveJoomlaPath;
  },
  heartbeatSeconds: number,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  safeProgressReport(reporter, {
    kind: 'operation-start',
    timestamp: new Date(startedAtMs).toISOString(),
    ...operation,
    elapsedMs: 0,
  });
  const timer = reporter === undefined
    ? undefined
    : setInterval(() => {
        safeProgressReport(reporter, {
          kind: 'operation-heartbeat',
          timestamp: new Date().toISOString(),
          ...operation,
          elapsedMs: Date.now() - startedAtMs,
        });
      }, heartbeatSeconds * 1_000);
  timer?.unref();
  try {
    const value = await execute();
    safeProgressReport(reporter, {
      kind: 'operation-result',
      timestamp: new Date().toISOString(),
      ...operation,
      elapsedMs: Date.now() - startedAtMs,
      status: 'PASS',
    });
    return value;
  } catch (error) {
    safeProgressReport(reporter, {
      kind: 'operation-result',
      timestamp: new Date().toISOString(),
      ...operation,
      elapsedMs: Date.now() - startedAtMs,
      status: 'FAIL',
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

export function safeProgressReport(
  reporter: LiveProgressReporter | undefined,
  event: LiveProgressEvent,
): void {
  if (reporter === undefined) return;
  try {
    reporter(event);
  } catch {
    // Reporting must never change the live-test result or interrupt cleanup.
  }
}

export function progressHeartbeat(
  reporter: LiveProgressReporter | undefined,
  event: {
    readonly attemptId: string;
    readonly scenarioId: string;
    readonly phase: string;
    readonly transport: LiveMcpTransport;
    readonly joomlaPath: LiveJoomlaPath;
  },
  startedAtMs: number,
  seconds: number,
): ReturnType<typeof setInterval> | undefined {
  if (reporter === undefined) return undefined;
  const timer = setInterval(() => {
    safeProgressReport(reporter, {
      kind: 'attempt-heartbeat',
      timestamp: new Date().toISOString(),
      ...event,
      elapsedMs: Date.now() - startedAtMs,
    });
  }, seconds * 1_000);
  timer.unref();
  return timer;
}

function padStatus(status: LiveTestStatus): string {
  return status.padEnd('KNOWN_UPSTREAM_LIMITATION'.length);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function oneLine(value: string): string {
  return redactText(value)
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 2_000);
}

function operationLane(event: {
  readonly transport?: LiveMcpTransport;
  readonly joomlaPath?: LiveJoomlaPath;
}): string {
  if (event.transport === undefined) return '';
  return ` ${event.transport}${event.joomlaPath === undefined ? '' : `/${event.joomlaPath}`}`;
}
