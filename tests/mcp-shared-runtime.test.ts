import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { JoomlaService } from '../src/application/joomla-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import type { AuditSink } from '../src/audit/audit-sink.js';
import type { Configuration } from '../src/config/schema.js';
import type { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';
import { createServer, type JoomlaMcpRuntime } from '../src/mcp/create-server.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([['test', {
    id: 'test',
    toolsets: new Set(['discovery', 'content.write']),
    api: {
      baseUrl: 'https://example.test',
      tokenEnv: 'TOKEN',
      token: 'secret',
      timeoutMs: 30_000,
      maxResponseBytes: 1_000_000,
      maxPageSize: 50,
    },
  }]]),
};

describe('shared MCP HTTP runtime', () => {
  it('shares confirmation, locking, and idempotency state across MCP server sessions', async () => {
    const sites = new SiteRegistry(configuration);
    const api = {
      request: vi.fn(async () => ({
        status: 201,
        headers: {},
        data: { data: { id: '41' } },
      })),
      get: vi.fn(async () => ({
        status: 200,
        headers: {},
        data: { data: { id: '41', attributes: { title: 'Shared runtime', catid: 2 } } },
      })),
    } as unknown as JoomlaApiClient;
    const audit: AuditSink = { write: vi.fn() };
    const runtime: JoomlaMcpRuntime = {
      sites,
      audit,
      service: new JoomlaService(sites, api, undefined, audit),
      writes: new JoomlaWriteService(configuration, sites, api, audit),
    };
    const first = await connect(createServer(configuration, runtime), 'planner');
    const second = await connect(createServer(configuration, runtime), 'applier');

    try {
      const requested = await first.client.callTool({
        name: 'joomla_permission_request',
        arguments: {
          toolsets: ['content.write'],
          duration: 'once',
          reason: 'Create the shared-runtime test article.',
        },
      });
      const request = asRecord(requested.structuredContent);
      const approved = await second.client.callTool({
        name: 'joomla_permission_approve',
        arguments: {
          requestId: request['requestId'],
          acknowledgement: request['acknowledgement'],
        },
      });
      expect(asRecord(approved.structuredContent)['duration']).toBe('once');
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
        event: 'permission.requested',
        permissionRequestId: request['requestId'],
      }));
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({
        event: 'permission.approved',
        permissionRequestId: request['requestId'],
      }));
      expect(JSON.stringify(vi.mocked(audit.write).mock.calls)).not.toContain(request['acknowledgement']);

      const planned = await first.client.callTool({
        name: 'joomla_action_write_plan',
        arguments: {
          action: 'content.articles.create',
          input: { data: { title: 'Shared runtime', catid: 2 } },
          transport: 'api',
          idempotencyKey: randomUUID(),
          dryRun: false,
        },
      });
      const token = asRecord(planned.structuredContent)['confirmationToken'];
      expect(token).toBeTypeOf('string');

      const applied = await second.client.callTool({
        name: 'joomla_write_apply',
        arguments: { confirmationToken: token },
      });
      expect(applied.structuredContent).toMatchObject({
        action: 'content.articles.create',
        idempotentReplay: false,
      });
      const replay = await first.client.callTool({
        name: 'joomla_write_apply',
        arguments: { confirmationToken: token },
      });
      expect(replay).toMatchObject({ isError: true });
      expect(JSON.stringify(replay)).toContain('already been used');
      expect(api.request).toHaveBeenCalledOnce();
    } finally {
      await first.client.close();
      await first.server.close();
      await second.client.close();
      await second.server.close();
    }
  });
});

async function connect(server: ReturnType<typeof createServer>, name: string) {
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
