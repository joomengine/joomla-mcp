import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import { resolveJoomlaWriteRequest } from '../src/catalog/action-catalog.js';
import type { Configuration } from '../src/config/schema.js';
import type { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'publishing-fixture-secret-at-least-32-bytes', ttlMs: 60_000 },
  sites: new Map([['test', {
    id: 'test', toolsets: new Set(['content.read', 'content.write', 'structure.read', 'structure.write']),
    api: { baseUrl: 'https://example.test', token: 'secret', tokenEnv: 'TOKEN', timeoutMs: 30_000,
      maxResponseBytes: 1_000_000, maxPageSize: 100 },
  }]]),
};

describe('native publishing and authorship fields', () => {
  it.each(['modules.site', 'modules.administrator'])('preserves %s scheduling through plan and dispatch', async (base) => {
    const data = { publish_up: '2026-11-09 08:30:00', publish_down: '2026-11-16 08:30:00' };
    for (const operation of ['create', 'update']) {
      const api = {
        request: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41' } } })),
        get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41', attributes: data } } })),
      } as unknown as JoomlaApiClient;
      const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
      const permission = await service.requestPermission({ toolsets: ['structure.write'], duration: '30-minutes', reason: 'Verify native publishing fields.' });
      await service.approvePermission(permission.requestId, permission.acknowledgement);
      const plan = await service.planAction({ action: `${base}.${operation}`, input: {
        ...(operation === 'update' ? { id: 41 } : {}), data,
      }, idempotencyKey: randomUUID() });
      const applied = await service.apply(plan.confirmationToken);
      expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.objectContaining(data) }));
      expect(applied.verification).toMatchObject({ status: 200, data: { data: { id: '41', attributes: data } } });
    }
  });

  it.each(['create', 'update'] as const)('allows article %s to set its creation date and author', async (operation) => {
    const data = { title: 'Weekly promotion', catid: 2, created: '2026-11-09 08:30:00', created_by: 42,
      publish_up: '2026-11-09 08:30:00', publish_down: '2026-11-16 08:30:00' };
    const api = {
      request: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41' } } })),
      get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41', attributes: data } } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    const permission = await service.requestPermission({ toolsets: ['content.write'], duration: '30-minutes', reason: 'Verify native authoring fields.' });
    await service.approvePermission(permission.requestId, permission.acknowledgement);
    const plan = await service.planArticle({ operation, ...(operation === 'update' ? { id: 41 } : {}), data,
      idempotencyKey: randomUUID() } as Parameters<JoomlaWriteService['planArticle']>[0]);
    const applied = await service.apply(plan.confirmationToken);
    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expect.objectContaining(data) }));
    expect(applied.verification).toMatchObject({ status: 200, data: { data: { id: '41', attributes: data } } });
  });

  it('rejects malformed scheduling values and arbitrary article bookkeeping fields', () => {
    for (const data of [{ publish_up: true }, { publish_down: {} }]) {
      expect(() => resolveJoomlaWriteRequest('modules.site.update', { id: 41, data })).toThrow();
    }
    for (const data of [{ created_by: -1 }, { created_by: '42' }, { modified_by: 42 }]) {
      expect(() => resolveJoomlaWriteRequest('content.articles.update', { id: 41, data })).toThrow();
    }
    expect(resolveJoomlaWriteRequest('modules.administrator.update', { id: 41, data: { publish_down: null } }).body)
      .toMatchObject({ publish_down: null });
  });
});
