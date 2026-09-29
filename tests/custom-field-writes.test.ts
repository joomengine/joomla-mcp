import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { JoomlaService } from '../src/application/joomla-service.js';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { ApiConfig, Configuration, Toolset } from '../src/config/schema.js';
import type { JoomlaApiRequest, JoomlaApiResponse } from '../src/infrastructure/api/joomla-api-client.js';
import { createRuntime, createServer } from '../src/mcp/create-server.js';
import type { ConfirmationPlan } from '../src/security/confirmation-service.js';

const resources = [
  { action: 'content.articles', context: 'com_content.article', fieldPath: 'v1/fields/content/articles',
    path: 'v1/content/articles', core: { title: 'Article', catid: 2 } },
  { action: 'content.categories', context: 'com_content.categories', fieldPath: 'v1/fields/content/categories',
    path: 'v1/content/categories', core: { title: 'Category' } },
  { action: 'contacts.contacts', context: 'com_contact.contact', fieldPath: 'v1/fields/contacts/contact',
    path: 'v1/contacts', core: { name: 'Contact', catid: 2 } },
  { action: 'users.users', context: 'com_users.user', fieldPath: 'v1/fields/users',
    path: 'v1/users', core: { name: 'Example', username: 'example', email: 'example@example.test' } },
] as const;

type Field = ReturnType<typeof field>;
let nextFieldId = 1;
function field(name: string, context = 'com_content.article', attributes: Record<string, unknown> = {}) {
  return { id: String(nextFieldId++), type: 'fields', attributes: {
    name, context, type: 'text', label: name, state: 1, group_id: 0, ...attributes,
  } };
}

function harness(options: {
  readonly fields?: readonly Field[];
  readonly structureRead?: boolean;
  readonly usersRead?: boolean;
  readonly maxPageSize?: number;
  readonly page?: (request: { path: string; offset: number; limit: number }) => unknown;
} = {}) {
  const toolsets = new Set<Toolset>([
    'discovery', 'content.read', 'content.write', 'structure.write', 'users.admin',
    ...(options.structureRead === false ? [] : ['structure.read' as const]),
    ...(options.usersRead === false ? [] : ['users.read' as const]),
  ]);
  const configuration: Configuration = {
    defaultSite: 'test',
    approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
    sites: new Map([['test', {
      id: 'test', toolsets,
      api: { baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
        maxResponseBytes: 1_000_000, maxPageSize: options.maxPageSize ?? 100 },
    }]]),
  };
  let stored: Record<string, unknown> = {};
  const fields = options.fields ?? [field('colour'), field('related', 'com_content.article', { type: 'subform' })];
  const api = {
    get: vi.fn(async (_config: ApiConfig, path: string, query: JoomlaApiRequest['query'] = {}): Promise<JoomlaApiResponse> => {
      if (path.startsWith('v1/fields/')) {
        const offset = Number(query['page[offset]'] ?? 0);
        const limit = Number(query['page[limit]'] ?? 100);
        return { status: 200, headers: {}, data: options.page?.({ path, offset, limit }) ?? {
          data: fields.slice(offset, offset + limit),
          meta: { 'total-pages': Math.ceil(fields.length / limit) },
          links: { next: offset + limit < fields.length ? 'https://untrusted.invalid/ignore-this-url' : null },
        } };
      }
      return { status: 200, headers: {}, data: { data: { id: '41', attributes: { ...stored } } } };
    }),
    request: vi.fn(async (_config: ApiConfig, request: JoomlaApiRequest): Promise<JoomlaApiResponse> => {
      stored = { ...stored, ...request.body };
      return { status: request.method === 'POST' ? 201 : 200, headers: {}, data: { data: { id: '41' } } };
    }),
  };
  const registry = new SiteRegistry(configuration);
  return {
    api, configuration,
    service: new JoomlaService(registry, api),
    writes: new JoomlaWriteService(configuration, registry, api),
  };
}

async function grant(writes: JoomlaWriteService): Promise<void> {
  const permission = await writes.requestPermission({
    toolsets: ['content.write', 'structure.write', 'users.admin'], duration: '30-minutes',
    reason: 'Verify Joomla custom field persistence and write boundaries.',
  });
  await writes.approvePermission(permission.requestId, permission.acknowledgement);
}

