import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { Configuration, Toolset } from '../src/config/schema.js';
import type {
  JoomlaApiRequest, JoomlaApiResponse, JoomlaApiTransport,
} from '../src/infrastructure/api/joomla-api-client.js';
import { JoomlaApiError } from '../src/infrastructure/api/joomla-api-error.js';
import type { JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';
import { getJcbJob } from '../src/jcb/jobs.js';
import type { ConfirmationPlan } from '../src/security/confirmation-service.js';

const key = '409aadf1-c1f7-4f43-bc47-824fa196ba05';
const principal = 'test-operator';
const base = 'v1/componentbuilder/languages';
const create = {
  action: 'jcb.api.languages.create', input: { data: { name: 'Test language', langtag: 'en-NZ' } },
  idempotencyKey: key,
};

function fixture(toolsets: readonly Toolset[] = ['jcb.write', 'jcb.read']) {
  const configuration: Configuration = {
    defaultSite: 'test',
    approval: { secret: 'separate-operator-secret-for-tests-only', ttlMs: 60_000 },
    sites: new Map([['test', {
      id: 'test', toolsets: new Set(toolsets),
      api: { baseUrl: 'https://site.example', tokenEnv: 'TOKEN', token: 'fixture-token', timeoutMs: 2000, maxPageSize: 10, maxResponseBytes: 1_000_000 },
    }]]),
  };
  const records = new Map<number, Record<string, unknown>>();
  let next = 0;
  const calls: JoomlaApiRequest[] = [];
  function resource(id: number, attributes: Record<string, unknown>) {
    return { id: String(id), type: 'languages', attributes: { ...attributes, id } };
  }
  async function dispatch(request: JoomlaApiRequest): Promise<JoomlaApiResponse> {
    calls.push(request);
    if (request.method === 'GET' && request.path === base) {
      return { status: 200, data: { data: [...records].map(([id, attrs]) => resource(id, attrs)) }, headers: {} };
    }
    if (request.method === 'POST' && request.path === base) {
      const id = ++next;
      records.set(id, { ...request.body });
      return { status: 201, data: { data: resource(id, records.get(id)!) }, headers: {} };
    }
    const id = Number(request.path.slice(base.length + 1));
    const attrs = records.get(id);
    if (!request.path.startsWith(`${base}/`) || !attrs) throw new JoomlaApiError(404, { errors: [{ title: 'Missing language' }] });
    if (request.method === 'DELETE') {
      records.delete(id);
      return { status: 204, headers: {}, data: null };
    }
    if (request.method === 'PATCH') records.set(id, { ...attrs, ...request.body });
    return { status: 200, data: { data: resource(id, records.get(id)!) }, headers: {} };
  }
  const api: JoomlaApiTransport = {
    get: vi.fn((_config, path, query) => dispatch({ method: 'GET', path, ...(query ? { query } : {}) })),
    request: vi.fn((_config, input) => dispatch(input)),
  };
  const audit = { write: vi.fn() };
  const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api, audit);
  return { service, records, calls, api, audit };
}

async function approve(service: JoomlaWriteService, operator = principal) {
  const request = await service.requestPermission({ duration: 'once', toolsets: ['jcb.write'], reason: 'Verify a JCB fixture language write.' }, operator);
  return service.approvePermission(request.requestId, request.acknowledgement, operator);
}

