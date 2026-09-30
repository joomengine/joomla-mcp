import { describe, expect, it } from 'vitest';

import { selectExtensionStateFixture } from '../src/live-test/runner.js';

const safePlugin = Object.freeze({
  extensionId: 501, type: 'plugin', element: 'optional', folder: 'content',
  name: 'Optional content plugin', enabled: false, protected: false,
});

describe('live extension state fixture selection', () => {
  it('requests a filtered plugin collection instead of depending on the unfiltered first page', async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const fixture = await selectExtensionStateFixture(async (input) => {
      requests.push(input);
      return { mutation: { protocol: 'joomla-mcp/1', id: 'correlation', data: { items: [safePlugin] } } };
    });
    expect(requests).toEqual([{ type: 'plugin', offset: 0, limit: 100 }]);
    expect(fixture).toMatchObject({ id: 501, attributes: { enabled: false, protected: false } });
  });

  it('moves across bounded pages when the first plugin page contains no safe disabled plugin', async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const unavailable = Array.from({ length: 100 }, (_, index) => ({
      ...safePlugin, extensionId: index + 1, enabled: true,
    }));
    const fixture = await selectExtensionStateFixture(async (input) => {
      requests.push(input);
      return { items: input['offset'] === 0 ? unavailable : [safePlugin] };
    });
    expect(requests).toEqual([
      { type: 'plugin', offset: 0, limit: 100 },
      { type: 'plugin', offset: 100, limit: 100 },
    ]);
    expect(fixture?.id).toBe(501);
  });

  it('rejects components, protected plugins, critical runtime plugins and unknown flags', async () => {
    const unavailable = [
      { ...safePlugin, type: 'component' },
      { ...safePlugin, protected: true },
      { ...safePlugin, enabled: true },
      { ...safePlugin, protected: null },
      { ...safePlugin, enabled: null },
      { ...safePlugin, protected: undefined },
      { ...safePlugin, folder: '' },
      { ...safePlugin, extensionId: 0 },
      { ...safePlugin, element: 'api_token' },
      { ...safePlugin, element: 'confirmconsent' },
      { ...safePlugin, element: 'joomengine_mcp' },
      ...['authentication', 'api-authentication', 'behaviour', 'system', 'user', 'console', 'webservices', 'multifactorauth']
        .map((folder) => ({ ...safePlugin, folder })),
    ];
    expect(await selectExtensionStateFixture(async () => ({ items: unavailable }))).toBeUndefined();
  });

  it('retains the original selected state and stops after at most ten pages', async () => {
    const requests: Readonly<Record<string, unknown>>[] = [];
    const record = { id: '501', attributes: { ...safePlugin, enabled: '0', protected: '0' } };
    const fixture = await selectExtensionStateFixture(async () => ({ data: [record] }));
    record.attributes.enabled = '1';
    expect(fixture?.attributes['enabled']).toBe('0');
    const unavailable = Array.from({ length: 100 }, (_, index) => ({ ...safePlugin, extensionId: index + 1, enabled: true }));
    expect(await selectExtensionStateFixture(async (input) => {
      requests.push(input);
      return { items: unavailable };
    })).toBeUndefined();
    expect(requests).toHaveLength(10);
    expect(requests.at(-1)).toEqual({ type: 'plugin', offset: 900, limit: 100 });
  });

  it('stops on an empty collection and preserves native read failures as failures', async () => {
    let reads = 0;
    expect(await selectExtensionStateFixture(async () => { reads++; return { items: [] }; })).toBeUndefined();
    expect(reads).toBe(1);
    await expect(selectExtensionStateFixture(async () => { throw new Error('Native extension read failed'); }))
      .rejects.toThrow('Native extension read failed');
  });
});
