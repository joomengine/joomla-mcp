import { describe, expect, it, vi } from 'vitest';

import { JoomlaService } from '../src/application/joomla-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { Configuration } from '../src/config/schema.js';
import type { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';
import type { JoomlaCliClient } from '../src/infrastructure/cli/joomla-cli-client.js';

const configuration: Configuration = {
  defaultSite: 'test',
  sites: new Map([
    [
      'test',
      {
        id: 'test',
        toolsets: new Set(['discovery', 'content.read', 'content.write', 'structure.read', 'configuration.read']),
        api: {
          baseUrl: 'https://example.test',
          tokenEnv: 'TOKEN',
          token: 'secret',
          timeoutMs: 30_000,
          maxResponseBytes: 1_000_000,
          maxPageSize: 50,
        },
      },
    ],
  ]),
};

describe('semantic Joomla read actions', () => {
  it('searches only actions allowed by the selected site toolsets', async () => {
    const service = new JoomlaService(new SiteRegistry(configuration));
    const result = await service.searchReadActions({ text: 'menu' });

    expect(result['count']).toBeTypeOf('number');
    expect(JSON.stringify(result)).toContain('menus.site.list');
    expect(JSON.stringify(result)).not.toContain('users.users.list');
    expect((await service.searchReadActions({ text: 'scheduler' }))['count']).toBe(0);
  });

  it('reports executable transports and keeps a source-only blocked endpoint out of enabled search', async () => {
    const service = new JoomlaService(new SiteRegistry(configuration));

    expect(await service.describeAction('content.articles.create')).toMatchObject({
      availability: { executable: true, transports: ['api'], blockedReason: null },
    });
    expect(await service.describeAction('configuration.component.get')).toMatchObject({
      availability: { executable: false, transports: [] },
    });
    const configurationSearch = await service.searchReadActions({
      text: 'component configuration',
      includeSensitive: true,
    });
    expect(JSON.stringify(configurationSearch)).not.toContain('configuration.component.get');
  });

  it('advertises only fixed companion implementations on a CLI-only site', async () => {
    const cliOnly: Configuration = {
      defaultSite: 'local',
      sites: new Map([['local', {
        id: 'local',
        toolsets: new Set(['discovery', 'content.read', 'content.write', 'extensions.read', 'cli.discovery']),
        cli: {
          root: '/srv/joomla',
          phpBinary: '/usr/bin/php',
          timeoutMs: 30_000,
          maxOutputBytes: 1_000_000,
        },
      }]]),
    };
    const cli = {
      describe: vi.fn(async () => ({
        command: ['/usr/bin/php'],
        exitCode: 0,
        stdout: '{}',
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
        data: {
          protocol: 'joomla-mcp/1',
          actions: [
            { name: 'content.articles.list', effective: { allowed: true } },
            { name: 'content.articles.get', effective: { allowed: true } },
          ],
        },
      })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaService(new SiteRegistry(cliOnly), undefined, cli);
    const content = await service.searchReadActions({ text: 'articles' });
    const extensions = await service.searchReadActions({ text: 'installed extensions' });

    expect(content).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ id: 'content.articles.list', availableTransports: ['cli'] }),
      ]),
    });
    expect(JSON.stringify(extensions)).not.toContain('extensions.installed.list');
  });

  it('resolves an action identifier to its fixed route and bounded query', async () => {
    const api = {
      request: vi.fn(async () => ({ status: 200, headers: {}, data: { data: [] } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaService(new SiteRegistry(configuration), api);

    await service.executeReadAction({
      action: 'menus.site-items.list',
      input: { offset: 5, limit: 10 },
    });

    expect(api.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'GET',
        path: 'v1/menus/site/items',
        query: { 'page[offset]': 5, 'page[limit]': 10 },
      }),
    );
  });

  it('does not expose raw component configuration', async () => {
    const service = new JoomlaService(new SiteRegistry(configuration));

    await expect(
      service.executeReadAction({ action: 'configuration.component.get', input: { component: 'com_users' } }),
    ).rejects.toThrow('secrets');
  });
});
