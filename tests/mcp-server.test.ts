import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { Configuration } from '../src/config/schema.js';
import { createServer } from '../src/mcp/create-server.js';

describe('MCP server', () => {
  it('completes initialization and publishes the intended multiplexed Joomla tools', async () => {
    const configuration: Configuration = {
      defaultSite: 'test',
      sites: new Map([
        [
          'test',
          {
            id: 'test',
            toolsets: new Set([
              'discovery',
              'content.read',
              'extensions.read',
              'configuration.read',
              'cli.discovery',
            ]),
            api: {
              baseUrl: 'https://example.test',
              tokenEnv: 'TOKEN',
              token: 'secret',
              timeoutMs: 30_000,
              maxResponseBytes: 1_000_000,
              maxPageSize: 100,
            },
            cli: {
              root: '/tmp',
              phpBinary: process.execPath,
              timeoutMs: 30_000,
              maxOutputBytes: 1_000_000,
            },
          },
        ],
      ]),
    };
    const server = createServer(configuration);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'joomla_action_describe',
        'joomla_action_read',
        'joomla_action_write_plan',
        'joomla_actions_search',
        'joomla_application_config_get_safe',
        'joomla_capabilities',
        'joomla_cli_command_help',
        'joomla_cli_commands_list',
        'joomla_cli_inventory',
        'joomla_cli_targets',
        'joomla_companion_action_read',
        'joomla_companion_capabilities',
        'joomla_content_article_create_plan',
        'joomla_content_article_delete_plan',
        'joomla_content_article_get',
        'joomla_content_article_update_plan',
        'joomla_content_articles_list',
        'joomla_extensions_list',
        'joomla_permission_approve',
        'joomla_permission_request',
        'joomla_permission_revoke',
        'joomla_permissions_list',
        'joomla_sites_list',
        'joomla_write_apply',
      ]);
      expect(tools.tools.find((tool) => tool.name === 'joomla_action_read')?.annotations?.readOnlyHint).toBe(false);
      expect(tools.tools.find((tool) => tool.name === 'joomla_write_apply')?.annotations).toMatchObject({
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(tools.tools.find((tool) => tool.name === 'joomla_permission_approve')?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(JSON.stringify(tools)).not.toContain('downstream-secret');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
