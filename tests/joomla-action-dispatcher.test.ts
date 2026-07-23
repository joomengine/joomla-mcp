import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JoomlaService } from '../src/application/joomla-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { resolveJoomlaWriteRequest } from '../src/catalog/action-catalog.js';
import { getJoomlaWriteAction } from '../src/catalog/action-catalog.js';
import { getCompanionWriteAction } from '../src/catalog/companion-actions.js';
import type { Configuration } from '../src/config/schema.js';
import type { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';
import type { JoomlaCliClient } from '../src/infrastructure/cli/joomla-cli-client.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([
    ['test', {
      id: 'test',
      toolsets: new Set([
        'discovery', 'content.read', 'content.write', 'structure.read', 'structure.write',
        'users.read', 'users.admin', 'maintenance.read', 'maintenance.admin', 'cli.discovery',
        'media.read', 'media.write', 'extensions.read', 'extensions.admin',
        'configuration.read', 'configuration.write', 'core-update',
      ]),
      api: {
        baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
        maxResponseBytes: 1_000_000, maxPageSize: 50, updateToken: 'update-secret',
      },
      cli: { root: '/srv/joomla', phpBinary: '/usr/bin/php', timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
    }],
  ]),
};

const envelope = (data: unknown) => ({
  command: ['/usr/bin/php'], exitCode: 0, stdout: '{}', stderr: '', durationMs: 1,
  timedOut: false, truncated: false, data,
});

describe('generalized Joomla action dispatcher', () => {
  it('searches enabled reads and writes without exposing fixed route templates', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1',
        actions: ['list', 'get', 'create', 'update', 'delete'].map((operation) => ({
          name: `banners.banners.${operation}`,
          effective: { allowed: true },
        })),
      })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaService(new SiteRegistry(configuration), undefined, cli);
    const result = await service.searchReadActions({ domain: 'banners', includeWrites: true });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain('banners.banners.list');
    expect(serialized).toContain('banners.banners.create');
    expect(result).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({ id: 'banners.banners.create', availableTransports: ['api', 'cli'] }),
      ]),
    });
    expect(serialized).not.toContain('v1/banners');
  });

  it('keeps source-registered Joomla route defects catalogued but non-executable', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1', actions: [] })),
    } as unknown as JoomlaCliClient;
    const readService = new JoomlaService(new SiteRegistry(configuration), undefined, cli);
    const writes = new JoomlaWriteService(configuration, new SiteRegistry(configuration));
    const result = await readService.describeAction('languages.packages.install');

    expect(result).toMatchObject({
      availability: {
        executable: false,
        transports: [],
        blockedReason: expect.stringContaining('has no install task'),
      },
    });
    expect(JSON.stringify(await readService.searchReadActions({
      text: 'language package',
      includeWrites: true,
    }))).not.toContain('languages.packages.install');
    await expect(writes.planAction({
      action: 'languages.overrides.site.update',
      input: { language: 'en-GB', constant: 'COM_EXAMPLE', data: { override: 'Example' } },
      transport: 'api',
      idempotencyKey: randomUUID(),
    })).rejects.toThrow('source-catalogued but not executable');
  });

  it.each([
    ['content.articles.list', { offset: 4, limit: 8 }, 'v1/content/articles', { 'page[offset]': 4, 'page[limit]': 8 }],
    ['banners.banners.get', { id: 9 }, 'v1/banners/9', {}],
    ['users.users.list', { limit: 10 }, 'v1/users', { 'page[offset]': 0, 'page[limit]': 10 }],
    ['menus.site-items.get', { id: 12 }, 'v1/menus/site/items/12', {}],
    ['tags.tags.list', {}, 'v1/tags', { 'page[offset]': 0, 'page[limit]': 20 }],
  ])('executes %s over the fixed API route', async (action, input, path, query) => {
    const api = { request: vi.fn(async () => ({ status: 200, headers: {}, data: { data: [] } })) } as unknown as JoomlaApiClient;
    const service = new JoomlaService(new SiteRegistry(configuration), api);

    await service.executeReadAction({ action, input, transport: 'api' });

    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'GET', path, query }));
  });

  it('preflights the companion catalogue and effective ACL before CLI dispatch', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1',
        actions: [{ name: 'banners.banners.list', effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1', ok: true, result: [] })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaService(new SiteRegistry(configuration), undefined, cli);

    await service.executeReadAction({ action: 'banners.banners.list', input: { limit: 5 }, transport: 'cli' });

    expect(cli.describe).toHaveBeenCalledOnce();
    expect(cli.dispatch).toHaveBeenCalledWith(expect.anything(), 'banners.banners.list', { limit: 5 });
  });

  it('executes a companion-only native status read through the generic action tool', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1', actions: [{ name: 'scheduler.tasks.list', effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1', ok: true, result: { items: [] } })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaService(new SiteRegistry(configuration), undefined, cli);

    await service.executeReadAction({
      action: 'scheduler.tasks.list', input: { limit: 5 }, transport: 'auto',
    });

    expect(cli.dispatch).toHaveBeenCalledWith(expect.anything(), 'scheduler.tasks.list', {
      offset: 0, limit: 5,
    });
    await expect(service.executeReadAction({
      action: 'scheduler.tasks.list', transport: 'api',
    })).rejects.toThrow('only through the local companion');
  });

  it.each([
    [[], 'does not advertise'],
    [[{ name: 'users.users.list', effective: { allowed: false } }], 'denies action'],
  ])('rejects an unavailable or denied CLI action', async (actions, message) => {
    const cli = {
      describe: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1', actions })),
      dispatch: vi.fn(),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaService(new SiteRegistry(configuration), undefined, cli);

    await expect(service.executeReadAction({ action: 'users.users.list', transport: 'cli' })).rejects.toThrow(message);
    expect(cli.dispatch).not.toHaveBeenCalled();
  });

  it('never permits the raw component configuration action on either transport', async () => {
    const service = new JoomlaService(new SiteRegistry(configuration));
    await expect(service.executeReadAction({
      action: 'configuration.component.get', input: { component: 'com_users' }, transport: 'cli',
    })).rejects.toThrow('secrets');
  });
});

