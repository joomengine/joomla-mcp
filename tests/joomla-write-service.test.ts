import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { Configuration } from '../src/config/schema.js';
import type { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([
    [
      'test',
      {
        id: 'test',
        toolsets: new Set(['content.read', 'content.write']),
        api: {
          baseUrl: 'https://example.test',
          tokenEnv: 'TOKEN',
          token: 'secret',
          timeoutMs: 30_000,
          maxResponseBytes: 1_000_000,
          maxPageSize: 100,
        },
      },
    ],
  ]),
};

describe('JoomlaWriteService', () => {
  it('plans, applies, and verifies a typed flat-form article create', async () => {
    const api = {
      request: vi.fn(async () => ({ status: 201, headers: {}, data: { data: { id: '41' } } })),
      get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41' } } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    await grant(service);
    const plan = await service.planArticle({
      operation: 'create',
      data: { title: 'Hello', catid: 2, articletext: '<p>World</p>' },
      idempotencyKey: '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
    });
    const result = await service.apply(String(plan['confirmationToken']));

    expect(api.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: 'v1/content/articles',
        body: { title: 'Hello', catid: 2, articletext: '<p>World</p>' },
      }),
    );
    expect(api.get).toHaveBeenCalledWith(expect.anything(), 'v1/content/articles/41');
    expect(result['idempotentReplay']).toBe(false);
  });

  it('rejects unknown Joomla fields before creating a plan', async () => {
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration));

    await expect(
      service.planArticle({
        operation: 'create',
        data: { title: 'Hello', catid: 2, password: 'not-allowed' },
        idempotencyKey: '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
      }),
    ).rejects.toThrow();
  });

  it('scopes completed idempotency results to the authenticated principal', async () => {
    const api = {
      request: vi.fn(async () => ({ status: 201, headers: {}, data: { data: { id: '41' } } })),
      get: vi.fn(async () => ({ status: 200, headers: {}, data: { data: { id: '41' } } })),
    } as unknown as JoomlaApiClient;
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
    const input = {
      operation: 'create' as const,
      data: { title: 'Principal scoped', catid: 2 },
      idempotencyKey: '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
    };
    await grant(service, 'remote:issuer:alice:client');
    const alice = await service.planArticle(input, 'remote:issuer:alice:client');
    await service.apply(alice.confirmationToken, 'remote:issuer:alice:client');
    await grant(service, 'remote:issuer:bob:client');
    const bob = await service.planArticle(input, 'remote:issuer:bob:client');
    const bobResult = await service.apply(bob.confirmationToken, 'remote:issuer:bob:client');

    expect(bobResult['idempotentReplay']).toBe(false);
    expect(api.request).toHaveBeenCalledTimes(2);
  });
});

async function grant(service: JoomlaWriteService, principal = 'local-stdio'): Promise<void> {
  const request = await service.requestPermission({
    toolsets: ['content.write'],
    duration: '30-minutes',
    reason: 'Run the write-service test.',
  }, principal);
  await service.approvePermission(request.requestId, request.acknowledgement, principal);
}
