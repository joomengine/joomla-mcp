import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { expect, it, vi } from 'vitest';

import type { Configuration } from '../src/config/schema.js';
import { createRuntime, createServer } from '../src/mcp/create-server.js';

it('discloses JCB routes only under the selected site and scopes, then executes the described nested read', async () => {
  const configuration: Configuration = {
    defaultSite: 'builder',
    approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
    sites: new Map([['builder', {
      id: 'builder',
      toolsets: new Set(['discovery', 'jcb.read', 'jcb.write']),
      api: {
        baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'fixture',
        timeoutMs: 1000, maxResponseBytes: 1_000_000, maxPageSize: 20,
      },
    }]]),
  };
  const api = {
    get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: [] } })),
    request: vi.fn(async () => { throw new Error('Unexpected write'); }),
  };
  const runtime = createRuntime(configuration, { api });
  const client = new Client({ name: 'jcb-discovery-test', version: '1.0.0' });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  const authInfo: AuthInfo = { token: 'fixture', clientId: 'client', scopes: ['joomla:site:builder', 'joomla:toolset:discovery'] };
  const send = outbound.send.bind(outbound);
  outbound.send = (message, options) => send(message, { ...options, authInfo });
  const server = createServer(configuration, runtime);
  await server.connect(inbound);
  await client.connect(outbound);
  const search = () => client.callTool({name: 'joomla_actions_search', arguments: {
    domain: 'jcb', text: 'jcb.api.languages.', includeWrites: true,
  }});
  const read = () => client.callTool({name: 'joomla_action_read', arguments: {
    action: 'jcb.api.languages.list', input: { filter: { search: 'German' }, limit: 2 },
  }});
  try {
    expect((await search()).structuredContent).toMatchObject({ actions: [] });
    expect((await read()).isError).toBe(true);
    expect(api.get).not.toHaveBeenCalled();

    authInfo.scopes.push('joomla:toolset:jcb.read');
    expect((await search()).structuredContent).toMatchObject({ count: 2 });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect((await search()).structuredContent).toMatchObject({ count: 2 });
    expect(api.get).toHaveBeenCalledTimes(1);

    authInfo.scopes.push('joomla:toolset:jcb.write');
    expect((await search()).structuredContent).toMatchObject({ count: 5 });
    expect((await read()).structuredContent).toMatchObject({ status: 200, data: { data: [] } });
    expect(api.get).toHaveBeenLastCalledWith(configuration.sites.get('builder')!.api,
      'v1/componentbuilder/languages', expect.objectContaining({ 'filter[search]': 'German', 'page[limit]': 2 }));

    api.get.mockRejectedValueOnce(new Error('Plugin is disabled'));
    const absent = await client.callTool({name: 'joomla_actions_search', arguments: {
      domain: 'jcb', text: 'jcb.api.joomla_components.',
    }});
    expect(absent.structuredContent).toMatchObject({ count: 0, actions: [] });
    expect(api.request).not.toHaveBeenCalled();

    // A grant belongs to the exact issuer, subject and client tuple.
    authInfo.scopes.push('joomla:permissions:grant');
    authInfo.extra = { issuer: 'https://issuer.test', subject: 'dept:editor' };
    authInfo.clientId = 'local';
    const permission = await client.callTool({ name: 'joomla_permission_request', arguments: {
      site: 'builder', toolsets: ['jcb.write'], duration: 'once', reason: 'Verify grant ownership.',
    }});
    const { requestId, acknowledgement } = permission.structuredContent!;
    const approve = () => client.callTool({ name: 'joomla_permission_approve', arguments: { requestId, acknowledgement } });
    authInfo.extra.subject = 'dept';
    authInfo.clientId = 'editor:local';
    expect((await approve()).isError).toBe(true);
    authInfo.extra.subject = 'dept:editor';
    authInfo.clientId = 'local';
    expect((await approve()).isError).toBeFalsy();
  } finally {
    await client.close();
    await server.close();
  }
});
