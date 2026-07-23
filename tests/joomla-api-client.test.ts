import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../src/config/schema.js';
import { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';

const config: ApiConfig = {
  baseUrl: 'https://example.test',
  tokenEnv: 'TOKEN',
  token: 'downstream-secret',
  timeoutMs: 30_000,
  maxResponseBytes: 1_024,
  maxPageSize: 100,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JoomlaApiClient', () => {
  it('uses a configured origin, bearer token, JSON:API accept header, and no redirects', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new JoomlaApiClient().get(config, 'v1/content/articles', {
      'page[offset]': 0,
      'page[limit]': 20,
    });

    expect(result.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://example.test/api/index.php/v1/content/articles?page%5Boffset%5D=0&page%5Blimit%5D=20');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({
      Accept: 'application/vnd.api+json',
      Authorization: 'Bearer downstream-secret',
    });
  });

  it('rejects oversized responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': '2048', 'content-type': 'text/plain' },
        }),
      ),
    );

    await expect(new JoomlaApiClient().get(config, 'v1/extensions')).rejects.toThrow('exceeds');
  });

  it('sends flat Joomla form writes with concurrency and idempotency headers', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: '2' } }), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new JoomlaApiClient().request(config, {
      method: 'PATCH',
      path: 'v1/content/articles/2',
      body: { title: 'Updated' },
      etag: '"revision-1"',
      idempotencyKey: '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBe('{"title":"Updated"}');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'If-Match': '"revision-1"',
      'Idempotency-Key': '9782a1c5-f86f-4d05-a4f4-a21e175faa70',
    });
  });

  it('uses the separate Joomla Update token without bearer-token passthrough', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new JoomlaApiClient().request(
      { ...config, updateToken: 'update-secret' },
      { method: 'GET', path: 'v1/joomlaupdate/healthcheck', authentication: 'joomla-update-token' },
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ 'X-JUpdate-Token': 'update-secret' });
    expect(init?.headers).not.toHaveProperty('Authorization');
  });
});
