import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

export interface RequestBoundaryPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly requireOrigin?: boolean;
  readonly maxHeaderBytes?: number;
}

export type RequestPolicyFailureCode =
  | 'host_missing'
  | 'host_duplicate'
  | 'host_forbidden'
  | 'origin_missing'
  | 'origin_duplicate'
  | 'origin_forbidden'
  | 'headers_too_large';

export class RequestPolicyError extends Error {
  readonly status: 400 | 403 | 431;
  readonly code: RequestPolicyFailureCode;

  constructor(status: 400 | 403 | 431, code: RequestPolicyFailureCode, message: string) {
    super(message);
    this.name = 'RequestPolicyError';
    this.status = status;
    this.code = code;
  }
}

export class StrictRequestPolicy {
  readonly #hosts: ReadonlySet<string>;
  readonly #origins: ReadonlySet<string>;
  readonly #requireOrigin: boolean;
  readonly #maxHeaderBytes: number;

  constructor(policy: RequestBoundaryPolicy) {
    if (policy.allowedHosts.length === 0) {
      throw new TypeError('At least one exact allowed Host value is required.');
    }
    this.#hosts = new Set(policy.allowedHosts.map(normalizeConfiguredHost));
    this.#origins = new Set(policy.allowedOrigins.map(normalizeConfiguredOrigin));
    this.#requireOrigin = policy.requireOrigin ?? false;
    this.#maxHeaderBytes = policy.maxHeaderBytes ?? 16_384;
    if (!Number.isSafeInteger(this.#maxHeaderBytes) || this.#maxHeaderBytes < 1_024 || this.#maxHeaderBytes > 65_536) {
      throw new TypeError('maxHeaderBytes must be an integer between 1024 and 65536.');
    }
    if (this.#requireOrigin && this.#origins.size === 0) {
      throw new TypeError('requireOrigin needs at least one exact allowed Origin value.');
    }
  }

  assert(req: Pick<IncomingMessage, 'headers' | 'rawHeaders'>): void {
    if (rawHeaderBytes(req.rawHeaders) > this.#maxHeaderBytes) {
      throw new RequestPolicyError(431, 'headers_too_large', 'Request headers are too large.');
    }

    assertSingleRawHeader(req.rawHeaders, 'host', 'host_duplicate');
    const host = singleHeader(req.headers, 'host');
    if (host === undefined) {
      throw new RequestPolicyError(400, 'host_missing', 'Host is required.');
    }
    if (!this.#hosts.has(normalizeRequestHost(host))) {
      throw new RequestPolicyError(403, 'host_forbidden', 'Host is not allowed.');
    }

    assertSingleRawHeader(req.rawHeaders, 'origin', 'origin_duplicate');
    const origin = singleHeader(req.headers, 'origin');
    if (origin === undefined) {
      if (this.#requireOrigin) {
        throw new RequestPolicyError(403, 'origin_missing', 'Origin is required.');
      }
      return;
    }
    if (!this.#origins.has(normalizeRequestOrigin(origin))) {
      throw new RequestPolicyError(403, 'origin_forbidden', 'Origin is not allowed.');
    }
  }
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    throw new RequestPolicyError(400, name === 'host' ? 'host_duplicate' : 'origin_duplicate', `Duplicate ${name} headers are not accepted.`);
  }
  return value;
}

function assertSingleRawHeader(
  rawHeaders: readonly string[],
  name: 'host' | 'origin',
  code: 'host_duplicate' | 'origin_duplicate',
): void {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  if (count > 1) {
    throw new RequestPolicyError(400, code, `Duplicate ${name} headers are not accepted.`);
  }
}

function rawHeaderBytes(rawHeaders: readonly string[]): number {
  return rawHeaders.reduce((total, value) => total + Buffer.byteLength(value) + 4, 2);
}

function normalizeConfiguredHost(value: string): string {
  if (value !== value.trim() || value.length === 0 || /[,/@\\\s]/u.test(value)) {
    throw new TypeError(`Invalid allowed Host value: ${value}`);
  }
  return normalizeHostWithUrl(value, TypeError);
}

function normalizeRequestHost(value: string): string {
  if (value !== value.trim() || value.length === 0 || /[,/@\\\s]/u.test(value)) {
    throw new RequestPolicyError(403, 'host_forbidden', 'Host is malformed.');
  }
  return normalizeHostWithUrl(value, RequestPolicyError);
}

function normalizeHostWithUrl(value: string, ErrorType: typeof TypeError | typeof RequestPolicyError): string {
  try {
    const url = new URL(`http://${value}`);
    if (url.hostname.length === 0 || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new Error('invalid');
    }
    return value.toLowerCase();
  } catch {
    if (ErrorType === TypeError) {
      throw new TypeError(`Invalid allowed Host value: ${value}`);
    }
    throw new RequestPolicyError(403, 'host_forbidden', 'Host is malformed.');
  }
}

function normalizeConfiguredOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.origin === 'null' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error('invalid');
    }
    if (url.origin !== value) {
      throw new Error('non-canonical');
    }
    return url.origin;
  } catch {
    throw new TypeError(`Invalid allowed Origin value: ${value}`);
  }
}

function normalizeRequestOrigin(value: string): string {
  try {
    const origin = normalizeConfiguredOrigin(value);
    if (origin !== value) {
      throw new Error('non-canonical');
    }
    return origin;
  } catch {
    throw new RequestPolicyError(403, 'origin_forbidden', 'Origin is malformed or not allowed.');
  }
}
