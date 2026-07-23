import { describe, expect, it } from 'vitest';

import { AccessController, AccessLimitError } from '../src/http/access-limits.js';
import { RequestPolicyError, StrictRequestPolicy } from '../src/http/request-policy.js';

describe('remote HTTP request boundary policy', () => {
  const policy = new StrictRequestPolicy({
    allowedHosts: ['mcp.example.test:8443'],
    allowedOrigins: ['https://client.example.test'],
  });

  it('accepts exact canonical Host and Origin values', () => {
    expect(() =>
      policy.assert({
        headers: { host: 'mcp.example.test:8443', origin: 'https://client.example.test' },
        rawHeaders: ['Host', 'mcp.example.test:8443', 'Origin', 'https://client.example.test'],
      }),
    ).not.toThrow();
  });

  it.each([
    [{ host: 'evil.example.test:8443', origin: 'https://client.example.test' }, 'host_forbidden'],
    [{ host: 'mcp.example.test:8443', origin: 'https://evil.example.test' }, 'origin_forbidden'],
    [{ host: 'mcp.example.test:8443', origin: 'null' }, 'origin_forbidden'],
  ])('rejects DNS rebinding and cross-origin inputs', (headers, code) => {
    expect(() => policy.assert({ headers, rawHeaders: Object.entries(headers).flat() })).toThrowError(
      expect.objectContaining({ code }) as RequestPolicyError,
    );
  });

  it('rejects duplicated security headers even if Node normalized them', () => {
    expect(() =>
      policy.assert({
        headers: { host: 'mcp.example.test:8443' },
        rawHeaders: ['Host', 'mcp.example.test:8443', 'Host', 'mcp.example.test:8443'],
      }),
    ).toThrowError(expect.objectContaining({ code: 'host_duplicate' }) as RequestPolicyError);
  });
});

describe('remote HTTP access bounds', () => {
  it('enforces per-principal concurrency and token-bucket rate limits', () => {
    const access = new AccessController({
      maxConcurrentRequests: 2,
      maxConcurrentRequestsPerPrincipal: 1,
      requestsPerMinutePerPrincipal: 60,
      burstPerPrincipal: 1,
      maxTrackedPrincipals: 2,
    });
    const first = access.acquire('principal', 1_000);
    expect(() => access.acquire('principal', 1_000)).toThrowError(
      expect.objectContaining({ code: 'principal_concurrency_exceeded' }) as AccessLimitError,
    );
    first.release();
    expect(() => access.acquire('principal', 1_000)).toThrowError(
      expect.objectContaining({ code: 'rate_exceeded' }) as AccessLimitError,
    );
    const replenished = access.acquire('principal', 2_000);
    replenished.release();
    expect(access.activeRequests).toBe(0);
  });
});
