import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JwksJwtVerifier } from '../src/security/jwks-jwt-verifier.js';

describe('JwksJwtVerifier', () => {
  it('cryptographically verifies a supported JWT and caches its trusted JWKS', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const verifier = new JwksJwtVerifier({ jwksUrl: 'https://issuer.example.test/jwks', fetch: fetchMock });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://issuer.example.test', sub: 'user-1' })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const token = `${header}.${payload}.${signature}`;

    await expect(verifier.warm()).resolves.toBeUndefined();
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: 'user-1' });
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: 'user-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unsigned and tampered tokens', async () => {
    const verifier = new JwksJwtVerifier({
      jwksUrl: 'https://issuer.example.test/jwks',
      fetch: vi.fn(async () => new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'x' }] }))),
    });

    await expect(verifier.verify('eyJhbGciOiJub25lIiwia2lkIjoieCJ9.e30.x')).rejects.toThrow('algorithm');
  });
});
