import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { ApiConfig, CliConfig, Configuration } from '../src/config/schema.js';
import type { JoomlaApiRequest } from '../src/infrastructure/api/joomla-api-client.js';
import type { CompanionEnvelope, JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';
import type { ConfirmationPlan } from '../src/security/confirmation-service.js';

const configuration: Configuration = {
  defaultSite: 'test',
  approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
  sites: new Map([
    ['test', {
      id: 'test',
      toolsets: new Set(['content.read', 'content.write', 'cli.discovery']),
      api: {
        baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000,
        maxResponseBytes: 1_000_000, maxPageSize: 100,
      },
      cli: { root: '/srv/joomla', phpBinary: '/usr/bin/php', timeoutMs: 30_000, maxOutputBytes: 1_000_000 },
    }],
  ]),
};

const oldBody = { introtext: '<p>Old introduction</p>', fulltext: '<p>Old full text</p>' };
type Planner = 'typed' | 'api' | 'cli';
type Operation = 'create' | 'update';

/** Model the native API binding only persisted article fields, ignoring the editor-only articletext field. */
function articleStorage(initial: Readonly<Record<string, unknown>> = oldBody) {
  let stored: Record<string, unknown> = { title: 'Existing article', catid: 2, ...initial };
  const persist = (data: Readonly<Record<string, unknown>>, create: boolean) => {
    if (create) stored = { introtext: '', fulltext: '' };
    for (const field of ['title', 'catid', 'introtext', 'fulltext']) {
      if (Object.hasOwn(data, field)) stored[field] = data[field];
    }
  };
  const read = () => ({ data: { id: '41', attributes: { ...stored } } });
  const api = {
    request: vi.fn(async (_config: ApiConfig, request: JoomlaApiRequest) => {
      persist(request.body ?? {}, request.method === 'POST');
      return { status: request.method === 'POST' ? 201 : 200, headers: {}, data: { data: { id: '41' } } };
    }),
    get: vi.fn(async (_config: ApiConfig, _path: string) => ({ status: 200, headers: {}, data: read() })),
  };
  return { api, persist, read };
}

function companion(storage: ReturnType<typeof articleStorage>) {
  const envelope = (data: unknown): CompanionEnvelope => ({
    command: ['/usr/bin/php'], exitCode: 0, stdout: '{}', stderr: '', durationMs: 1,
    timedOut: false, truncated: false, data,
  });
  const cli = {
    list: vi.fn(),
    help: vi.fn(),
    inventory: vi.fn(),
    describe: vi.fn(async () => envelope({
      protocol: 'joomla-mcp/1',
      actions: ['create', 'update'].map((operation) => ({
        name: `content.articles.${operation}`, effective: { allowed: true },
      })),
    })),
    dispatch: vi.fn(async (_config: CliConfig, action: string, input: Readonly<Record<string, unknown>>) => {
      const dryRun = input['dryRun'] === true;
      if (!dryRun) storage.persist(input['data'] as Readonly<Record<string, unknown>>, action.endsWith('.create'));
      return envelope({ protocol: 'joomla-mcp/1', ok: true, result: { id: 41, applied: !dryRun, dryRun } });
    }),
  } satisfies JoomlaCliTransport;
  return cli;
}

function harness() {
  const storage = articleStorage();
  const cli = companion(storage);
  const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), storage.api, undefined, cli);
  return { ...storage, cli, service };
}

async function grant(service: JoomlaWriteService): Promise<void> {
  const request = await service.requestPermission({
    toolsets: ['content.write'], duration: '30-minutes', reason: 'Verify native article body persistence.',
  });
  await service.approvePermission(request.requestId, request.acknowledgement);
}

async function plan(
  service: JoomlaWriteService,
  planner: Planner,
  operation: Operation,
  data: Readonly<Record<string, unknown>>,
  etag?: string,
): Promise<ConfirmationPlan> {
  const idempotencyKey = randomUUID();
  const result = planner === 'typed'
    ? await service.planArticle(operation === 'create'
      ? { operation, data, idempotencyKey }
      : { operation, id: 41, data, etag, idempotencyKey })
    : await service.planAction({
      action: `content.articles.${operation}`,
      input: { ...(operation === 'update' ? { id: 41 } : {}), data, ...(etag === undefined ? {} : { etag }) },
      transport: planner, idempotencyKey,
    });
  if (!('confirmationToken' in result)) throw new Error('Expected an executable confirmation plan.');
  return result;
}