describe('JCB writes through JoomlaWriteService', () => {
  it('authorizes site, transport, operator and verification scopes before changing records', async () => {
    const { service, calls, records } = fixture();
    await expect(service.planAction({ ...create, transport: 'cli', dryRun: true }, principal)).rejects.toThrow(/requires the API/i);
    await expect(service.planAction(create, principal)).rejects.toThrow(/grant/i);
    expect(calls).toHaveLength(0);
    const preview = await service.planAction({ ...create, dryRun: true }, principal);
    expect(preview).toMatchObject({ dryRun: true, operation: { action: create.action, transport: 'api' } });
    expect(preview).not.toHaveProperty('confirmationToken');
    expect(JSON.stringify(preview)).not.toContain('Test language');
    expect(records.size).toBe(0);
    await approve(service);
    const plan = await service.planAction(create, principal) as ConfirmationPlan;
    await expect(service.apply(plan.confirmationToken, 'someone-else')).rejects.toThrow();
    const deny = (_site: string, toolset: string) => { if (toolset === 'jcb.read') throw new Error('missing read scope'); };
    await expect(service.apply(plan.confirmationToken, principal, deny)).rejects.toThrow('missing read scope');
    expect(records.size).toBe(0);
    const result = await service.apply(plan.confirmationToken, principal);
    expect(result).toMatchObject({ verification: { status: 'verified' }, idempotentReplay: false });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(records.get(1)).toMatchObject(create.input.data);
  });

  it('returns the original receipt under a renewed grant and rejects different intent for the same key', async () => {
    const { service, calls } = fixture();
    await approve(service);
    const first = await service.planAction(create, principal) as ConfirmationPlan;
    const receipt = await service.apply(first.confirmationToken, principal);
    const original = structuredClone(receipt);
    // An embedded client may retain and mutate its receipt after apply.
    (receipt['verification'] as Record<string, unknown>)['status'] = 'client-side change';
    const count = calls.length;
    await approve(service);
    const repeat = await service.planAction(create, principal) as ConfirmationPlan;
    const replay = await service.apply(repeat.confirmationToken, principal);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    (replay['verification'] as Record<string, unknown>)['status'] = 'mutated replay';
    await approve(service);
    const again = await service.planAction(create, principal) as ConfirmationPlan;
    expect(await service.apply(again.confirmationToken, principal)).toEqual({ ...original, idempotentReplay: true });
    expect(calls).toHaveLength(count);
    await expect(service.planAction({ ...create, input: { data: { name: 'Different language' } }, dryRun: true }, principal))
      .rejects.toThrow(/different operation/i);
  });

  it('can replay a verified delete after the original Joomla record has disappeared', async () => {
    const { service, calls, records } = fixture();
    records.set(7, { name: 'Remove this fixture language', langtag: 'en-NZ' });
    const deletion = { action: 'jcb.api.languages.delete', input: { id: 7 }, idempotencyKey: key };
    await approve(service);
    const plan = await service.planAction(deletion, principal) as ConfirmationPlan;
    expect(await service.apply(plan.confirmationToken, principal)).toMatchObject({ verification: { status: 'verified', id: '7' } });
    expect(records.size).toBe(0);
    const callCount = calls.length;
    await approve(service);
    const repeat = await service.planAction(deletion, principal) as ConfirmationPlan;
    expect(await service.apply(repeat.confirmationToken, principal)).toMatchObject({ idempotentReplay: true });
    expect(calls).toHaveLength(callCount);
  });

  it('declines the approved update if the JCB record changed after the operator planned it', async () => {
    const { service, calls, records } = fixture();
    records.set(3, { name: 'Original' });
    await approve(service);
    const plan = await service.planAction({
      action: 'jcb.api.languages.update', input: { id: 3, data: { name: 'New name' } }, idempotencyKey: key,
    }, principal) as ConfirmationPlan;
    records.set(3, { name: 'Saved in Joomla after planning' });
    await expect(service.apply(plan.confirmationToken, principal)).rejects.toThrow(/changed/i);
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });

  it('serializes two independently approved plans and never dispatches the same JCB create twice', async () => {
    const { service, api, records, calls } = fixture();
    const grant = await service.requestPermission({
      duration: '30-minutes', toolsets: ['jcb.write'], reason: 'Verify concurrent JCB writes on the same site.',
    }, principal);
    await service.approvePermission(grant.requestId, grant.acknowledgement, principal);
    const [first, second] = await Promise.all([
      service.planAction(create, principal), service.planAction(create, principal),
    ]) as ConfirmationPlan[];
    const dispatched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = api.request;
    api.request = async (config, request) => {
      if (request.method === 'POST') {
        dispatched.resolve();
        await release.promise;
      }
      return original(config, request);
    };
    const running = service.apply(first!.confirmationToken, principal);
    try {
      await dispatched.promise;
      await expect(service.apply(second!.confirmationToken, principal)).rejects.toThrow(/write is already in progress/i);
    } finally {
      release.resolve();
    }
    expect(await running).toMatchObject({ verification: { status: 'verified' } });
    const repeat = await service.planAction(create, principal) as ConfirmationPlan;
    expect(await service.apply(repeat.confirmationToken, principal)).toMatchObject({ idempotentReplay: true });
    expect(records.size).toBe(1);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('caches uncertainty if the native mutation committed before its response was lost', async () => {
    const { service, api, records, calls, audit } = fixture();
    const request = api.request;
    api.request = async (config, input) => {
      const response = await request(config, input);
      if (input.method === 'POST') throw new Error('Connection closed while receiving the response');
      return response;
    };
    await approve(service);
    const plan = await service.planAction(create, principal) as ConfirmationPlan;
    const receipt = await service.apply(plan.confirmationToken, principal);
    expect(receipt).toMatchObject({ verification: { status: 'uncertain' } });
    expect(records.size).toBe(1);
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ event: 'write.failed', action: create.action }));
    await approve(service);
    const repeat = await service.planAction(create, principal) as ConfirmationPlan;
    expect(await service.apply(repeat.confirmationToken, principal)).toEqual({ ...receipt, idempotentReplay: true });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('requires opt-in and read-back rights even for previews', async () => {
    for (const scopes of [[], ['jcb.write']] as const) {
      const { service, calls } = fixture(scopes);
      await expect(service.planAction({ ...create, dryRun: true })).rejects.toThrow(/disabled/i);
      expect(calls).toHaveLength(0);
    }
  });
});

it('submits an installed package command only through a matching jcb.execute grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jcb-guarded-'));
  const { promise: mayFinish, resolve: finish } = Promise.withResolvers<void>();
  try {
    const site = {
      id: 'local',
      api: { baseUrl: 'https://local.example', tokenEnv: 'TOKEN', token: 'fixture', timeoutMs: 2000, maxPageSize: 10, maxResponseBytes: 100000 },
      cli: { root: join(root, 'joomla'), jcbJobDirectory: join(root, 'jobs'), phpBinary: '/usr/bin/php', timeoutMs: 3000, maxOutputBytes: 100000 },
      toolsets: new Set<Toolset>(['jcb.execute', 'content.write']),
    };
    await mkdir(site.cli.root);
    await mkdir(site.cli.jcbJobDirectory, { mode: 0o700 });
    const configuration: Configuration = {
      defaultSite: site.id, sites: new Map([[site.id, site]]),
      approval: { secret: 'standalone-requested-command-test-secret', ttlMs: 60_000 },
    };
    const input = { action: 'jcb.get.admin_view', input: { options: {} }, idempotencyKey: key };
    const entry = {
      name: input.action, risk: 'high', effective: { allowed: true },
      inputSchema: { properties: { options: { type: 'object', properties: {}, additionalProperties: false } } },
    };
    const native = vi.fn(async (_config, _action, args) => {
      if (args.dryRun) {
        return { data: { result: { applied: false, dryRun: true, preState: { contractFingerprint: 'a'.repeat(64) },
          requestedState: { command: 'componentbuilder:get:admin_view', options: {} } } } };
      }
      await mayFinish;
      return { data: { result: { applied: true, dryRun: false, verification: { status: 'verified' } } } };
    });
    const cli = { describe: async () => ({ data: { actions: [entry] } }), dispatch: native } as unknown as JoomlaCliTransport;
    const { api } = fixture();
    const service = new JoomlaWriteService(configuration, new SiteRegistry(configuration), api, undefined, cli);
    await expect(service.planAction(input, principal)).rejects.toThrow(/grant/i);
    expect(native).not.toHaveBeenCalled();
    await expect(service.planAction({ ...input, transport: 'api', dryRun: true }, principal)).rejects.toThrow(/requires the CLI/i);
    const preview = await service.planAction({ ...input, dryRun: true }, principal);
    expect(preview).toMatchObject({ dryRun: true, operation: { transport: 'cli' } });
    expect(native.mock.calls.every(([, , args]) => args.dryRun === true)).toBe(true);
    const grant = await service.requestPermission({ duration: 'once', reason: 'Inspect installed JCB package definitions.', toolsets: ['jcb.execute'] }, principal);
    await service.approvePermission(grant.requestId, grant.acknowledgement, principal);
    const plan = await service.planAction(input, principal) as ConfirmationPlan;
    const result = await service.apply(plan.confirmationToken, principal);
    const job = result['job'] as { jobId: string; status: string };
    expect(job.status).toBe('queued');
    // The per-site job claim must also exclude ordinary core writes while the worker runs.
    const articleGrant = await service.requestPermission({ duration: 'once', reason: 'Check the shared site lock.', toolsets: ['content.write'] }, principal);
    await service.approvePermission(articleGrant.requestId, articleGrant.acknowledgement, principal);
    const articlePlan = await service.planArticle({
      operation: 'create', data: { title: 'Overlapping write', catid: 2 }, idempotencyKey: '8d76b912-2bc6-4002-ab50-65b4df437a65',
    }, principal);
    await expect(service.apply(articlePlan.confirmationToken, principal)).rejects.toThrow(/JCB|claim|lease|write in progress/i);
    expect(api.request).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(async () => {
      expect((await getJcbJob(site, principal, job.jobId)).status).toBe('succeeded');
    });
    const repeatGrant = await service.requestPermission({ duration: 'once', reason: 'Retrieve the completed package job.', toolsets: ['jcb.execute'] }, principal);
    await service.approvePermission(repeatGrant.requestId, repeatGrant.acknowledgement, principal);
    const repeat = await service.planAction(input, principal) as ConfirmationPlan;
    expect(await service.apply(repeat.confirmationToken, principal)).toMatchObject({
      idempotentReplay: true, job: { jobId: job.jobId, status: 'succeeded' },
    });
    expect(native.mock.calls.filter(([, , args]) => args.dryRun === false && args._edgeConfirmed === true)).toHaveLength(1);
    await expect(getJcbJob(site, 'other-user', job.jobId)).rejects.toThrow(/unknown/i);
  } finally {
    finish();
    await rm(root, { recursive: true, force: true });
  }
});
