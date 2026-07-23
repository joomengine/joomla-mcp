import { describe, expect, it } from 'vitest';

import {
  AuthorizationError,
  authorizeBearerJwt,
  parseBearerJwt,
  type JwtCryptographicVerifier,
} from '../src/http/auth.js';

const NOW = 2_000_000_000;
const token = 'header.payload.signature';
const policy = {
  issuer: 'https://identity.example.test',
  audience: 'https://mcp.example.test',
  requiredScopes: ['mcp:read', 'joomla:read'],
  clockToleranceSeconds: 0,
} as const;

describe('remote HTTP bearer JWT authorization', () => {
  it('accepts only cryptographically verified claims matching issuer, audience, lifetime, and scopes', async () => {
    const verifier: JwtCryptographicVerifier = {
      verify: async () => ({
        iss: policy.issuer,
        aud: ['another-audience', policy.audience],
        sub: 'user-123',
        client_id: 'client-456',
        exp: NOW + 300,
        nbf: NOW - 1,
        scope: 'mcp:read joomla:read extra',
      }),
    };

    const principal = await authorizeBearerJwt(`Bearer ${token}`, verifier, policy, NOW);

    expect(principal.subject).toBe('user-123');
    expect(principal.clientId).toBe('client-456');
    expect(principal.authInfo.scopes).toEqual(['mcp:read', 'joomla:read', 'extra']);
    expect(principal.authInfo.expiresAt).toBe(NOW + 300);
  });

  it.each([
    [{ iss: 'wrong', aud: policy.audience, sub: 'subject', exp: NOW + 1, scope: 'mcp:read joomla:read' }, 'issuer_invalid'],
    [{ iss: policy.issuer, aud: 'wrong', sub: 'subject', exp: NOW + 1, scope: 'mcp:read joomla:read' }, 'audience_invalid'],
    [{ iss: policy.issuer, aud: policy.audience, sub: 'subject', exp: NOW, scope: 'mcp:read joomla:read' }, 'token_expired'],
    [{ iss: policy.issuer, aud: policy.audience, sub: 'subject', exp: NOW + 1, scope: 'mcp:read' }, 'scope_insufficient'],
  ])('rejects policy-invalid verified claims', async (claims, code) => {
    await expect(
      authorizeBearerJwt(`Bearer ${token}`, { verify: async () => claims }, policy, NOW),
    ).rejects.toMatchObject({ code });
  });

  it('turns verifier failures into a non-disclosing authentication failure', async () => {
    await expect(
      authorizeBearerJwt(
        `Bearer ${token}`,
        { verify: async () => Promise.reject(new Error('secret verifier detail')) },
        policy,
        NOW,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'token_invalid', message: 'The bearer token could not be verified.' });
  });

  it('rejects missing, duplicate, opaque, and structurally invalid bearer credentials', () => {
    for (const header of [undefined, ['Bearer a.b.c', 'Bearer d.e.f'], 'Bearer opaque', 'Basic a.b.c']) {
      expect(() => parseBearerJwt(header)).toThrow(AuthorizationError);
    }
  });
});
