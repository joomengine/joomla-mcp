import {
  constants,
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import type { JwtClaims, JwtCryptographicVerifier } from '../http/auth.js';

interface JwtHeader {
  readonly alg: SupportedAlgorithm;
  readonly kid: string;
}

type SupportedAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA';

interface CachedJwks {
  readonly expiresAt: number;
  readonly keys: readonly JsonWebKey[];
}

export interface JwksJwtVerifierOptions {
  readonly jwksUrl: string;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export class JwksJwtVerifier implements JwtCryptographicVerifier {
  readonly #jwksUrl: URL;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cache?: CachedJwks;
  #loading: Promise<CachedJwks> | undefined;

  public constructor(options: JwksJwtVerifierOptions) {
    this.#jwksUrl = validateJwksUrl(options.jwksUrl);
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 1_000, 30_000, 'JWKS timeout');
    this.#cacheTtlMs = boundedInteger(options.cacheTtlMs ?? 300_000, 30_000, 3_600_000, 'JWKS cache TTL');
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  public async verify(token: string): Promise<JwtClaims> {
    if (token.length > 16_384) {
      throw new Error('JWT exceeds the size limit.');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new Error('JWT compact serialization is invalid.');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = parseHeader(encodedHeader);
    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
    const signature = decodeBase64Url(encodedSignature, 'JWT signature');
    let keys = await this.#keys(false);
    let jwk = selectKey(keys, header);

    if (jwk === undefined) {
      keys = await this.#keys(true);
      jwk = selectKey(keys, header);
    }
    if (jwk === undefined) {
      throw new Error('No trusted JWKS key matches the JWT kid and algorithm.');
    }

    const key = createPublicKey({ key: jwk, format: 'jwk' });
    assertKeyStrength(header.alg, key);
    if (!verify(header.alg, key, signingInput, signature)) {
      throw new Error('JWT signature is invalid.');
    }

    const claims = parseJsonObject(decodeBase64Url(encodedPayload, 'JWT payload').toString('utf8'), 'JWT payload');
    return claims;
  }

  public async warm(): Promise<void> {
    await this.#keys(false);
  }

  async #keys(force: boolean): Promise<readonly JsonWebKey[]> {
    if (!force && this.#cache !== undefined && this.#cache.expiresAt > this.#now()) {
      return this.#cache.keys;
    }

    if (this.#loading === undefined) {
      this.#loading = this.#download().finally(() => {
        this.#loading = undefined;
      });
    }

    this.#cache = await this.#loading;
    return this.#cache.keys;
  }

  async #download(): Promise<CachedJwks> {
    const response = await this.#fetch(this.#jwksUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: { Accept: 'application/jwk-set+json, application/json' },
    });

    if (!response.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${response.status}.`);
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > 1_048_576) {
      throw new Error('JWKS response exceeds the size limit.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 1_048_576) {
      throw new Error('JWKS response exceeds the size limit.');
    }
    const document = parseJsonObject(new TextDecoder().decode(bytes), 'JWKS response');
    if (!Array.isArray(document['keys']) || document['keys'].length === 0 || document['keys'].length > 100) {
      throw new Error('JWKS response must contain between 1 and 100 keys.');
    }
    const keys = document['keys'].filter(isUsableJwk);
    if (keys.length === 0) {
      throw new Error('JWKS response contains no usable signing keys.');
    }

    return { keys, expiresAt: this.#now() + this.#cacheTtlMs };
  }
}

function parseHeader(encoded: string): JwtHeader {
  const value = parseJsonObject(decodeBase64Url(encoded, 'JWT header').toString('utf8'), 'JWT header');
  const supported: readonly string[] = [
    'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA',
  ];
  if (typeof value['alg'] !== 'string' || !supported.includes(value['alg'])) {
    throw new Error('JWT algorithm is not supported.');
  }
  if (typeof value['kid'] !== 'string' || value['kid'].length === 0 || value['kid'].length > 256) {
    throw new Error('JWT kid is invalid.');
  }
  if (value['crit'] !== undefined) {
    throw new Error('JWT critical extensions are not supported.');
  }
  return { alg: value['alg'] as SupportedAlgorithm, kid: value['kid'] };
}

function selectKey(keys: readonly JsonWebKey[], header: JwtHeader): JsonWebKey | undefined {
  const matches = keys.filter(
    (key) => key.kid === header.kid && (key.alg === undefined || key.alg === header.alg) && (key.use === undefined || key.use === 'sig'),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function verify(algorithm: SupportedAlgorithm, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  if (algorithm === 'EdDSA') {
    return verifySignature(null, data, key, signature);
  }
  const digest = `sha${algorithm.slice(-3)}`;
  if (algorithm.startsWith('PS')) {
    return verifySignature(digest, data, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: Number(algorithm.slice(-3)) / 8,
    }, signature);
  }
  if (algorithm.startsWith('ES')) {
    return verifySignature(digest, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  return verifySignature(digest, data, key, signature);
}

function assertKeyStrength(algorithm: SupportedAlgorithm, key: KeyObject): void {
  const details = key.asymmetricKeyDetails;

  if (algorithm.startsWith('RS') || algorithm.startsWith('PS')) {
    if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'rsa-pss') {
      throw new Error('JWT algorithm and JWKS key type do not match.');
    }
    if ((details?.modulusLength ?? 0) < 2_048) {
      throw new Error('JWKS RSA signing keys must be at least 2048 bits.');
    }
    return;
  }

  if (algorithm.startsWith('ES')) {
    const expectedCurve: Readonly<Record<string, string>> = {
      ES256: 'prime256v1',
      ES384: 'secp384r1',
      ES512: 'secp521r1',
    };
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== expectedCurve[algorithm]) {
      throw new Error('JWT algorithm and EC signing curve do not match.');
    }
    return;
  }

  if (key.asymmetricKeyType !== 'ed25519' && key.asymmetricKeyType !== 'ed448') {
    throw new Error('JWT EdDSA algorithm requires an Ed25519 or Ed448 key.');
  }
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} is not base64url.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value.replace(/=+$/u, '')) {
    throw new Error(`${label} is not canonical base64url.`);
  }
  return decoded;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function isUsableJwk(value: unknown): value is JsonWebKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  return typeof key['kty'] === 'string' && typeof key['kid'] === 'string' && key['kid'].length <= 256;
}

function validateJwksUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' ||
    (url.port !== '' && url.port !== '443')
  ) {
    throw new TypeError('JWKS URL must be a credential-free HTTPS URL on the standard port.');
  }
  return url;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
