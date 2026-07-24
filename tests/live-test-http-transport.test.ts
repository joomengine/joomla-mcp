import { describe, expect, it } from 'vitest';

import type { Configuration } from '../src/config/schema.js';
import { createHttpLiveSession } from '../src/live-test/transports.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([['test', {
    id: 'test',
    toolsets: new Set(['discovery']),
    api: {
      baseUrl: 'https://example.test',
      tokenEnv: 'TOKEN',
      token: 'secret',
      timeoutMs: 30_000,
      maxResponseBytes: 1_000_000,
      maxPageSize: 50,
      allowInsecureLoopback: false,
    },
  }]]),
};

describe('live-test HTTP MCP lane', () => {
  it('uses the real authenticated Streamable HTTP gateway', async () => {
    const session = await createHttpLiveSession(configuration);
    try {
      const result = await session.call({ name: 'joomla_sites_list', arguments: {} });
      expect(result).toMatchObject({
        defaultSite: 'test',
      });
      expect(session.diagnostics()).toMatchObject({
        address: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u),
      });
    } finally {
      await session.close();
    }
  });
});
