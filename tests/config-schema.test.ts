import { describe, expect, it } from 'vitest';

import { RawConfigurationSchema } from '../src/config/schema.js';

describe('RawConfigurationSchema', () => {
  it('accepts a fixed HTTPS Joomla site', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'production',
      sites: {
        production: {
          toolsets: ['discovery', 'content.read'],
          api: {
            baseUrl: 'https://example.test',
            tokenEnv: 'JOOMLA_TOKEN',
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects HTTP origins and unknown default sites', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'missing',
      sites: {
        production: {
          toolsets: ['discovery'],
          api: {
            baseUrl: 'http://example.test',
            tokenEnv: 'JOOMLA_TOKEN',
          },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('HTTPS');
    expect(result.error?.message).toContain('defaultSite');
  });

  it('allows HTTP only for an explicitly opted-in loopback fixture', () => {
    const allowed = RawConfigurationSchema.safeParse({
      defaultSite: 'fixture',
      sites: {
        fixture: {
          toolsets: ['discovery'],
          api: {
            baseUrl: 'http://127.0.0.1:8080',
            tokenEnv: 'JOOMLA_TOKEN',
            allowInsecureLoopback: true,
          },
        },
      },
    });
    const forbidden = RawConfigurationSchema.safeParse({
      defaultSite: 'fixture',
      sites: {
        fixture: {
          toolsets: ['discovery'],
          api: {
            baseUrl: 'http://192.0.2.10',
            tokenEnv: 'JOOMLA_TOKEN',
            allowInsecureLoopback: true,
          },
        },
      },
    });

    expect(allowed.success).toBe(true);
    expect(forbidden.success).toBe(false);
  });

  it('validates a fixed HTTPS OAuth/JWKS remote transport policy', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'production',
      http: {
        allowedHosts: ['mcp.example.test'],
        issuer: 'https://identity.example.test/',
        audience: 'https://mcp.example.test',
        jwksUrl: 'https://identity.example.test/jwks',
      },
      sites: {
        production: {
          toolsets: ['discovery'],
          api: { baseUrl: 'https://example.test', tokenEnv: 'JOOMLA_TOKEN' },
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.http?.limits.maxTrackedPrincipals).toBe(10_000);
    expect(result.data?.http?.readinessPath).toBe('/readyz');
    expect(result.data?.http?.shutdownGraceMs).toBe(30_000);
  });

  it('rejects colliding liveness, readiness, and MCP paths', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'production',
      http: {
        mcpPath: '/mcp',
        healthPath: '/healthz',
        readinessPath: '/healthz',
        allowedHosts: ['mcp.example.test'],
        issuer: 'https://identity.example.test/',
        audience: 'https://mcp.example.test',
        jwksUrl: 'https://identity.example.test/jwks',
      },
      sites: {
        production: {
          toolsets: ['discovery'],
          api: { baseUrl: 'https://example.test', tokenEnv: 'JOOMLA_TOKEN' },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('must differ');
  });

  it('rejects insecure OAuth and JWKS URLs', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'production',
      http: {
        allowedHosts: ['mcp.example.test'],
        issuer: 'http://identity.example.test/',
        audience: 'http://mcp.example.test',
        jwksUrl: 'http://identity.example.test/jwks',
      },
      sites: {
        production: {
          toolsets: ['discovery'],
          api: { baseUrl: 'https://example.test', tokenEnv: 'JOOMLA_TOKEN' },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('must use HTTPS');
  });

  it('requires a durable grant store before indefinite permissions can be enabled', () => {
    const result = RawConfigurationSchema.safeParse({
      defaultSite: 'production',
      approval: {
        secretEnv: 'JOOMLA_APPROVAL_SECRET',
        allowIndefinite: true,
      },
      sites: {
        production: {
          toolsets: ['discovery', 'content.write'],
          api: { baseUrl: 'https://example.test', tokenEnv: 'JOOMLA_TOKEN' },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('grantStorePath');
  });
});
