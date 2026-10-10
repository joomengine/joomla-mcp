import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runLiveTest } from '../src/live-test/runner.js';
import * as transports from '../src/live-test/transports.js';
import type { LiveMcpSession, LiveTestOptions } from '../src/live-test/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('live-test transport session lifecycle', () => {
  it('opens HTTP after a preceding lane longer than the gateway idle TTL', async () => {
    const options = await fixtureOptions();
    const events: string[] = [];
    let elapsedMs = 0;
    const idleTtlMs = 15 * 60_000;
    const createSession = (kind: LiveMcpSession['kind']): LiveMcpSession => {
      events.push(`connect-${kind}`);
      let lastSeenAtMs = elapsedMs;
      return {
        kind,
        call: async (call) => {
          if (kind === 'http' && elapsedMs - lastSeenAtMs >= idleTtlMs) {
            throw new Error('session_not_found');
          }
          lastSeenAtMs = elapsedMs;
          if (call.name === 'joomla_sites_list') events.push(`discovery-${kind}`);
          if (call.name === 'joomla_action_read') {
            events.push(`read-${kind}`);
            if (kind === 'stdio') elapsedMs += 20 * 60_000;
          }
          return { data: [] };
        },
        close: async () => { events.push(`close-${kind}`); },
        diagnostics: () => ({ transport: kind }),
      };
    };
    vi.spyOn(transports, 'createStdioLiveSession').mockImplementation(async () => createSession('stdio'));
    vi.spyOn(transports, 'createHttpLiveSession').mockImplementation(async () => createSession('http'));

    try {
      const summary = await runLiveTest(options);

      expect(summary.exitCode).toBe(0);
      expect(summary.counts.PASS).toBe(2);
      expect(events).toEqual([
        'connect-stdio', 'discovery-stdio', 'read-stdio',
        'connect-http', 'discovery-http', 'read-http',
        'close-stdio', 'close-http',
      ]);
      expect(summary.environment.transportDiagnostics).toEqual([
        { transport: 'stdio' }, { transport: 'http' },
      ]);
    } finally {
      await rm(dirname(options.configurationFile), { recursive: true, force: true });
    }
  });

  it('closes a failed active transport once without opening the next transport', async () => {
    const options = await fixtureOptions();
    const close = vi.fn(async () => undefined);
    vi.spyOn(transports, 'createStdioLiveSession').mockResolvedValue({
      kind: 'stdio',
      call: async () => { throw new Error('Discovery failed'); },
      close,
      diagnostics: () => ({ transport: 'stdio' }),
    });
    const createHttp = vi.spyOn(transports, 'createHttpLiveSession');

    try {
      const summary = await runLiveTest(options);

      expect(summary.exitCode).toBe(1);
      expect(summary.attempts).toEqual([
        expect.objectContaining({
          scenarioId: 'live-test.harness',
          mcpTransport: 'stdio',
          status: 'FAIL',
          reason: 'Discovery failed',
        }),
      ]);
      expect(close).toHaveBeenCalledOnce();
      expect(createHttp).not.toHaveBeenCalled();
      expect(summary.environment.transportDiagnostics).toEqual([{ transport: 'stdio' }]);
    } finally {
      await rm(dirname(options.configurationFile), { recursive: true, force: true });
    }
  });
});

async function fixtureOptions(): Promise<LiveTestOptions> {
  const directory = await mkdtemp(join(tmpdir(), 'jmcp-session-lifecycle-'));
  const configurationFile = join(directory, 'sites.json');
  vi.stubEnv('LIVE_TEST_LIFECYCLE_TOKEN', 'fixture-token');
  await writeFile(configurationFile, JSON.stringify({
    defaultSite: 'fixture',
    sites: {
      fixture: {
        toolsets: ['discovery', 'configuration.read'],
        api: {
          baseUrl: 'https://example.test/api/index.php/v1',
          tokenEnv: 'LIVE_TEST_LIFECYCLE_TOKEN',
        },
      },
    },
  }));
  return {
    configurationFile,
    outputDirectory: join(directory, 'evidence'),
    profile: 'read',
    joomlaPaths: ['api'],
    mcpTransports: ['stdio', 'http'],
    families: ['configuration.application'],
    nonInteractive: true,
    confirmMutations: false,
    disposable: false,
    cleanup: false,
    retainDemo: false,
    failFast: false,
    seed: 'session-lifecycle',
  };
}
