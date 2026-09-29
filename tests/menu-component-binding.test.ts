import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JoomlaService } from '../src/application/joomla-service.js';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { ApiConfig, Configuration } from '../src/config/schema.js';
import type { JoomlaApiRequest, JoomlaApiResponse } from '../src/infrastructure/api/joomla-api-client.js';
import type { CompanionEnvelope, JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';
import type { ConfirmationPlan } from '../src/security/confirmation-service.js';

type Client = 'site' | 'administrator';
type Operation = 'create' | 'update';
type MenuRow = { id: string; attributes: Record<string, unknown> };
type Query = NonNullable<JoomlaApiRequest['query']>;

function configuration(maxPageSize = 100): Configuration {
  return {
    defaultSite: 'test',
    approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
    sites: new Map([['test', {
      id: 'test',
      toolsets: new Set(['structure.read', 'structure.write', 'cli.discovery']),
      api: {
        baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
        maxResponseBytes: 1_000_000, maxPageSize,
      },
      cli: { root: '/srv/joomla', phpBinary: '/usr/bin/php', timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
    }]]),
  };
}

const contentLink = 'index.php?option=com_content&view=article&id=42';
const contactLink = 'index.php?option=com_contact&view=contact&id=8';
const extensionIds = new Map([['com_content', 22], ['com_contact', 47], ['com_cpanel', 7]]);

interface StorageOptions {
  readonly initial?: Readonly<Record<string, unknown>>;
  readonly derivedId?: unknown;
  readonly itemOverride?: Readonly<Record<string, unknown>>;
  readonly failInitial?: boolean;
  readonly failRepair?: boolean;
  readonly ignoreRepair?: boolean;
  readonly failList?: boolean;
  readonly omitMutationId?: boolean;
  readonly itemEtag?: string;
  readonly itemId?: string;
  readonly list?: (row: MenuRow, query: Query) => unknown;
}

/** Native item reads derive an ID from link and can conceal a zero stored in #__menu. */
function menuStorage(client: Client, options: StorageOptions = {}) {
  const path = `v1/menus/${client}/items`;
  let stored: Record<string, unknown> = {
    title: 'Existing menu item', menutype: 'mainmenu', type: 'component', parent_id: 1,
    link: contentLink, params: { custom_setting: 'preserved' }, component_id: 0,
    client_id: client === 'site' ? 0 : 1, ...options.initial,
  };
  let writes = 0;
  const persisted = (): MenuRow => ({ id: '132', attributes: structuredClone(stored) });
  const loaded = (): MenuRow => {
    const row = persisted();
    if (options.itemId !== undefined) row.id = options.itemId;
    if (row.attributes['type'] === 'component') {
      const option = new URL(String(row.attributes['link']), 'https://joomla.invalid/').searchParams.get('option');
      row.attributes['component_id'] = Object.hasOwn(options, 'derivedId')
        ? options.derivedId
        : extensionIds.get(option ?? '') ?? 0;
    }
    Object.assign(row.attributes, options.itemOverride ?? {});
    return row;
  };
  const response = (data: unknown, status = 200): JoomlaApiResponse => ({ status, headers: {}, data });
  const api = {
    request: vi.fn(async (_config: ApiConfig, request: JoomlaApiRequest): Promise<JoomlaApiResponse> => {
      if (request.path !== path && request.path !== `${path}/132`) throw new Error(`Unexpected mutation route: ${request.path}`);
      writes++;
      const repair = writes > 1;
      if (repair && options.failRepair) throw new Error('Repair permission denied by Joomla.');
      if (!(repair && options.ignoreRepair)) {
        if (request.method === 'POST') stored = { component_id: 0 };
        for (const [key, value] of Object.entries(request.body ?? {})) {
          if (key !== 'request') stored[key] = structuredClone(value);
        }
      }
      // A connection may fail after the server committed its write.
      if (!repair && options.failInitial) throw new Error('Connection lost after request was sent.');
      return response({ data: options.omitMutationId ? { attributes: { title: stored['title'] } } : { id: '132' } },
        request.method === 'POST' ? 201 : 200);
    }),
    get: vi.fn(async (_config: ApiConfig, requestedPath: string, query: Query = {}): Promise<JoomlaApiResponse> => {
      if (requestedPath === `${path}/132`) return {
        ...response({ data: loaded() }), headers: options.itemEtag === undefined ? {} : { etag: options.itemEtag },
      };
      if (requestedPath === path) {
        if (options.failList) throw new Error('Stored menu list is unavailable.');
        return response(options.list?.(persisted(), query) ?? { data: [persisted()] });
      }
      throw new Error(`Unexpected read route: ${requestedPath}`);
    }),
  };
  return { api, persisted, loaded, path };
}

function harness(client: Client = 'site', options: StorageOptions = {}, maxPageSize = 100) {
  const config = configuration(maxPageSize);
  const storage = menuStorage(client, options);
  const service = new JoomlaWriteService(config, new SiteRegistry(config), storage.api);
  return { ...storage, service, config };
}

async function grant(service: JoomlaWriteService): Promise<void> {
  const request = await service.requestPermission({
    toolsets: ['structure.write'], duration: '30-minutes', reason: 'Verify native menu component binding.',
  });
  await service.approvePermission(request.requestId, request.acknowledgement);
}

function dataFor(operation: Operation, data: Readonly<Record<string, unknown>> = {}) {
  return operation === 'create'
    ? { menutype: 'mainmenu', title: 'Created menu item', type: 'component', parent_id: 1, link: contentLink, ...data }
    : { title: 'Renamed menu item', ...data };
}

async function plan(
  service: JoomlaWriteService,
  client: Client,
  operation: Operation,
  data: Readonly<Record<string, unknown>> = {},
  idempotencyKey = randomUUID(),
): Promise<ConfirmationPlan> {
  const result = await service.planAction({
    action: `menus.${client}-items.${operation}`,
    input: { ...(operation === 'update' ? { id: 132 } : {}), data: dataFor(operation, data) },
    transport: 'api', idempotencyKey,
  });
  if (!('confirmationToken' in result)) throw new Error('Expected an executable confirmation plan.');
  return result;
}

describe.each(['site', 'administrator'] as const)('%s menu component binding', (client) => {
  it.each(['create', 'update'] as const)('persists the native component ID for %s and verifies the stored row', async (operation) => {
    const { service, api, path, persisted } = harness(client);
    await grant(service);
    const planned = await plan(service, client, operation);
    expect(api.request).not.toHaveBeenCalled();
    const result = await service.apply(planned.confirmationToken);

    expect(result).toMatchObject({ outcome: 'verified', idempotentReplay: false,
      verification: { postcondition: 'verified', id: 132, expectedComponentId: 22, storedComponentId: 22 } });
    expect(persisted().attributes).toMatchObject({ component_id: 22, client_id: client === 'site' ? 0 : 1 });
    expect(api.request).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      method: operation === 'create' ? 'POST' : 'PATCH', path: operation === 'create' ? path : `${path}/132`,
      body: expect.objectContaining({ component_id: 0, request: { option: 'com_content', view: 'article', id: '42' } }),
    }));
    expect(api.request).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      method: 'PATCH', path: `${path}/132`,
      body: expect.objectContaining({ component_id: 22, type: 'component', link: contentLink,
        menutype: 'mainmenu', parent_id: 1, client_id: client === 'site' ? 0 : 1 }),
    }));
    const primaryKey = api.request.mock.calls[0]![1].idempotencyKey;
    const repairKey = api.request.mock.calls[1]![1].idempotencyKey;
    expect(repairKey).not.toBe(primaryKey);
    expect(repairKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(api.get).toHaveBeenCalledWith(expect.anything(), path, expect.objectContaining({
      'page[offset]': 0, 'page[limit]': 100,
    }));
  });

  it('resolves the new component after a cross-component update instead of retaining the old ID', async () => {
    const { service, api, persisted } = harness(client, { initial: { component_id: 22 } });
    await grant(service);
    const planned = await plan(service, client, 'update', { link: contactLink });
    const result = await service.apply(planned.confirmationToken);

    expect(result).toMatchObject({ outcome: 'verified', verification: { expectedComponentId: 47, storedComponentId: 47 } });
    expect(persisted().attributes).toMatchObject({ link: contactLink, component_id: 47 });
    expect(api.request).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      body: expect.objectContaining({ component_id: 47,
        request: { option: 'com_contact', view: 'contact', id: '8' } }),
    }));
  });

  it.each([
    { type: 'url', link: 'https://example.test/news' },
    { type: 'alias', link: 'index.php?Itemid=9', params: { aliasoptions: 9 } },
    { type: 'separator', link: '' },
    { type: 'heading', link: '' },
    { type: 'container', link: '' },
  ])('clears component ownership when changing to $type', async (data) => {
    const { service, api, persisted } = harness(client, { initial: { component_id: 22 } });
    await grant(service);
    const planned = await plan(service, client, 'update', data);
    const result = await service.apply(planned.confirmationToken);

    expect(result).toMatchObject({ outcome: 'verified', verification: { expectedComponentId: 0, storedComponentId: 0 } });
    expect(persisted().attributes).toMatchObject({ type: data.type, component_id: 0 });
    expect(api.request).toHaveBeenCalledOnce();
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: expect.objectContaining({ component_id: 0 }),
    }));
  });
});

