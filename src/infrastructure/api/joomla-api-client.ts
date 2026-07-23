import type { ApiConfig } from '../../config/schema.js';

export interface JoomlaApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: unknown;
}

export type JoomlaApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface JoomlaApiRequest {
  readonly method: JoomlaApiMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly etag?: string;
  readonly idempotencyKey?: string;
  readonly authentication?: 'joomla-api-token' | 'joomla-update-token';
}

export class JoomlaApiClient {
  public async get(
    config: ApiConfig,
    path: string,
    query: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>> = {},
  ): Promise<JoomlaApiResponse> {
    return this.request(config, { method: 'GET', path, query });
  }

  public async request(config: ApiConfig, request: JoomlaApiRequest): Promise<JoomlaApiResponse> {
    const url = this.url(config, request.path, request.query ?? {});
    const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body);

    if (serializedBody !== undefined && Buffer.byteLength(serializedBody, 'utf8') > 1_048_576) {
      throw new Error('Joomla API request body exceeds the 1048576-byte limit.');
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.api+json',
      'User-Agent': 'JoomEngine-MCP-for-Joomla/0.4',
    };

    if (request.authentication === 'joomla-update-token') {
      if (config.updateToken === undefined) {
        throw new Error('The Joomla Update token is not configured for this site.');
      }

      headers['X-JUpdate-Token'] = config.updateToken;
    } else {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    if (serializedBody !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (request.etag !== undefined) {
      headers['If-Match'] = request.etag;
    }

    if (request.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    const response = await fetch(url, {
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });

    const body = await boundedBody(response, config.maxResponseBytes);
    const data = decodeBody(body, response.headers.get('content-type'));

    if (!response.ok) {
      throw new Error(`Joomla API returned HTTP ${response.status}: ${safeErrorSummary(data)}`);
    }

    return {
      status: response.status,
      headers: selectedHeaders(response.headers),
      data,
    };
  }

  private url(
    config: ApiConfig,
    path: string,
    query: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>,
  ): URL {
    if (!/^v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path) || path.includes('..')) {
      throw new Error('Internal Joomla API action contains an invalid path.');
    }

    const origin = new URL(config.baseUrl);
    origin.pathname = `${origin.pathname.replace(/\/$/, '')}/api/index.php/${path}`;

    for (const [key, rawValue] of Object.entries(query)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];

      for (const value of values) {
        origin.searchParams.append(key, String(value));
      }
    }

    return origin;
  }
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');

  if (contentLength !== null && Number(contentLength) > maximum) {
    throw new Error(`Joomla API response exceeds the ${maximum}-byte limit.`);
  }

  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;

      if (total > maximum) {
        await reader.cancel();
        throw new Error(`Joomla API response exceeds the ${maximum}-byte limit.`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function decodeBody(body: Uint8Array, contentType: string | null): unknown {
  if (body.byteLength === 0) {
    return null;
  }

  const text = new TextDecoder().decode(body);

  if (contentType?.includes('json') === true) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Joomla API returned malformed JSON.');
    }
  }

  return text;
}

function selectedHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const name of [
    'content-type',
    'etag',
    'last-modified',
    'location',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
  ]) {
    const value = headers.get(name);

    if (value !== null) {
      result[name] = value;
    }
  }

  return result;
}

function safeErrorSummary(data: unknown): string {
  const serialized = typeof data === 'string' ? data : (JSON.stringify(data) ?? String(data));
  return serialized.slice(0, 2_000);
}
