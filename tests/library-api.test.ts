import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import {
  JOOMLA_MCP_PACKAGE_NAME,
  JOOMLA_MCP_VERSION,
  createJoomlaMcp,
  createRuntime,
  type Configuration,
} from '../src/index.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: {
    secret: 'a-secret-that-is-at-least-32-bytes-long',
    ttlMs: 60_000,
  },
  sites: new Map([['test', {
    id: 'test',
    toolsets: new Set(['discovery', 'content.write']),
    api: {
      baseUrl: 'https://example.test',
      tokenEnv: 'TOKEN',
      token: 'not-used',
      timeoutMs: 30_000,
      maxResponseBytes: 1_000_000,
      maxPageSize: 100,
    },
  }]]),
};

describe('embeddable library API', () => {
  it('exports synchronized package identity', () => {
    expect(JOOMLA_MCP_PACKAGE_NAME).toBe('@joomengine/joomla-mcp');
    expect(JOOMLA_MCP_VERSION).toBe('0.6.0');
  });

  it('creates fresh protocol servers over one explicitly shared runtime', async () => {
    const runtime = createRuntime(configuration, {
      audit: { write: () => undefined },
    });
    const planner = createJoomlaMcp({
      configuration,
      runtime,
      server: { localPrincipal: 'host:planner' },
    });
    const otherPrincipal = createJoomlaMcp({
      configuration,
      runtime,
      server: { localPrincipal: 'host:other' },
    });
    const first = await connect(planner.createServer(), 'planner');
    const second = await connect(otherPrincipal.createServer(), 'other');

    try {
      const requested = await first.client.callTool({
        name: 'joomla_permission_request',
        arguments: {
          toolsets: ['content.write'],
          duration: 'once',
          reason: 'Validate the embeddable package identity boundary.',
        },
      });
      const request = asRecord(requested.structuredContent);
      const denied = await second.client.callTool({
        name: 'joomla_permission_approve',
        arguments: {
          requestId: request['requestId'],
          acknowledgement: request['acknowledgement'],
        },
      });
      expect(denied).toMatchObject({ isError: true });
      expect(JSON.stringify(denied)).toContain('another authenticated principal');

      const approved = await first.client.callTool({
        name: 'joomla_permission_approve',
        arguments: {
          requestId: request['requestId'],
          acknowledgement: request['acknowledgement'],
        },
      });
      expect(approved.structuredContent).toMatchObject({
        duration: 'once',
        site: 'test',
      });
    } finally {
      await first.client.close();
      await first.server.close();
      await second.client.close();
      await second.server.close();
    }
  });
});

async function connect(server: ReturnType<ReturnType<typeof createJoomlaMcp>['createServer']>, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}