describe('menu write failure reporting and replay safety', () => {
  it('rejects overlapping approvals and replays their key without duplicating the create', async () => {
    const { service, api } = harness();
    await grant(service);
    const key = randomUUID();
    const first = await plan(service, 'site', 'create', {}, key);
    const second = await plan(service, 'site', 'create', {}, key);
    const results = await Promise.allSettled([service.apply(first.confirmationToken), service.apply(second.confirmationToken)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining('already in progress') }),
    });
    const retry = await plan(service, 'site', 'create', {}, key);
    expect(await service.apply(retry.confirmationToken)).toMatchObject({ outcome: 'verified', idempotentReplay: true });
    expect(api.request.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1);
  });

  it('does not mistake a derived item GET for successful persisted repair', async () => {
    const { service, loaded, persisted } = harness('site', { ignoreRepair: true });
    await grant(service);
    const planned = await plan(service, 'site', 'create');
    const result = await service.apply(planned.confirmationToken);

    expect(loaded().attributes['component_id']).toBe(22);
    expect(persisted().attributes['component_id']).toBe(0);
    expect(result).toMatchObject({ outcome: 'partial', mutation: { status: 201 },
      verification: { postcondition: 'failed', expectedComponentId: 22, storedComponentId: 0 } });
  });

  it.each([
    { failure: 'initial acknowledgement', options: { failInitial: true }, outcome: 'uncertain', requests: 1 },
    { failure: 'corrective save', options: { failRepair: true }, outcome: 'partial', requests: 2 },
    { failure: 'stored-row read', options: { failList: true }, outcome: 'partial', requests: 2 },
    { failure: 'new resource identity', options: { omitMutationId: true }, outcome: 'partial', requests: 1 },
  ])('reports $failure failure and never duplicates the POST on same-key retry', async ({ options, outcome, requests }) => {
    const { service, api } = harness('site', options);
    await grant(service);
    const key = randomUUID();
    const first = await plan(service, 'site', 'create', {}, key);
    const result = await service.apply(first.confirmationToken);
    expect(result).toMatchObject({ outcome, verification: { postcondition: 'not-verified', reason: expect.any(String) } });
    if (outcome === 'partial') expect(result).toMatchObject({ mutation: { status: 201 } });

    const retry = await plan(service, 'site', 'create', {}, key);
    expect(await service.apply(retry.confirmationToken)).toMatchObject({ ...result, idempotentReplay: true });
    expect(api.request).toHaveBeenCalledTimes(requests);
    expect(api.request.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1);
  });

  it.each([0, -1, 1.5, '22junk', '', null, Number.MAX_SAFE_INTEGER + 1])(
    'reports an invalid native component ID %j without sending a corrective write', async (derivedId) => {
      const { service, api } = harness('site', { derivedId });
      await grant(service);
      const planned = await plan(service, 'site', 'create');
      const result = await service.apply(planned.confirmationToken);

      expect(result).toMatchObject({ outcome: 'partial', verification: { postcondition: 'not-verified' } });
      expect(api.request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { type: 'url' },
    { link: contactLink },
  ])('refuses to repair a native item that no longer matches the approved menu target: %j', async (itemOverride) => {
    const { service, api } = harness('site', { itemOverride });
    await grant(service);
    const planned = await plan(service, 'site', 'create');
    const result = await service.apply(planned.confirmationToken);
    expect(result).toMatchObject({ outcome: 'partial', verification: { postcondition: 'not-verified' } });
    expect(api.request).toHaveBeenCalledOnce();
  });

  it('uses the post-save entity tag for its corrective write rather than reusing the original precondition', async () => {
    const { service, api } = harness('site', { itemEtag: '"menu-after-save"' });
    await grant(service);
    const planned = await service.planAction({
      action: 'menus.site-items.update', input: { id: 132, data: { title: 'Renamed' }, etag: '"menu-before-save"' },
      transport: 'api', idempotencyKey: randomUUID(),
    });
    if (!('confirmationToken' in planned)) throw new Error('Expected a menu update plan.');
    expect(await service.apply(planned.confirmationToken)).toMatchObject({ outcome: 'verified' });
    expect(api.request).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ etag: '"menu-before-save"' }));
    expect(api.request).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ etag: '"menu-after-save"' }));
  });
});

