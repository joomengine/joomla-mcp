import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { Configuration } from '../src/config/schema.js';
import type { CompanionEnvelope, JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([['test', {
    id: 'test', toolsets: new Set(['structure.write', 'content.write', 'cli.discovery']),
    api: {
      baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
      maxResponseBytes: 1_000_000, maxPageSize: 100,
    },
    cli: { root: '/srv/joomla', phpBinary: '/usr/bin/php', timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
  }]]),
};

const cases: readonly { readonly base: string; readonly data: Readonly<Record<string, unknown>> }[] = [
  { base: 'content.categories', data: { title: 'Category', parent_id: 1, params: { category_layout: '_:default' } } },
  { base: 'menus.site-items', data: {
    menutype: 'mainmenu', title: 'Article', type: 'component', parent_id: 1,
    link: 'index.php?option=com_content&view=article&id=42', params: { show_title: 1 },
  } },
  { base: 'menus.administrator-items', data: {
    menutype: 'main', title: 'Dashboard', type: 'component', parent_id: 1,
    link: 'index.php?option=com_cpanel&view=cpanel',
  } },
  { base: 'modules.site', data: {
    title: 'Module', module: 'mod_custom', content: '<p>Content</p>', assigned: [132], params: { prepare_content: 0 },
  } },
  { base: 'modules.administrator', data: {
    title: 'Administrator module', module: 'mod_custom', assigned: [0], params: { prepare_content: 1 },
  } },
  { base: 'fields.content-articles', data: {
    title: 'Reference', name: 'reference', type: 'text', fieldparams: { maxlength: 100 },
  } },
  { base: 'templates.site-styles', data: {
    template: 'cassiopeia', title: 'Site style', params: { brand: 1, logoFile: 'images/logo.svg' },
  } },
  { base: 'templates.administrator-styles', data: {
    template: 'atum', title: 'Administrator style', params: { hue: 214 },
  } },
];

const apiOnlyFields = new Set(['extension', 'client_id', 'context', 'assignment', 'request', 'component_id']);

/** Model the native companion's rejection of controller/form-only API fields. */
function strictCompanion(action: string) {
  let stored: Readonly<Record<string, unknown>> | undefined;
  const envelope = (data: unknown): CompanionEnvelope => ({
    command: ['/usr/bin/php'], exitCode: 0, stdout: '{}', stderr: '', durationMs: 1,
    timedOut: false, truncated: false, data,
  });
  const cli = {
    list: vi.fn(), help: vi.fn(), inventory: vi.fn(),
    describe: vi.fn(async () => envelope({ protocol: 'joomla-mcp/1',
      actions: [{ name: action, effective: { allowed: true } }] })),
    dispatch: vi.fn(async (_config, dispatchedAction, input) => {
      if (dispatchedAction !== action) throw new Error('Unexpected companion action.');
      const data = input['data'] as Readonly<Record<string, unknown>>;
      for (const field of Object.keys(data)) {
        if (apiOnlyFields.has(field)) throw new Error(`Companion rejects API-only field: ${field}.`);
      }
      const dryRun = input['dryRun'] === true;
      if (!dryRun) stored = structuredClone(data);
      return envelope({ protocol: 'joomla-mcp/1', ok: true,
        result: { id: 132, applied: !dryRun, dryRun } });
    }),
  } satisfies JoomlaCliTransport;
  const api = {
    get: vi.fn(async () => { throw new Error('Companion writes must not read the API.'); }),
    request: vi.fn(async () => { throw new Error('Companion writes must not dispatch through the API.'); }),
  };
  const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api, undefined, cli);
  return { service, cli, api, stored: () => stored };
}

async function grant(service: JoomlaWriteService): Promise<void> {
  const permission = await service.requestPermission({
    toolsets: ['structure.write', 'content.write'], duration: '30-minutes',
    reason: 'Verify companion input preservation across supported native writes.',
  });
  await service.approvePermission(permission.requestId, permission.acknowledgement);
}

describe.each(['create', 'update'] as const)('companion %s input', (operation) => {
  it.each(cases)('preserves $base semantic fields through preview, preflight and apply', async ({ base, data }) => {
    const action = `${base}.${operation}`;
    const { service, cli, api, stored } = strictCompanion(action);
    const input = { ...(operation === 'update' ? { id: 132 } : {}), data: structuredClone(data) };
    const snapshot = structuredClone(input);
    const request = { action, input, transport: 'cli' as const, idempotencyKey: randomUUID() };

    const preview = await service.planAction({ ...request, dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, operation: { transport: 'cli' } });
    expect(preview).not.toHaveProperty('confirmationToken');
    expect(stored()).toBeUndefined();

    await grant(service);
    const plan = await service.planAction(request);
    if (!('confirmationToken' in plan)) throw new Error('Expected a companion confirmation plan.');
    const result = await service.apply(plan.confirmationToken);
    expect(result).toMatchObject({ verification: { acknowledgedBy: 'joomla-companion' } });

    // The native driver owns extension, client, context and form-state defaults.
    expect(cli.dispatch).toHaveBeenCalledTimes(4);
    for (const invocation of [1, 2, 3]) {
      expect(cli.dispatch).toHaveBeenNthCalledWith(invocation, expect.anything(), action, { ...snapshot, dryRun: true });
    }
    expect(cli.dispatch).toHaveBeenLastCalledWith(expect.anything(), action, {
      ...snapshot, dryRun: false, _edgeConfirmed: true,
    });
    expect(stored()).toEqual(data);
    expect(input).toEqual(snapshot);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();
  });

  it('still normalizes the article editor body for the companion', async () => {
    const action = `content.articles.${operation}`;
    const { service, cli, stored } = strictCompanion(action);
    await grant(service);
    const fields = operation === 'create' ? { title: 'Article', catid: 2 } : {};
    const input = {
      ...(operation === 'update' ? { id: 132 } : {}),
      data: { ...fields, articletext: '<p>Intro</p><hr id="system-readmore" /><p>Full</p>' },
    };
    const plan = await service.planAction({ action, input, transport: 'cli', idempotencyKey: randomUUID() });
    if (!('confirmationToken' in plan)) throw new Error('Expected an article companion plan.');
    await service.apply(plan.confirmationToken);
    const native = { ...fields, introtext: '<p>Intro</p>', fulltext: '<p>Full</p>' };
    expect(stored()).toEqual(native);
    for (const [, , dispatched] of cli.dispatch.mock.calls) expect(dispatched['data']).toEqual(native);
    expect(input.data).toHaveProperty('articletext');
  });
});