describe.each(['typed', 'api'] as const)('%s article body writes', (planner) => {
  describe.each(['create', 'update'] as const)('%s', (operation) => {
    it.each([
      { name: 'a read-more body', articletext: '<p>New intro</p><hr id="system-readmore" /><p>New full</p>',
        expected: { introtext: '<p>New intro</p>', fulltext: '<p>New full</p>' } },
      { name: 'a body without a read-more marker', articletext: '<p>Replacement body</p>',
        expected: { introtext: '<p>Replacement body</p>', fulltext: '' } },
      { name: 'an empty body', articletext: '', expected: { introtext: '', fulltext: '' } },
    ])('persists $name and verifies the stored native body', async ({ articletext, expected }) => {
      const { service, api } = harness();
      await grant(service);
      const data = Object.freeze({ ...(operation === 'create' ? { title: 'New article', catid: 2 } : {}), articletext });
      const snapshot = { ...data };
      const etag = operation === 'update' ? '"article-41-v1"' : undefined;
      const planned = await plan(service, planner, operation, data, etag);
      expect(api.request).not.toHaveBeenCalled();
      const result = await service.apply(planned.confirmationToken);

      expect(api.request).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
        method: operation === 'create' ? 'POST' : 'PATCH',
        path: operation === 'create' ? 'v1/content/articles' : 'v1/content/articles/41',
        body: { ...(operation === 'create' ? { title: 'New article', catid: 2 } : {}), ...expected },
        ...(etag === undefined ? {} : { etag }),
      }));
      expect(api.get).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'v1/content/articles/41');
      expect(result).toMatchObject({
        verification: { data: { data: { id: '41', attributes: expected } } }, idempotentReplay: false,
      });
      expect(data).toEqual(snapshot);
    });
  });

  it.each([
    { name: 'introtext only', data: { introtext: '<p>New intro only</p>' },
      expected: { introtext: '<p>New intro only</p>', fulltext: oldBody.fulltext } },
    { name: 'fulltext only', data: { fulltext: '<p>New full only</p>' },
      expected: { introtext: oldBody.introtext, fulltext: '<p>New full only</p>' } },
    { name: 'title only', data: { title: 'Renamed article' }, expected: oldBody },
  ])('preserves the untouched body for $name updates', async ({ data, expected }) => {
    const { service, api } = harness();
    await grant(service);
    const planned = await plan(service, planner, 'update', data);
    const result = await service.apply(planned.confirmationToken);

    expect(api.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: data }));
    expect(result).toMatchObject({ verification: { data: { data: { attributes: expected } } } });
  });

  it('still requires an operator permission grant before planning a body write', async () => {
    const { service, api } = harness();
    await expect(plan(service, planner, 'update', { articletext: '<p>Unapproved</p>' }))
      .rejects.toThrow('No active operator permission grant');
    expect(api.request).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('honours permission revocation between body planning and application', async () => {
    const { service, api } = harness();
    await grant(service);
    const planned = await plan(service, planner, 'update', { articletext: '<p>Revoked</p>' });
    await service.revokePermission(service.listPermissions()[0]!.id);

    await expect(service.apply(planned.confirmationToken)).rejects.toThrow('permission grant');
    expect(api.request).not.toHaveBeenCalled();
  });
});

describe('Joomla article read-more compatibility', () => {
  it.each([
    { name: 'single-quoted marker', articletext: "intro<hr id='system-readmore'>full", introtext: 'intro', fulltext: 'full' },
    { name: 'case-insensitive marker', articletext: 'intro<HR ID="SYSTEM-READMORE"/>full', introtext: 'intro', fulltext: 'full' },
    { name: 'surrounding whitespace', articletext: ' intro \n<hr id="system-readmore">\n full \t', introtext: ' intro \n', fulltext: '\n full \t' },
    { name: 'first marker only', articletext: 'intro<hr id="system-readmore">full<hr id="system-readmore">tail',
      introtext: 'intro', fulltext: 'full<hr id="system-readmore">tail' },
    { name: 'ordinary horizontal rule', articletext: 'intro<hr>full', introtext: 'intro<hr>full', fulltext: '' },
    { name: 'extra attributes', articletext: 'intro<hr class="divider" id="system-readmore">full',
      introtext: 'intro<hr class="divider" id="system-readmore">full', fulltext: '' },
  ])('matches Joomla binding for $name', async ({ articletext, introtext, fulltext }) => {
    const { service } = harness();
    await grant(service);
    const planned = await plan(service, 'typed', 'update', { articletext });
    const result = await service.apply(planned.confirmationToken);
    expect(result).toMatchObject({ verification: { data: { data: { attributes: { introtext, fulltext } } } } });
  });
});

