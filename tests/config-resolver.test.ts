import { describe, expect, it, vi } from 'vitest';

import { resolveConfiguration } from '../src/config/load.js';

describe('programmatic configuration resolution', () => {
  it('resolves referenced secrets through a host-provided asynchronous resolver', async () => {
    const resolveSecret = vi.fn(async ({ name }: { readonly name: string }) => ({
      APPROVAL_SECRET: 'approval-secret-with-more-than-thirty-two-characters',
      SITE_TOKEN: 'joomla-api-token',
      UPDATE_TOKEN: 'joomla-update-token',
    })[name]);
    const configuration = await resolveConfiguration({
      defaultSite: 'customer',
      approval: {
        secretEnv: 'APPROVAL_SECRET',
        allowIndefinite: false,
      },
      sites: {
        customer: {
          toolsets: ['discovery', 'content.read'],
          api: {
            baseUrl: 'https://joomla.example',
            tokenEnv: 'SITE_TOKEN',
            updateTokenEnv: 'UPDATE_TOKEN',
          },
        },
      },
    }, {
      source: 'customer configuration',
      resolveSecret,
    });

    expect(resolveSecret).toHaveBeenCalledWith({
      name: 'APPROVAL_SECRET',
      purpose: 'approval-secret',
    });
    expect(resolveSecret).toHaveBeenCalledWith({
      name: 'SITE_TOKEN',
      purpose: 'api-token',
      site: 'customer',
    });
    expect(resolveSecret).toHaveBeenCalledWith({
      name: 'UPDATE_TOKEN',
      purpose: 'api-update-token',
      site: 'customer',
    });
    expect(configuration.sites.get('customer')?.api).toMatchObject({
      token: 'joomla-api-token',
      updateToken: 'joomla-update-token',
      timeoutMs: 30_000,
      maxPageSize: 100,
    });
  });

  it('attributes schema errors to the supplied host configuration source', async () => {
    await expect(resolveConfiguration(
      { defaultSite: 'missing', sites: {} },
      { source: 'tenant 42' },
    )).rejects.toThrow('Invalid configuration tenant 42');
  });
});
