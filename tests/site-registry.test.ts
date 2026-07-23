import { describe, expect, it } from 'vitest';

import { SiteRegistry } from '../src/application/site-registry.js';
import type { Configuration } from '../src/config/schema.js';

const configuration: Configuration = {
  defaultSite: 'one',
  sites: new Map([
    [
      'one',
      {
        id: 'one',
        toolsets: new Set(['discovery', 'content.read']),
        api: {
          baseUrl: 'https://example.test',
          tokenEnv: 'TOKEN',
          timeoutMs: 30_000,
          maxResponseBytes: 1_000_000,
          maxPageSize: 100,
          token: 'secret',
        },
      },
    ],
  ]),
};

describe('SiteRegistry', () => {
  it('uses the default alias and never includes credentials in its summary', () => {
    const registry = new SiteRegistry(configuration);

    expect(registry.get().id).toBe('one');
    expect(JSON.stringify(registry.summary())).not.toContain('secret');
  });

  it('enforces toolsets', () => {
    const registry = new SiteRegistry(configuration);
    const site = registry.get('one');

    expect(() => registry.requireToolset(site, 'content.read')).not.toThrow();
    expect(() => registry.requireToolset(site, 'extensions.read')).toThrow('disabled');
  });
});
