import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../src/config/schema.js';
import { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';
import { JoomlaApiError } from '../src/infrastructure/index.js';

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
  it('normalizes Joomla fallback single-object errors with the same diagnostic filtering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: {
      code: 500, title: 'Internal server error', detail: '#0 /private/site/configuration.php(12): password=private',
    } }), { status: 500, headers: { 'content-type': 'application/vnd.api+json' } })));
    await expect(new JoomlaApiClient().get(config, 'v1/extensions')).rejects.toMatchObject({
      httpStatus: 500, errors: [{ code: '500', title: 'Internal server error' }],
      diagnosticsOmitted: true,
      message: 'Joomla API returned HTTP 500: {"errors":[{"code":"500","title":"Internal server error"}]} [additional diagnostics omitted]',
    });
  });
  it.each([400, 422, 500])('preserves structured native validation diagnostics for HTTP %s without inferring a write outcome', async (status) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ errors: [{
      code: status, title: 'Invalid field: Source String',
      detail: 'RuntimeException: Invalid field: Source String in /var/www/html/libraries/src/Form/Form.php:1004\n#0 private debug frame',
      trace: [{ args: ['downstream-secret'] }],
    }] }), { status, headers: { 'content-type': 'application/vnd.api+json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await new JoomlaApiClient().request(config, {
      method: 'PATCH', path: 'v1/content/articles/2', body: { title: 'Updated' },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JoomlaApiError);
    expect(failure).toMatchObject({ code: 'JOOMLA_API_ERROR', httpStatus: status, errors: [{
      code: String(status), title: 'Invalid field: Source String', detail: 'RuntimeException: Invalid field: Source String',
    }] });
    expect(String(failure)).not.toMatch(/private|var\/www|downstream-secret/);
    expect(failure).not.toHaveProperty('applied');
    expect(failure).not.toHaveProperty('retryable');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds error records and redacts configured API and update tokens from diagnostics', async () => {
    const token = 'bearer/secret';
    const updateToken = 'update-token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: Array.from({ length: 10 }, () => ({
      title: `${token} ${encodeURIComponent(token)} ${updateToken} ${'x'.repeat(5_000)}`,
    })) }), { status: 500, headers: { 'content-type': 'application/json' } })));
    const failure = await new JoomlaApiClient().get({ ...config, token, updateToken, maxResponseBytes: 100_000 }, 'v1/extensions')
      .catch((error: unknown) => error) as JoomlaApiError;

    expect(failure.errors).toHaveLength(3);
    expect(failure.errors.every((error) => (error.title?.length ?? 0) <= 500)).toBe(true);
    expect(failure.message).toContain('[redacted]');
    expect(failure.message).not.toMatch(/bearer|update-token/);
    expect(Object.isFrozen(failure.errors)).toBe(true);
  });

  it('does not expose HTML error pages or misclassify transport failures as HTTP rejections', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('<html>private proxy credentials</html>', { status: 502 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new JoomlaApiClient().get(config, 'v1/extensions')).rejects.toMatchObject({
      httpStatus: 502, errors: [], message: 'Joomla API returned HTTP 502: No public JSON:API error details were returned.',
    });
    await expect(new JoomlaApiClient().get(config, 'v1/extensions')).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    '#0 /var/www/private/configuration.php(12): sensitive argument',
    '/var/www/private/configuration.php: secret diagnostic',
    'C:\\private\\configuration.php: sensitive argument',
    'SQLSTATE[23000]: SELECT email FROM private_users',
    'PDOException: database account credentials',
    'password=another-secret-value',
    'Authorization: Bearer another-token',
    'Unexpected https://user:password@example.test/private',
  ])('omits unsafe first-line JSON:API diagnostics: %s', (detail) => {
    const failure = new JoomlaApiError(500, { errors: [{ title: 'Invalid field: Source String', detail }] });
    expect(failure.errors).toEqual([{ title: 'Invalid field: Source String' }]);
    expect(failure.diagnosticsOmitted).toBe(true);
    expect(failure.message).toBe('Joomla API returned HTTP 500: {"errors":[{"title":"Invalid field: Source String"}]} [additional diagnostics omitted]');
  });

  it('preserves HTTP rejection status when the error JSON is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{ invalid json', {
      status: 500, headers: { 'content-type': 'application/json' },
    })));
    await expect(new JoomlaApiClient().get(config, 'v1/extensions')).rejects.toMatchObject({
      code: 'JOOMLA_API_ERROR', httpStatus: 500, errors: [],
    });
  });

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