describe('bounded stored-menu verification', () => {
  it('uses numeric pagination on the fixed route and ignores remote next links', async () => {
    const { service, api, path } = harness('administrator', {
      list: (row, query) => ({
        data: query['page[offset]'] === 0
          ? [{ id: '1', attributes: { component_id: 0 } }, { id: '2', attributes: { component_id: 0 } }]
          : [row],
        links: { next: 'https://attacker.invalid/collect-token?page[offset]=999999' },
      }),
    }, 2);
    await grant(service);
    const planned = await plan(service, 'administrator', 'create');
    expect(await service.apply(planned.confirmationToken)).toMatchObject({ outcome: 'verified' });

    const listCalls = api.get.mock.calls.filter(([, requestedPath]) => requestedPath === path);
    expect(listCalls.map(([, , query]) => query)).toEqual([
      { 'page[offset]': 0, 'page[limit]': 2, 'filter[menutype]': 'mainmenu' },
      { 'page[offset]': 2, 'page[limit]': 2, 'filter[menutype]': 'mainmenu' },
    ]);
    expect(api.get.mock.calls.every(([, requestedPath]) => requestedPath === path || requestedPath === `${path}/132`)).toBe(true);
  });

  it('stops an endless collection within its page bound and reports incomplete verification', async () => {
    const { service, api, path } = harness('site', {
      list: () => ({ data: Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1000), attributes: {} })),
        links: { next: 'https://attacker.invalid/endless' } }),
    });
    await grant(service);
    const planned = await plan(service, 'site', 'create');
    expect(await service.apply(planned.confirmationToken)).toMatchObject({
      outcome: 'partial', verification: { postcondition: 'not-verified', reason: expect.any(String) },
    });
    const listCalls = api.get.mock.calls.filter(([, requestedPath]) => requestedPath === path);
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.length).toBeLessThanOrEqual(100);
    for (const [, , query] of listCalls) {
      expect(Number.isInteger(query['page[offset]'])).toBe(true);
      expect(query['page[offset]']).toBeLessThan(10_000);
      expect(query['page[limit]']).toBeLessThanOrEqual(100);
    }
  });
});