async function plan(
  writes: JoomlaWriteService,
  action: string,
  data: Readonly<Record<string, unknown>>,
): Promise<ConfirmationPlan> {
  const result = await writes.planAction({
    action, input: { ...(action.endsWith('.update') ? { id: 41 } : {}), data },
    transport: 'api', idempotencyKey: randomUUID(),
  });
  if (!('confirmationToken' in result)) throw new Error('Expected confirmation token.');
  return result;
}

function preview(writes: JoomlaWriteService, data: Readonly<Record<string, unknown>>, action = 'content.articles.update') {
  return writes.planAction({ action, input: { id: 41, data }, transport: 'api', dryRun: true, idempotencyKey: randomUUID() });
}

const metadata = { name: 'colour', type: 'text', context: 'com_content.article' };

describe.each(resources)('$action custom field writes', (resource) => {
  it.each(['create', 'update'] as const)('discovers the exact context and persists %s fields through native Joomla payloads', async (operation) => {
    const { writes, api } = harness({ fields: [field('colour', resource.context), field('unused', resource.context)] });
    await grant(writes);
    const data = { ...resource.core, colour: 'Blue' };
    const planned = await plan(writes, `${resource.action}.${operation}`, data);
    expect(planned.operation).toMatchObject({ customFields: [{ ...metadata, context: resource.context }] });
    expect(JSON.stringify(planned)).not.toContain('Blue');
    expect(api.request).not.toHaveBeenCalled();
    expect(api.get.mock.calls[0]?.[1]).toBe(resource.fieldPath);
    await writes.apply(planned.confirmationToken);
    const nativeCustomFields = resource.action === 'content.categories' ? { com_fields: { colour: 'Blue' } } : { colour: 'Blue' };
    expect(api.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      method: operation === 'create' ? 'POST' : 'PATCH',
      path: operation === 'create' ? resource.path : `${resource.path}/41`,
      body: expect.objectContaining({ ...resource.core, ...nativeCustomFields }),
    }));
    if (resource.action === 'content.categories') {
      expect(api.request.mock.calls[0]?.[1].body).not.toHaveProperty('colour');
    }
  });

  it('normalizes the com_fields alias without forwarding duplicate representations', async () => {
    const { writes, api } = harness({ fields: [field('colour', resource.context)] });
    await grant(writes);
    const planned = await plan(writes, `${resource.action}.update`, { com_fields: { colour: '' } });
    await writes.apply(planned.confirmationToken);
    const body = api.request.mock.calls[0]?.[1].body;
    if (resource.action === 'content.categories') {
      expect(body).toMatchObject({ com_fields: { colour: '' } });
      expect(body).not.toHaveProperty('colour');
    } else {
      expect(body).toEqual({ colour: '' });
      expect(body).not.toHaveProperty('com_fields');
    }
  });
});

describe('custom field previews and typed article plans', () => {
  it('accepts published Unicode field names from sites using Unicode slugs', async () => {
    const name = 'équipe-团队';
    const { writes, api } = harness({ fields: [field(name)] });
    await grant(writes);
    const planned = await plan(writes, 'content.articles.update', { [name]: 'Team' });
    expect(planned.operation.customFields).toEqual([{ name, type: 'text', context: 'com_content.article' }]);
    await writes.apply(planned.confirmationToken);
    expect(api.request.mock.calls[0]?.[1].body).toEqual({ [name]: 'Team' });
  });

  it('discovers and previews only the requested names without a grant or mutation', async () => {
    const { writes, api } = harness();
    const result = await preview(writes, { colour: ['Blue', 'Green'] });
    expect(result).toMatchObject({ dryRun: true, confirmationRequired: true, operation: { customFields: [metadata] } });
    expect(result).not.toHaveProperty('confirmationToken');
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)('supports typed %s article plans and retains body normalization', async (operation) => {
    const { writes, api } = harness();
    await grant(writes);
    const data = { ...(operation === 'create' ? { title: 'Article', catid: 2 } : {}),
      articletext: 'Intro<hr id="system-readmore" />Body', colour: 'Blue' };
    const planned = await writes.planArticle(operation === 'create'
      ? { operation, data, idempotencyKey: randomUUID() }
      : { operation, id: 41, data, idempotencyKey: randomUUID() });
    expect(planned.operation).toMatchObject({ customFields: [metadata] });
    await writes.apply(planned.confirmationToken);
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: { ...(operation === 'create' ? { title: 'Article', catid: 2 } : {}),
        introtext: 'Intro', fulltext: 'Body', colour: 'Blue' },
    }));
  });

  it('snapshots nested custom values before confirmation so caller mutation cannot widen the approved write', async () => {
    const { writes, api } = harness();
    await grant(writes);
    const data = { related: [{ field7: 'approved' }], colour: 'Blue' };
    const planned = await plan(writes, 'content.articles.update', data);
    data.related[0]!.field7 = 'unapproved';
    data.related.push({ field7: 'unapproved addition' });
    data.colour = 'Red';
    await writes.apply(planned.confirmationToken);
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: { related: [{ field7: 'approved' }], colour: 'Blue' },
    }));
  });

  it('rechecks operator authorization on apply', async () => {
    const { writes, api } = harness();
    await grant(writes);
    const planned = await plan(writes, 'content.articles.update', { colour: 'Blue' });
    await writes.revokePermission(writes.listPermissions()[0]!.id);
    await expect(writes.apply(planned.confirmationToken)).rejects.toThrow(/permission grant/);
    expect(api.request).not.toHaveBeenCalled();
  });
});

