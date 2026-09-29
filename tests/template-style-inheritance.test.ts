import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { ApiConfig, Configuration } from '../src/config/schema.js';
import type { JoomlaApiRequest } from '../src/infrastructure/api/joomla-api-client.js';

function harness(client = 0, maxPageSize = 100) {
  const configuration: Configuration = {
    defaultSite: 'test', approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
    sites: new Map([['test', { id: 'test', toolsets: new Set(['structure.read', 'structure.write']),
      api: { baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
        maxResponseBytes: 1_000_000, maxPageSize } }]]),
  };
  const path = `v1/templates/styles/${client === 0 ? 'site' : 'administrator'}`;
  let xml: unknown = { name: 'Child template', parent: 'cassiopeia' };
  let rows = [resource(1, 'child', client)];
  let stored: Record<string, unknown> = {};
  const api = {
    get: vi.fn(async (_config: ApiConfig, requested: string, query?: Readonly<Record<string, unknown>>) => {
      if (requested === path) {
        const offset = Number(query?.['page[offset]'] ?? 0);
        return response(rows.slice(offset, offset + maxPageSize));
      }
      if (requested === `${path}/41`) return response({ id: '41', attributes: stored });
      const row = rows.find((candidate) => `${path}/${candidate.id}` === requested);
      return response({ ...row, attributes: { ...row?.attributes, xml } });
    }),
    request: vi.fn(async (_config: ApiConfig, request: JoomlaApiRequest) => {
      stored = { ...request.body };
      return response({ id: '41' });
    }),
  };
  const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api);
  const plan = (data: Record<string, unknown> = { template: 'child', title: 'New style' }, dryRun = false) => service.planAction({
    action: `templates.${client === 0 ? 'site' : 'administrator'}-styles.create`, input: { data },
    transport: 'api', idempotencyKey: randomUUID(), dryRun,
  });
  return { service, api, plan, path, configuration, setXml: (value: unknown) => { xml = value; },
    setRows: (value: typeof rows) => { rows = value; } };
}
function response(data: unknown) { return { status: 200, headers: {}, data: { data } }; }
function resource(id: number, template: string, client_id: number) {
  return { id: String(id), attributes: { template, client_id } };
}
async function grant(service: JoomlaWriteService) {
  const request = await service.requestPermission({ toolsets: ['structure.write'], duration: '30-minutes', reason: 'Test inheritance.' });
  await service.approvePermission(request.requestId, request.acknowledgement);
}

describe.each([0, 1])('template style client %d', (client) => {
  it.each([true, false])('checks remote read scope before metadata lookup for dryRun=%s', async (dryRun) => {
    const { service, api } = harness(client);
    await grant(service);
    const authorizeRead = vi.fn((_site: string, toolset: string) => {
      if (toolset === 'structure.read') throw new Error('Remote template read scope denied.');
    });

    await expect(service.planAction({
      action: `templates.${client === 0 ? 'site' : 'administrator'}-styles.create`,
      input: { data: { template: 'child', title: 'New style' } },
      transport: 'api', idempotencyKey: randomUUID(), dryRun,
    }, 'local-stdio', authorizeRead)).rejects.toThrow('Remote template read scope denied.');

    expect(authorizeRead).toHaveBeenCalledExactlyOnceWith('test', 'structure.read');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('preserves the confirmation when remote read scope is revoked before apply', async () => {
    const { service, api, plan } = harness(client);
    await grant(service);
    const result = await plan();
    if (!('confirmationToken' in result)) throw new Error('Missing confirmation.');
    api.get.mockClear();
    const denyRead = vi.fn((_site: string, toolset: string) => {
      if (toolset === 'structure.read') throw new Error('Remote template read scope revoked.');
    });

    await expect(service.apply(result.confirmationToken, 'local-stdio', denyRead))
      .rejects.toThrow('Remote template read scope revoked.');

    expect(denyRead.mock.calls).toEqual([['test', 'structure.write'], ['test', 'structure.read']]);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();

    const allowRead = vi.fn();
    await expect(service.apply(result.confirmationToken, 'local-stdio', allowRead))
      .resolves.toMatchObject({ idempotentReplay: false });
    expect(allowRead.mock.calls).toEqual([['test', 'structure.write'], ['test', 'structure.read']]);
    expect(api.get).toHaveBeenCalled();
    expect(api.request).toHaveBeenCalledTimes(1);
    await expect(service.apply(result.confirmationToken)).rejects.toThrow('already been used');
  });

  it('binds native child inheritance to the approved create and stores it', async () => {
    const { service, api, plan, path } = harness(client);
    await grant(service);
    const input = Object.freeze({ template: 'child', title: 'New child style', params: { colorName: 'custom' } });
    const result = await plan(input);
    expect(result.operation.preflight).toEqual({ template: 'child', parent: 'cassiopeia', inheritable: 0 });
    expect(api.request).not.toHaveBeenCalled();
    if (!('confirmationToken' in result)) throw new Error('Missing confirmation.');
    const applied = await service.apply(result.confirmationToken);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      method: 'POST', path, body: { ...input, client_id: client, parent: 'cassiopeia', inheritable: 0 },
    }));
    expect(applied).toMatchObject({ verification: { data: { data: { attributes: { parent: 'cassiopeia', inheritable: 0 } } } } });
    expect(input).not.toHaveProperty('parent');
  });
});

