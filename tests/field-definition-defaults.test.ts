import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import { resolveJoomlaWriteRequest } from '../src/catalog/action-catalog.js';
import { joomlaCrudBases } from '../src/catalog/crud-bases.js';
import type { ApiConfig, Configuration } from '../src/config/schema.js';
import type { JoomlaApiRequest } from '../src/infrastructure/api/joomla-api-client.js';

const fields = joomlaCrudBases.filter((base) => base.id.startsWith('fields.'));
const fieldData = Object.freeze({ title: 'Default test', name: 'default-test', label: 'Default test', type: 'text' });

it('covers every reviewed field context', () => {
  expect(fields).toHaveLength(6);
});

describe.each(fields)('$id field defaults', (base) => {
  it('sends the approved empty default on create and preserves it during a partial update', async () => {
    const configuration: Configuration = {
      defaultSite: 'test', approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
      sites: new Map([['test', { id: 'test', toolsets: new Set(['structure.write', 'users.admin']),
        api: { baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
          maxResponseBytes: 1_000_000, maxPageSize: 100 } }]]),
    };
    let stored: Record<string, unknown> = {};
    const api = {
      request: vi.fn(async (_config: ApiConfig, request: JoomlaApiRequest) => {
        stored = request.method === 'POST' ? { ...request.body } : { ...stored, ...request.body };
        return { status: 200, headers: {}, data: { data: { id: '41', attributes: stored } } };
      }),
      get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41', attributes: stored } } })),
    };
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    const permission = await service.requestPermission({ toolsets: ['structure.write', 'users.admin'],
      duration: '30-minutes', reason: 'Test native field defaults.' });
    await service.approvePermission(permission.requestId, permission.acknowledgement);
    const create = await service.planAction({ action: `${base.id}.create`, input: { data: fieldData },
      transport: 'api', idempotencyKey: randomUUID() });
    expect(api.request).not.toHaveBeenCalled();
    expect(fieldData).not.toHaveProperty('default_value');
    if (!('confirmationToken' in create)) throw new Error('Missing create confirmation.');
    await service.apply(create.confirmationToken);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      method: 'POST', body: { ...fieldData, context: base.controllerDefaults['context'], default_value: '' },
    }));

    // Model a pre-existing deliberate default; title-only PATCH must preserve it.
    stored['default_value'] = 'Keep this default';
    const update = await service.planAction({ action: `${base.id}.update`, input: { id: 41, data: { title: 'Renamed' } },
      transport: 'api', idempotencyKey: randomUUID() });
    if (!('confirmationToken' in update)) throw new Error('Missing update confirmation.');
    await service.apply(update.confirmationToken);
    expect(api.request.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: { title: 'Renamed' } });
    expect(api.request.mock.calls[1]![1].body).not.toHaveProperty('default_value');
    expect(stored['default_value']).toBe('Keep this default');
  });

  it.each(['', '0', 'A default\nwith another line', '["first","second"]', null])(
    'preserves an explicitly supplied default %j for native validation', (value) => {
      const data = Object.freeze({ ...fieldData, default_value: value });
      expect(resolveJoomlaWriteRequest(`${base.id}.create`, { data }).body?.['default_value']).toEqual(value);
      expect(resolveJoomlaWriteRequest(`${base.id}.update`, { id: 41, data }).body?.['default_value']).toEqual(value);
    });
});

it.each(joomlaCrudBases.filter((base) => base.id.startsWith('field-groups.')))(
  'does not add a field default to $id', (base) => {
    expect(resolveJoomlaWriteRequest(`${base.id}.create`, { data: { title: 'Group' } }).body)
      .not.toHaveProperty('default_value');
  });