describe('custom field discovery and bounded pagination', () => {
  it('adds discovered fields to the selected action schema without exposing arbitrary keys', async () => {
    const { service } = harness();
    const described = await service.describeAction('content.articles.update');
    expect(described).toMatchObject({
      customFields: { status: 'resolved', context: 'com_content.article', transport: 'api', fields: expect.arrayContaining([metadata]) },
      action: { inputSchema: { properties: { data: {
        additionalProperties: false, properties: { colour: expect.any(Object), related: expect.any(Object) },
      } } } },
    });
  });

  it('describes the missing discovery permission without preventing ordinary core writes', async () => {
    const { service, writes, api } = harness({ structureRead: false });
    const described = await service.describeAction('content.articles.update');
    expect(described).toMatchObject({
      customFields: { status: 'unavailable', fields: [], reason: expect.stringContaining('structure.read') },
    });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow(/structure.read/);
    const core = await preview(writes, { title: 'Core-only update' });
    expect(core).toMatchObject({ dryRun: true });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['generic', 'typed'] as const)('enforces remote structure.read authorization before %s planning reads Joomla', async (planner) => {
    const { writes, api } = harness();
    const authorizeRead = vi.fn(() => { throw new Error('Remote structure.read permission denied.'); });
    const planned = planner === 'typed'
      ? writes.planArticle({ operation: 'update', id: 41, data: { colour: 'Blue' }, idempotencyKey: randomUUID() },
        'remote-client', authorizeRead)
      : writes.planAction({ action: 'content.articles.update', input: { id: 41, data: { colour: 'Blue' } },
        transport: 'api', dryRun: true, idempotencyKey: randomUUID() }, 'remote-client', authorizeRead);

    await expect(planned).rejects.toThrow('Remote structure.read permission denied.');
    expect(authorizeRead).toHaveBeenCalledExactlyOnceWith('test', 'structure.read');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('describes custom fields as unavailable when the remote principal lacks structure.read', async () => {
    const { service, api } = harness();
    const authorizeRead = vi.fn(() => { throw new Error('Remote structure.read permission denied.'); });
    const described = await service.describeAction('content.articles.update', 'test', authorizeRead);
    expect(described).toMatchObject({
      customFields: { status: 'unavailable', fields: [], reason: expect.stringContaining('structure.read') },
    });
    expect(authorizeRead).toHaveBeenCalledExactlyOnceWith('test', 'structure.read');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('requires users.read for user custom writes even when users.admin and structure.read are enabled', async () => {
    const { writes, api } = harness({ usersRead: false, fields: [field('colour', 'com_users.user')] });
    await expect(preview(writes, { colour: 'Blue' }, 'users.users.update')).rejects.toThrow(/users.read/);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('allows user custom writes with users.read and users.admin without structure.read', async () => {
    const { writes, api } = harness({ structureRead: false, fields: [field('colour', 'com_users.user')] });
    await grant(writes);
    const planned = await plan(writes, 'users.users.update', { colour: 'Blue' });
    expect(planned.operation).toMatchObject({ customFields: [{ ...metadata, context: 'com_users.user' }] });
    await writes.apply(planned.confirmationToken);
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      method: 'PATCH', path: 'v1/users/41', body: { colour: 'Blue' },
    }));
  });

  it('enforces the remote users.read scope even when the principal permits structure.read', async () => {
    const { writes, api } = harness({ fields: [field('colour', 'com_users.user')] });
    const authorizeRead = vi.fn((_site: string, toolset: string) => {
      if (toolset === 'users.read') throw new Error('Remote users.read permission denied.');
    });
    await expect(writes.planAction({
      action: 'users.users.update', input: { id: 41, data: { colour: 'Blue' } },
      transport: 'api', dryRun: true, idempotencyKey: randomUUID(),
    }, 'remote-client', authorizeRead)).rejects.toThrow('Remote users.read permission denied.');
    expect(authorizeRead).toHaveBeenCalledExactlyOnceWith('test', 'users.read');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('describes user custom fields as unavailable without the users.read site toolset', async () => {
    const { service, api } = harness({ usersRead: false, fields: [field('colour', 'com_users.user')] });
    expect(await service.describeAction('users.users.update')).toMatchObject({
      customFields: { status: 'unavailable', fields: [], readToolset: 'users.read', reason: expect.stringContaining('users.read') },
    });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('describes user custom fields as unavailable when remote users.read authorization is denied', async () => {
    const { service, api } = harness({ fields: [field('colour', 'com_users.user')] });
    const authorizeRead = vi.fn((_site: string, toolset: string) => {
      if (toolset === 'users.read') throw new Error('Remote users.read permission denied.');
    });
    expect(await service.describeAction('users.users.update', 'test', authorizeRead)).toMatchObject({
      customFields: { status: 'unavailable', fields: [], readToolset: 'users.read', reason: expect.stringContaining('users.read') },
    });
    expect(authorizeRead).toHaveBeenCalledExactlyOnceWith('test', 'users.read');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('uses bounded numeric offsets on the fixed field route, never server-provided next URLs', async () => {
    const { writes, api } = harness({ maxPageSize: 2,
      fields: [field('first'), field('second'), field('third'), field('fourth'), field('colour')],
    });
    await preview(writes, { colour: 'Blue' });
    expect(api.get.mock.calls.map(([, path]) => path)).toEqual(Array(3).fill('v1/fields/content/articles'));
    expect(api.get.mock.calls.map(([, , query]) => query?.['page[offset]'])).toEqual([0, 2, 4]);
    expect(api.get.mock.calls.map(([, , query]) => query?.['page[limit]'])).toEqual([2, 2, 2]);
  });

  it('continues discovery when Joomla caps the response below the requested page size', async () => {
    const { writes, api } = harness({ maxPageSize: 100, page: ({ offset }) => ({
      data: offset === 0 ? [field('first')] : [field('colour')],
      links: { next: offset === 0 ? 'https://untrusted.invalid/another-page' : null },
    }) });
    await preview(writes, { colour: 'Blue' });
    expect(api.get.mock.calls.map(([, , query]) => query?.['page[offset]'])).toEqual([0, 1]);
  });

  it('fails closed when a field listing exceeds the pagination budget', async () => {
    const { writes, api } = harness({ maxPageSize: 1, page: ({ offset }) => ({
      data: [field(`field${offset}`)], links: { next: 'https://untrusted.invalid/forever' },
    }) });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow(/limit|maximum|bound|pages|100/i);
    expect(api.get.mock.calls.length).toBeLessThanOrEqual(100);
    expect(api.request).not.toHaveBeenCalled();
  });

  it('fails closed above 1000 discovered fields even when fewer than 100 pages would suffice', async () => {
    const fields = [...Array.from({ length: 1_000 }, (_, index) => field(`field${index}`)), field('colour')];
    const { writes, api } = harness({ fields, maxPageSize: 100 });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow('1000-field collection limit');
    expect(api.get).toHaveBeenCalledTimes(11);
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'unpublished', attributes: { state: 0 } },
    { name: 'trashed', attributes: { state: -2 } },
    { name: 'another context', attributes: { context: 'com_users.user' } },
    { name: 'subform child', attributes: { only_use_in_subform: 1 } },
    { name: 'unpublished group', attributes: { group_id: 7, group_state: 0 } },
  ])('rejects $name fields even when returned by the field API', async ({ attributes }) => {
    const { writes, api } = harness({ fields: [field('colour', 'com_content.article', attributes)] });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('rejects ambiguous published field names', async () => {
    const { writes } = harness({ fields: [field('colour'), { ...field('colour'), id: '98765' }] });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow(/duplicate|ambig/i);
  });
});

describe('custom field validation boundaries', () => {
  it.each([
    { name: 'unknown field', data: { missing: 'value' } },
    { name: 'duplicate representations', data: { colour: 'Blue', com_fields: { colour: 'Red' } } },
    { name: 'array alias', data: { com_fields: ['Blue'] } },
    { name: 'empty alias with core data', data: { title: 'Core', com_fields: {} } },
    { name: 'null alias', data: { com_fields: null } },
    { name: 'core field alias', data: { com_fields: { title: 'Override core' } } },
    { name: 'null custom value', data: { colour: null } },
    { name: 'null aliased custom value', data: { com_fields: { colour: null } } },
    { name: 'nonfinite value', data: { colour: Number.NaN } },
    { name: 'non-JSON value', data: { colour: () => 'Blue' } },
    { name: 'unsafe nested key', data: { related: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') } },
    { name: 'oversized array', data: { colour: Array(10_001).fill('Blue') } },
    { name: 'oversized payload', data: { colour: 'x'.repeat(1_048_577) } },
  ])('rejects $name before any mutation', async ({ data }) => {
    const { writes, api } = harness();
    await expect(preview(writes, data)).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['__proto__', 'constructor', 'prototype', 'id', 'task', 'option'])('never promotes reserved name %s from field metadata', async (name) => {
    const { writes, api } = harness({ fields: [field(name)] });
    await expect(preview(writes, JSON.parse(`{"${name}":"value"}`))).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['title', 'catid', 'task'])('rejects a published flat-payload collision with %s even when that key is omitted from the write', async (name) => {
    const { writes, api } = harness({ fields: [field('colour'), field(name)] });
    await expect(preview(writes, { colour: 'Blue' })).rejects.toThrow(/collides with a core Joomla form field/);
    expect(api.request).not.toHaveBeenCalled();
  });

  it('excludes colliding category field names while retaining the independent core and nested custom values', async () => {
    const { writes, api } = harness({ fields: [
      field('colour', 'com_content.categories'), field('title', 'com_content.categories'), field('task', 'com_content.categories'),
    ] });
    await grant(writes);
    const planned = await plan(writes, 'content.categories.update', { title: 'Core title', colour: 'Blue' });
    expect(planned.operation).toMatchObject({ customFields: [{ ...metadata, context: 'com_content.categories' }] });
    await writes.apply(planned.confirmationToken);
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: { title: 'Core title', extension: 'com_content', com_fields: { colour: 'Blue' } },
    }));
  });

  it.each(['registerDate', 'lastvisitDate', 'activation', 'lastResetTime', 'resetCount', 'otpKey', 'otep', 'authProvider'])(
    'rejects published user field collision with sensitive core property %s', async (name) => {
      const { writes, api } = harness({ fields: [field('colour', 'com_users.user'), field(name, 'com_users.user')] });
      await expect(preview(writes, { colour: 'Blue' }, 'users.users.update')).rejects.toThrow(/collides with a core Joomla form field/);
      expect(api.request).not.toHaveBeenCalled();
    },
  );

  it('preserves the fixed catalog restrictions on resources without custom fields', async () => {
    const { writes, api } = harness();
    await expect(preview(writes, { colour: 'Blue' }, 'banners.banners.update')).rejects.toThrow();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });
});

describe('typed MCP article custom field input', () => {
  it.each(['create', 'update'] as const)('retains custom properties in the %s tool until site-aware validation', async (operation) => {
    const { configuration, api } = harness();
    const runtime = createRuntime(configuration, { api, audit: { write: () => undefined } });
    await grant(runtime.writes);
    const server = createServer(configuration, runtime);
    const client = new Client({ name: 'custom-field-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const planned = await client.callTool({ name: `joomla_content_article_${operation}_plan`, arguments: {
        ...(operation === 'update' ? { id: 41 } : {}), idempotencyKey: randomUUID(),
        data: { ...(operation === 'create' ? { title: 'Article', catid: 2 } : {}), colour: 'Blue' },
      } });
      expect(planned.isError).not.toBe(true);
      expect(planned.structuredContent).toMatchObject({ operation: { customFields: [metadata] } });
      const token = (planned.structuredContent as Record<string, unknown>)['confirmationToken'];
      expect(typeof token).toBe('string');
      const applied = await client.callTool({ name: 'joomla_write_apply', arguments: { confirmationToken: token } });
      expect(applied.isError).not.toBe(true);
      expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.objectContaining({ colour: 'Blue' }) }));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