describe('menu binding authorization and transport boundaries', () => {
  it.each([
    { itemId: '999' },
    { itemOverride: { client_id: 1 } },
  ])('rejects update context belonging to another item or client: %j', async (options) => {
    const { service, api } = harness('site', options);
    await grant(service);
    await expect(plan(service, 'site', 'update')).rejects.toThrow(/match|client|identifier/);
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each([
    'index.php?option[]=com_contact',
    'index.php?option=com_content&option[]=com_contact',
    'index.php?option=com_content&%20option=com_contact',
    'index.php?option=com_content&option=com_contact',
    'index.php?option=com_content&x=1;option=com_contact',
    'https://example.test/index.php?option=com_content',
  ])('rejects an ambiguous or non-native component link before mutation: %s', async (link) => {
    const { service, api } = harness();
    await grant(service);
    await expect(plan(service, 'site', 'create', { link })).rejects.toThrow(/option|index.php/);
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['component_id', 'client_id', 'request'])('rejects caller-controlled %s before any native request', async (field) => {
    const { service, api } = harness();
    await grant(service);
    await expect(plan(service, 'site', 'create', { [field]: 99 })).rejects.toThrow(/Unsupported|not allowed/);
    expect(api.request).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('keeps a write preview non-mutating and preserves caller input', async () => {
    const { service, api } = harness();
    const data = Object.freeze(dataFor('create', { params: Object.freeze({ custom_setting: 'unchanged' }) }));
    const snapshot = structuredClone(data);
    const preview = await service.planAction({
      action: 'menus.site-items.create', input: { data }, transport: 'api', dryRun: true, idempotencyKey: randomUUID(),
    });
    expect(preview).toMatchObject({ dryRun: true, confirmationRequired: true });
    expect(preview).not.toHaveProperty('confirmationToken');
    expect(api.request).not.toHaveBeenCalled();
    expect(data).toEqual(snapshot);
  });

  it('requires the menu read toolset needed for stored-row verification', async () => {
    const config = configuration();
    const site = config.sites.get('test')!;
    const restricted = { ...config, sites: new Map([['test', { ...site, toolsets: new Set(['structure.write'] as const) }]]) };
    const storage = menuStorage('site');
    const service = new JoomlaWriteService(restricted, new SiteRegistry(restricted), storage.api);
    await grant(service);
    await expect(plan(service, 'site', 'create')).rejects.toThrow(/structure.read/);
    expect(storage.api.request).not.toHaveBeenCalled();
    expect(storage.api.get).not.toHaveBeenCalled();
  });

  it('checks caller read authorization before inspecting update context', async () => {
    const { service, api } = harness();
    await grant(service);
    await expect(service.planAction({
      action: 'menus.site-items.update', input: { id: 132, data: { title: 'Restricted' } },
      transport: 'api', idempotencyKey: randomUUID(),
    }, 'local-stdio', (_site, toolset) => {
      if (toolset === 'structure.read') throw new Error('Caller lacks menu read scope.');
    })).rejects.toThrow('Caller lacks menu read scope.');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('rechecks caller read authorization before applying a previously approved write', async () => {
    const { service, api } = harness();
    await grant(service);
    const planned = await plan(service, 'site', 'create');
    await expect(service.apply(planned.confirmationToken, 'local-stdio', (_site, toolset) => {
      if (toolset === 'structure.read') throw new Error('Menu read scope was revoked.');
    })).rejects.toThrow('Menu read scope was revoked.');
    expect(api.request).not.toHaveBeenCalled();
  });

  it('binds the effective update context into immutable public approval metadata', async () => {
    const { service, api } = harness();
    await grant(service);
    const planned = await plan(service, 'site', 'update', { link: contactLink });
    expect(planned.operation.preflight).toMatchObject({ menuComponentBinding: {
      clientId: 0, type: 'component', link: contactLink, option: 'com_contact', menutype: 'mainmenu',
      repair: 'native-derived-component-id', verify: 'stored-menu-list',
    } });
    const binding = planned.operation.preflight!['menuComponentBinding'] as Record<string, unknown>;
    expect(() => { binding['option'] = 'com_content'; }).toThrow();
    expect(api.request).not.toHaveBeenCalled();
    expect(await service.apply(planned.confirmationToken)).toMatchObject({
      outcome: 'verified', verification: { expectedComponentId: 47 },
    });
  });

  it('retains the approved create body when the caller later changes its original input', async () => {
    const { service, persisted } = harness();
    await grant(service);
    const data = { ...dataFor('create'), params: { custom_setting: 'approved' } };
    const planned = await service.planAction({
      action: 'menus.site-items.create', input: { data }, transport: 'api', idempotencyKey: randomUUID(),
    });
    if (!('confirmationToken' in planned)) throw new Error('Expected a menu create plan.');
    data['link'] = contactLink;
    data.params.custom_setting = 'changed after approval';

    expect(await service.apply(planned.confirmationToken)).toMatchObject({ outcome: 'verified' });
    expect(persisted().attributes).toMatchObject({
      link: contentLink, component_id: 22, params: { custom_setting: 'approved' },
    });
  });

  it('keeps ordinary menu GET reads non-mutating', async () => {
    const config = configuration();
    const api = { request: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '132', attributes: { component_id: 0 } } } })) };
    const service = new JoomlaService(new SiteRegistry(config), api);
    await service.executeReadAction({ action: 'menus.site-items.get', input: { id: 132 }, transport: 'api' });
    expect(api.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      method: 'GET', path: 'v1/menus/site/items/132',
    }));
  });

  it('retains native companion menu dispatch without adding API-derived component IDs', async () => {
    const { config, api } = harness();
    const envelope = (data: unknown): CompanionEnvelope => ({
      command: ['/usr/bin/php'], exitCode: 0, stdout: '{}', stderr: '', durationMs: 1,
      timedOut: false, truncated: false, data,
    });
    const cli = {
      list: vi.fn(), help: vi.fn(), inventory: vi.fn(),
      describe: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1',
        actions: [{ name: 'menus.site-items.create', effective: { allowed: true } }] })),
      dispatch: vi.fn(async (_config, _action, input) => envelope({
        protocol: 'joomla-mcp/1', ok: true,
        result: { id: 132, applied: input['dryRun'] !== true, dryRun: input['dryRun'] === true },
      })),
    } satisfies JoomlaCliTransport;
    const service = new JoomlaWriteService(config, new SiteRegistry(config), api, undefined, cli);
    await grant(service);
    const data = dataFor('create');
    const planned = await service.planAction({
      action: 'menus.site-items.create', input: { data }, transport: 'cli', idempotencyKey: randomUUID(),
    });
    if (!('confirmationToken' in planned)) throw new Error('Expected a companion plan.');
    await service.apply(planned.confirmationToken);
    expect(cli.dispatch).toHaveBeenLastCalledWith(expect.anything(), 'menus.site-items.create', {
      data, dryRun: false, _edgeConfirmed: true,
    });
    expect(api.request).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });
});