describe('generalized Joomla guarded writes', () => {
  it.each([
    ['content.articles.create', { data: { title: 'Article', catid: 2 } }, 'POST', 'v1/content/articles'],
    ['banners.banners.update', { id: 7, data: { name: 'Campaign', state: 1 } }, 'PATCH', 'v1/banners/7'],
    ['users.users.delete', { id: 19, etag: '"user-19"' }, 'DELETE', 'v1/users/19'],
    ['fields.contact.create', { data: { title: 'Office', type: 'text' } }, 'POST', 'v1/fields/contacts/contact'],
  ])('plans and applies %s through the API', async (action, input, method, path) => {
    const api = {
      request: vi.fn(async () => ({ status: method === 'POST' ? 201 : 200, headers: {}, data: { data: { id: '23' } } })),
      get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '23' } } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    await grant(service, action);
    const plan = await service.planAction({
      action, input, transport: 'api', idempotencyKey: randomUUID(),
    });

    expect('confirmationToken' in plan).toBe(true);
    await service.apply('confirmationToken' in plan ? plan.confirmationToken : '');

    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method, path }));
    if (method === 'DELETE') expect(api.get).not.toHaveBeenCalled();
  });

  it('supports a no-token dry run and reports the resolved transport and action', async () => {
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration));
    const preview = await service.planAction({
      action: 'banners.clients.create', input: { data: { name: 'VDM' } }, transport: 'api',
      idempotencyKey: randomUUID(), dryRun: true,
    });

    expect(preview).toMatchObject({
      dryRun: true,
      confirmationRequired: true,
      operation: { action: 'banners.clients.create', method: 'POST', transport: 'api' },
    });
    expect(preview).not.toHaveProperty('confirmationToken');
  });

  it('preflights and applies a write using the CLI companion transport', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1', actions: [{ name: 'users.users.update', effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async (_cli, _action, input: Readonly<Record<string, unknown>>) => envelope({
        protocol: 'joomla-mcp/1',
        ok: true,
        result: input['dryRun'] === true
          ? { id: 3, applied: false, dryRun: true }
          : { id: 3, applied: true, dryRun: false },
      })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaWriteService(
      configuration, new SiteRegistry(configuration), undefined, undefined, cli,
    );
    await grant(service, 'users.users.update');
    const plan = await service.planAction({
      action: 'users.users.update', input: { id: 3, data: { name: 'Editor' } }, transport: 'cli',
      idempotencyKey: randomUUID(),
    });

    expect(plan.operation).toMatchObject({
      preflight: { id: 3, applied: false, dryRun: true },
    });
    await service.apply('confirmationToken' in plan ? plan.confirmationToken : '');

    expect(cli.describe).toHaveBeenCalledTimes(2);
    expect(cli.dispatch).toHaveBeenNthCalledWith(1, expect.anything(), 'users.users.update', {
      id: 3, data: { name: 'Editor' }, dryRun: true,
    });
    expect(cli.dispatch).toHaveBeenNthCalledWith(2, expect.anything(), 'users.users.update', {
      id: 3, data: { name: 'Editor' }, dryRun: true,
    });
    expect(cli.dispatch).toHaveBeenNthCalledWith(3, expect.anything(), 'users.users.update', {
      id: 3, data: { name: 'Editor' }, dryRun: false, _edgeConfirmed: true,
    });
  });

  it.each([
    ['cache.clean', { groups: ['com_content'] }],
    ['content.articles.state', { id: 9, state: 0 }],
    ['scheduler.tasks.run', { id: 4 }],
    ['site.state.set', { offline: true }],
  ])('plans and applies native companion operation %s', async (action, input) => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1', actions: [{ name: action, effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async (_cli, _action, dispatchInput: Readonly<Record<string, unknown>>) => envelope({
        protocol: 'joomla-mcp/1',
        ok: true,
        result: dispatchInput['dryRun'] === true
          ? { applied: false, dryRun: true }
          : { applied: true, dryRun: false },
      })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaWriteService(
      configuration, new SiteRegistry(configuration), undefined, undefined, cli,
    );
    await grant(service, action);
    const plan = await service.planAction({
      action, input, transport: 'cli', idempotencyKey: randomUUID(),
    });

    await service.apply('confirmationToken' in plan ? plan.confirmationToken : '');

    expect(cli.dispatch).toHaveBeenNthCalledWith(1, expect.anything(), action, {
      ...input, dryRun: true,
    });
    expect(cli.dispatch).toHaveBeenNthCalledWith(2, expect.anything(), action, {
      ...input, dryRun: true,
    });
    expect(cli.dispatch).toHaveBeenNthCalledWith(3, expect.anything(), action, {
      ...input, dryRun: false, _edgeConfirmed: true,
    });
  });

  it('fails closed when the companion returns a preview instead of proof of application', async () => {
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1', actions: [{ name: 'banners.banners.delete', effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async (_cli, _action, dispatchInput: Readonly<Record<string, unknown>>) => envelope({
        protocol: 'joomla-mcp/1',
        ok: true,
        result: dispatchInput['dryRun'] === true
          ? { applied: false, dryRun: true }
          : { applied: false, dryRun: false },
      })),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), undefined, undefined, cli);
    await grant(service, 'banners.banners.delete');
    const plan = await service.planAction({
      action: 'banners.banners.delete', input: { id: 8 }, transport: 'cli', idempotencyKey: randomUUID(),
    });

    await expect(service.apply('confirmationToken' in plan ? plan.confirmationToken : '')).rejects
      .toThrow('did not prove');
  });

  it('rejects a CLI write when Joomla native preconditions change after planning', async () => {
    let preflightCalls = 0;
    const cli = {
      describe: vi.fn(async () => envelope({
        protocol: 'joomla-mcp/1',
        actions: [{ name: 'site.state.set', effective: { allowed: true } }],
      })),
      dispatch: vi.fn(async (_cli, _action, dispatchInput: Readonly<Record<string, unknown>>) => {
        if (dispatchInput['dryRun'] === true) {
          preflightCalls += 1;
          return envelope({
            protocol: 'joomla-mcp/1',
            ok: true,
            result: {
              applied: false,
              dryRun: true,
              requestedState: { offline: true },
              preState: { offline: preflightCalls > 1 },
            },
          });
        }
        return envelope({ protocol: 'joomla-mcp/1', ok: true, result: { applied: true, dryRun: false } });
      }),
    } as unknown as JoomlaCliClient;
    const service = new JoomlaWriteService(
      configuration,
      new SiteRegistry(configuration),
      undefined,
      undefined,
      cli,
    );
    await grant(service, 'site.state.set');
    const plan = await service.planAction({
      action: 'site.state.set',
      input: { offline: true },
      transport: 'cli',
      idempotencyKey: randomUUID(),
    });

    await expect(service.apply('confirmationToken' in plan ? plan.confirmationToken : ''))
      .rejects.toThrow('preconditions changed');
    expect(cli.dispatch).toHaveBeenCalledTimes(2);
  });

  it('rejects non-allowlisted routes, fields, unsafe values, and invalid preconditions', () => {
    expect(() => resolveJoomlaWriteRequest('shell.run', {})).toThrow('Unknown Joomla write action');
    expect(() => resolveJoomlaWriteRequest('banners.banners.update', {
      id: 3, data: { name: 'x' }, url: 'https://attacker.invalid',
    })).toThrow('Unsupported action input');
    expect(() => resolveJoomlaWriteRequest('banners.banners.update', {
      id: '../configuration.php', data: { name: 'x' },
    })).toThrow('positive integer');
    expect(() => resolveJoomlaWriteRequest('users.users.update', {
      id: 2, data: JSON.parse('{"__proto__":{"admin":true}}'),
    })).toThrow('Unsafe Joomla mutation field');
    expect(() => resolveJoomlaWriteRequest('users.users.update', {
      id: 2, data: { name: 'x' }, etag: 'line\r\nbreak',
    })).toThrow('Invalid ETag');
    expect(() => resolveJoomlaWriteRequest('content.articles.create', {
      data: { articletext: 'x'.repeat(1_048_577) },
    })).toThrow('1048576-byte limit');
    expect(() => resolveJoomlaWriteRequest('content.articles.create', {
      data: { title: 'Allowed', catid: 2, arbitrary_model_field: 'blocked' },
    })).toThrow('Unsupported content.articles.create data properties');
  });

  it('uses Joomla Update authentication for every update lifecycle write', async () => {
    const api = {
      request: vi.fn(async () => ({ status: 200, headers: {}, data: { success: true } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    await grant(service, 'joomla-update.prepare');
    const plan = await service.planAction({
      action: 'joomla-update.prepare',
      input: { data: { targetVersion: '6.1.3' } },
      transport: 'api',
      idempotencyKey: randomUUID(),
    });

    await service.apply('confirmationToken' in plan ? plan.confirmationToken : '');

    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      method: 'POST',
      path: 'v1/joomlaupdate/prepareUpdate',
      authentication: 'joomla-update-token',
      body: { targetVersion: '6.1.3' },
    }));
  });

  it('checks the write toolset before producing a confirmation', async () => {
    const restricted: Configuration = {
      ...configuration,
      sites: new Map([['test', { ...configuration.sites.get('test')!, toolsets: new Set(['users.read']) }]]),
    };
    const service = new JoomlaWriteService(restricted, new SiteRegistry(restricted));

    await expect(service.planAction({
      action: 'users.users.delete', input: { id: 4 }, idempotencyKey: randomUUID(), dryRun: true,
    })).rejects.toThrow('users.admin is disabled');
  });
});

async function grant(service: JoomlaWriteService, actionId: string): Promise<void> {
  const action = getJoomlaWriteAction(actionId) ?? getCompanionWriteAction(actionId);

  if (action === undefined) {
    throw new Error(`Test action ${actionId} is not catalogued.`);
  }

  const request = await service.requestPermission({
    toolsets: [action.toolset as Parameters<JoomlaWriteService['requestPermission']>[0]['toolsets'][number]],
    duration: 'once',
    reason: `Exercise ${actionId} in the guarded-write test.`,
  });
  await service.approvePermission(request.requestId, request.acknowledgement);
}