describe('template inheritance safety', () => {
  it.each([
    { name: 'standalone', xml: { name: 'Standalone' }, expected: { parent: '', inheritable: 0 } },
    { name: 'inheritable parent', xml: { name: 'Cassiopeia', inheritable: '1' }, expected: { parent: '', inheritable: 1 } },
    { name: 'empty SimpleXML elements', xml: { name: 'Standalone', parent: {}, inheritable: {} }, expected: { parent: '', inheritable: 0 } },
    { name: 'zero strings', xml: { name: 'Child', parent: 'cassiopeia', inheritable: '0' }, expected: { parent: 'cassiopeia', inheritable: 0 } },
  ])('handles $name without mutating preview', async ({ xml, expected }) => {
    const { plan, api, setXml } = harness();
    setXml(xml);
    const result = await plan(undefined, true);
    expect(result.operation.preflight).toMatchObject(expected);
    expect(result).not.toHaveProperty('confirmationToken');
    expect(api.request).not.toHaveBeenCalled();
  });
  it.each([null, {}, [], '<xml/>', { name: 'Bad', parent: ['cassiopeia'] }, { name: 'Bad', parent: '../cassiopeia' },
    { name: 'Bad', parent: 'child' }, { name: 'Bad', inheritable: 'true' }, { name: 'Bad', inheritable: null },
    { name: 'Bad', '@attributes': { type: 'module' } }, { name: 'Bad', '@attributes': { client: 'administrator' } }])(
    'rejects malformed metadata %j before writing', async (xml) => {
      const { plan, api, setXml } = harness();
      setXml(xml);
      await expect(plan(undefined, true)).rejects.toThrow(/metadata/);
      expect(api.request).not.toHaveBeenCalled();
    });
  it('requires a grant before any source read', async () => {
    const { plan, api } = harness();
    await expect(plan()).rejects.toThrow('No active operator permission grant');
    expect(api.get).not.toHaveBeenCalled();
  });
  it('requires the read toolset before metadata lookup', async () => {
    const { plan, api, configuration } = harness();
    (configuration.sites.get('test')!.toolsets as Set<string>).delete('structure.read');
    await expect(plan(undefined, true)).rejects.toThrow(/structure.read/);
    expect(api.get).not.toHaveBeenCalled();
  });
  it('refuses unknown installed templates and incorrectly scoped sources', async () => {
    const { plan, api, setRows } = harness();
    setRows([]);
    await expect(plan(undefined, true)).rejects.toThrow('No existing style');
    setRows([resource(1, 'child', 1)]);
    await expect(plan(undefined, true)).rejects.toThrow('incorrectly scoped');
    expect(api.request).not.toHaveBeenCalled();
  });
  it('walks bounded pages and accepts duplicate styles with matching manifests', async () => {
    const { plan, api, setRows, path } = harness(0, 1);
    setRows([resource(1, 'other', 0), resource(2, 'child', 0), resource(3, 'child', 0)]);
    await plan(undefined, true);
    expect(api.get).toHaveBeenCalledWith(expect.anything(), path, { 'page[offset]': 3, 'page[limit]': 1 });
  });
  it('refuses collections beyond the page cap', async () => {
    const { plan, api, setRows } = harness(0, 1);
    setRows(Array.from({ length: 10 }, (_, i) => resource(i + 1, 'other', 0)));
    await expect(plan(undefined, true)).rejects.toThrow('10 page limit');
    expect(api.get).toHaveBeenCalledTimes(10);
  });
  it('refuses excessive matching styles before issuing more detail reads', async () => {
    const { plan, api, setRows } = harness();
    setRows(Array.from({ length: 21 }, (_, i) => resource(i + 1, 'child', 0)));
    await expect(plan(undefined, true)).rejects.toThrow('20 matching styles');
    expect(api.get).toHaveBeenCalledTimes(21);
  });
  it('rejects conflicting manifests instead of picking an arbitrary style', async () => {
    const { plan, api } = harness();
    api.get.mockResolvedValueOnce(response([resource(1, 'child', 0), resource(2, 'child', 0)]));
    api.get.mockResolvedValueOnce(response({ id: '1', attributes: { template: 'child', client_id: 0,
      xml: { name: 'Child', parent: 'cassiopeia' } } }));
    api.get.mockResolvedValueOnce(response({ id: '2', attributes: { template: 'child', client_id: 0,
      xml: { name: 'Child', parent: 'different' } } }));
    await expect(plan(undefined, true)).rejects.toThrow('conflicting inheritance');
    expect(api.request).not.toHaveBeenCalled();
  });
  it('rejects duplicate pages rather than cycling through metadata', async () => {
    const { plan, api } = harness(0, 1);
    api.get.mockResolvedValue(response([resource(1, 'other', 0)]));
    await expect(plan(undefined, true)).rejects.toThrow('duplicate');
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it('rechecks revoked permission before reading metadata or applying', async () => {
    const { plan, service, api } = harness();
    await grant(service);
    const result = await plan();
    if (!('confirmationToken' in result)) throw new Error('Missing confirmation.');
    await service.revokePermission(service.listPermissions()[0]!.id);
    api.get.mockClear();
    await expect(service.apply(result.confirmationToken)).rejects.toThrow('permission grant');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });
  it('refuses metadata changes after approval', async () => {
    const { plan, service, api, setXml } = harness();
    await grant(service);
    const result = await plan();
    if (!('confirmationToken' in result)) throw new Error('Missing confirmation.');
    setXml({ name: 'Child', parent: 'different' });
    await expect(service.apply(result.confirmationToken)).rejects.toThrow('changed after planning');
    expect(api.request).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied inheritance', async () => {
    const { plan, api } = harness();
    await expect(plan({ template: 'child', title: 'Bad', parent: 'arbitrary' }, true)).rejects.toThrow(/parent/);
    expect(api.get).not.toHaveBeenCalled();
  });
});