describe.each(['typed', 'api', 'cli'] as const)('%s article field ambiguity', (planner) => {
  it.each([
    { articletext: 'combined', introtext: 'explicit intro' },
    { articletext: 'combined', fulltext: 'explicit full' },
    { articletext: '', introtext: '' },
    { articletext: '', fulltext: '' },
  ])('rejects conflicting representations before dispatch: %j', async (data) => {
    const { service, api, cli } = harness();
    await grant(service);
    await expect(plan(service, planner, 'update', Object.freeze(data))).rejects.toThrow(/articletext/);
    expect(api.request).not.toHaveBeenCalled();
    expect(cli.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { articletext: null }, { articletext: 42 },
    { introtext: null }, { introtext: 42 },
    { fulltext: null }, { fulltext: 42 },
  ])('rejects non-string article body fields before dispatch: %j', async (data) => {
    const { service, api, cli } = harness();
    await grant(service);
    await expect(plan(service, planner, 'update', data)).rejects.toThrow(/string/);
    expect(api.request).not.toHaveBeenCalled();
    expect(cli.dispatch).not.toHaveBeenCalled();
  });
});

describe.each(['api', 'cli'] as const)('%s normalized article payload bounds', (transport) => {
  it('rejects a body whose native-field expansion exceeds the API payload limit', async () => {
    const { service, api, cli } = harness();
    const maximumBytes = 1_048_576;
    const overhead = Buffer.byteLength(JSON.stringify({ articletext: '' }), 'utf8');
    const articletext = 'x'.repeat(maximumBytes - overhead);
    const data = { articletext };
    expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBe(maximumBytes);
    expect(Buffer.byteLength(JSON.stringify({ introtext: articletext, fulltext: '' }), 'utf8')).toBeGreaterThan(maximumBytes);

    await expect(service.planAction({
      action: 'content.articles.update', input: { id: 41, data },
      transport, dryRun: true, idempotencyKey: randomUUID(),
    })).rejects.toThrow('1048576-byte limit');
    expect(api.request).not.toHaveBeenCalled();
    expect(cli.dispatch).not.toHaveBeenCalled();
  });
});

describe('article body companion dispatch', () => {
  it.each(['create', 'update'] as const)('uses the same native %s body in both preflights and application', async (operation) => {
    const { service, cli, api, read } = harness();
    await grant(service);
    const data = Object.freeze({
      ...(operation === 'create' ? { title: 'New companion article', catid: 2 } : {}),
      articletext: '<p>CLI intro</p><hr id="system-readmore" /><p>CLI full</p>',
    });
    const nativeData = {
      ...(operation === 'create' ? { title: 'New companion article', catid: 2 } : {}),
      introtext: '<p>CLI intro</p>', fulltext: '<p>CLI full</p>',
    };
    const planned = await plan(service, 'cli', operation, data);
    expect(read().data.attributes).toMatchObject(oldBody);
    await service.apply(planned.confirmationToken);

    for (const invocation of [1, 2]) {
      expect(cli.dispatch).toHaveBeenNthCalledWith(invocation, expect.anything(), `content.articles.${operation}`, {
        ...(operation === 'update' ? { id: 41 } : {}), data: nativeData, dryRun: true,
      });
    }
    expect(cli.dispatch).toHaveBeenNthCalledWith(3, expect.anything(), `content.articles.${operation}`, {
      ...(operation === 'update' ? { id: 41 } : {}), data: nativeData, dryRun: false, _edgeConfirmed: true,
    });
    expect(read().data.attributes).toMatchObject(nativeData);
    expect(data).toHaveProperty('articletext');
    expect(data).not.toHaveProperty('introtext');
    expect(api.request).not.toHaveBeenCalled();
  });

  it.each(['api', 'cli'] as const)('keeps %s body previews non-mutating and without a confirmation token', async (transport) => {
    const { service, cli, api, read } = harness();
    const result = await service.planAction({
      action: 'content.articles.update', input: { id: 41, data: { articletext: '<p>Preview</p>' } },
      transport, dryRun: true, idempotencyKey: randomUUID(),
    });

    expect(result).toMatchObject({ dryRun: true, confirmationRequired: true, operation: { transport } });
    expect(result).not.toHaveProperty('confirmationToken');
    expect(api.request).not.toHaveBeenCalled();
    expect(read().data.attributes).toMatchObject(oldBody);
    if (transport === 'cli') {
      expect(cli.dispatch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'content.articles.update', {
        id: 41, data: { introtext: '<p>Preview</p>', fulltext: '' }, dryRun: true,
      });
    } else {
      expect(cli.dispatch).not.toHaveBeenCalled();
    }
  });
});
