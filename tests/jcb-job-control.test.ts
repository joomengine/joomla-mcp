import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';
import { applyJcbCommand, prepareJcbCommand, redispatchJcbCommand } from '../src/jcb/commands.js';
import { createServer } from '../src/mcp/create-server.js';
import type { SiteConfig } from '../src/config/schema.js';
import {
  cancelJcbJob, getJcbJob, listJcbJobs, redispatchJcbJob, submitJcbJob, withJcbSiteWriteLease,
  type JcbJobPayload,
} from '../src/jcb/jobs.js';

describe('durable JCB queue controls', () => {
  let scratch: string;
  let site: SiteConfig;
  let jobs: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'jcb-queue-'));
    jobs = join(scratch, 'jobs');
    const root = join(scratch, 'joomla');
    await Promise.all([mkdir(root), mkdir(jobs, { mode: 0o700 })]);
    site = {
      id: 'builder', toolsets: new Set(['jcb.execute']),
      cli: { root, jcbJobDirectory: jobs, phpBinary: process.execPath, timeoutMs: 3000, maxOutputBytes: 64000 },
    };
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  const native = () => vi.fn(async (_payload: JcbJobPayload, _work: string, started: () => void) => {
    started();
    return { verification: 'verified' as const, counts: { published: 1 }, artifacts: [] };
  });

  function stage(owner: string, target = site) {
    const payload = { action: 'jcb.push.power', idempotencyKey: randomUUID(),
      input: { options: { items: randomUUID() } }, preflight: { contractFingerprint: 'a'.repeat(64) } };
    const run = native();
    return withJcbSiteWriteLease(target, async () => {
      const receipt = await submitJcbJob(target, owner, payload, 'same-intent', run);
      expect(receipt.status).toBe('queued');
      expect(run).not.toHaveBeenCalled();
      return { payload, receipt, run };
    });
  }

  it('paginates only the requesting owner and site, including when the same job directory is shared', async () => {
    const first = await stage('alice');
    const second = await stage('alice');
    await stage('bob');
    await stage('alice', { ...site, id: 'other' });
    await cancelJcbJob(site, 'alice', second.receipt.jobId);
    const allIds = [first.receipt.jobId, second.receipt.jobId].sort();
    const page1 = await listJcbJobs(site, 'alice', 1);
    const page2 = await listJcbJobs(site, 'alice', 1, page1.nextCursor!);
    expect([page1.jobs[0]!.jobId, page2.jobs[0]!.jobId]).toEqual(allIds);
    expect(page2.nextCursor).toBeNull();
    expect(await listJcbJobs(site, 'nobody')).toEqual({ jobs: [], nextCursor: null });
    expect(JSON.stringify(page1)).not.toContain('fingerprint');
    await expect(listJcbJobs(site, 'alice', 101)).rejects.toThrow(/page/i);
    await expect(listJcbJobs(site, 'alice', 1, '../elsewhere')).rejects.toThrow(/page/i);
  });

  it('enforces separate discovery and mutation scopes at the MCP tool boundary', async () => {
    const identity = { issuer: 'https://issuer.example', subject: 'alice' };
    const scopes = ['joomla:site:builder', 'joomla:toolset:jcb.execute'];
    const authInfo: AuthInfo = { clientId: 'client', token: 'fixture', scopes, extra: identity };
    const owner = 'remote:https://issuer.example:alice:client';
    const { receipt } = await stage(owner);
    const server = createServer({ defaultSite: site.id, sites: new Map([[site.id, site]]) });
    const client = new Client({ name: 'queue-controls', version: '1.0' });
    const [outbound, inbound] = InMemoryTransport.createLinkedPair();
    const send = outbound.send.bind(outbound);
    outbound.send = (message, options) => send(message, { ...options, authInfo });
    await server.connect(inbound);
    await client.connect(outbound);
    const call = (name: string, args = {}) => client.callTool({ name, arguments: args });
    try {
      expect((await call('joomla_jcb_jobs_list')).structuredContent).toMatchObject({ jobs: [{ jobId: receipt.jobId }] });
      expect((await call('joomla_jcb_job_cancel', { jobId: receipt.jobId })).isError).toBe(true);
      expect((await call('joomla_jcb_job_redispatch', { jobId: receipt.jobId })).isError).toBe(true);
      scopes.push('joomla:writes:apply');
      identity.subject = 'bob';
      expect((await call('joomla_jcb_jobs_list')).structuredContent).toEqual({ jobs: [], nextCursor: null });
      expect((await call('joomla_jcb_job_redispatch', { jobId: receipt.jobId })).isError).toBe(true);
      identity.subject = 'alice';
      expect((await call('joomla_jcb_job_cancel', { jobId: receipt.jobId })).structuredContent).toMatchObject({ status: 'cancelled' });
      expect((await call('joomla_jcb_job_redispatch', { jobId: receipt.jobId })).isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  it('redispatches a proven pending job after worker restart with its exact frozen input', async () => {
    const { receipt, payload, run } = await stage('alice');
    const path = join(jobs, receipt.jobId, 'job.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, workerInstance: 'old-worker-instance' }));
    await expect(redispatchJcbJob(site, 'bob', receipt.jobId, run)).rejects.toThrow(/unknown/i);
    await expect(cancelJcbJob(site, 'bob', receipt.jobId)).rejects.toThrow(/unknown/i);
    expect((await getJcbJob(site, 'alice', receipt.jobId)).status).toBe('queued');
    const results = await Promise.allSettled([
      redispatchJcbJob(site, 'alice', receipt.jobId, run),
      redispatchJcbJob(site, 'alice', receipt.jobId, run),
    ]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    await vi.waitFor(async () => expect((await getJcbJob(site, 'alice', receipt.jobId)).status).toBe('succeeded'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(payload);
    await expect(redispatchJcbJob(site, 'alice', receipt.jobId, run)).rejects.toThrow(/never-started/i);
  });

  it('treats cancel and dispatch as mutually exclusive, even when both arrive together', async () => {
    const { receipt, run } = await stage('alice');
    await Promise.allSettled([
      cancelJcbJob(site, 'alice', receipt.jobId),
      redispatchJcbJob(site, 'alice', receipt.jobId, run),
    ]);
    await vi.waitFor(async () => expect(['cancelled', 'succeeded']).toContain((await getJcbJob(site, 'alice', receipt.jobId)).status));
    const job = await getJcbJob(site, 'alice', receipt.jobId);
    expect(run).toHaveBeenCalledTimes(job.status === 'cancelled' ? 0 : 1);
    await expect(redispatchJcbJob(site, 'alice', receipt.jobId, run)).rejects.toThrow(/never-started/i);
  });

  it('leaves cancelled and legacy queued jobs ineligible for execution', async () => {
    const { receipt, run } = await stage('alice');
    expect((await cancelJcbJob(site, 'alice', receipt.jobId)).status).toBe('cancelled');
    expect((await cancelJcbJob(site, 'alice', receipt.jobId)).status).toBe('cancelled');
    await expect(redispatchJcbJob(site, 'alice', receipt.jobId, run)).rejects.toThrow(/never-started/i);
    const old = await stage('alice');
    const path = join(jobs, old.receipt.jobId, 'job.json');
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    delete legacy.payloadDigest;
    await writeFile(path, JSON.stringify(legacy));
    await expect(redispatchJcbJob(site, 'alice', old.receipt.jobId, run)).rejects.toThrow(/never-started/i);
    await expect(cancelJcbJob(site, 'alice', old.receipt.jobId)).rejects.toThrow(/never-started/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not reconstruct site leases from legacy receipts and retains an actual stale claim until reconciliation', async () => {
    const { receipt, run } = await stage('alice');
    const path = join(jobs, receipt.jobId, 'job.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    delete record.payloadDigest;
    record.workerInstance = 'previous-server-instance';
    await writeFile(path, JSON.stringify(record));
    await unlink(join(jobs, receipt.jobId, 'pending.json'));
    expect((await getJcbJob(site, 'alice', receipt.jobId)).status).toBe('uncertain');
    await expect(redispatchJcbJob(site, 'alice', receipt.jobId, run)).rejects.toThrow(/never-started/i);
    const unrelated = vi.fn(async () => 'applied');
    await expect(withJcbSiteWriteLease(site, unrelated)).resolves.toBe('applied');
    const claim = join(jobs, 'active-' + createHash('sha256').update(site.id).digest('hex'));
    await link(path, claim);
    await expect(withJcbSiteWriteLease(site, unrelated)).rejects.toThrow(/execution claim/i);
    const next = { ...record, idempotencyKey: randomUUID(), input: {}, preflight: {} };
    const fresh = await submitJcbJob(site, 'alice', next, 'fresh', run);
    expect(fresh.status).toBe('queued');
    expect((await redispatchJcbJob(site, 'alice', fresh.jobId, run)).status).toBe('queued');
    expect(run).not.toHaveBeenCalled();
    // Simulate the documented, offline operator reconciliation of this known fixture claim.
    await unlink(claim);
    await redispatchJcbJob(site, 'alice', fresh.jobId, run);
    await vi.waitFor(async () => expect((await getJcbJob(site, 'alice', fresh.jobId)).status).toBe('succeeded'));
    expect(run).toHaveBeenCalledOnce();
    expect((await getJcbJob(site, 'alice', receipt.jobId)).status).toBe('uncertain');
  });

  it('fails at preflight when the companion actor loses its command permission before redispatch', async () => {
    let allowed = true;
    const action = 'jcb.push.power';
    const input = { options: { items: randomUUID() } };
    const dispatch = vi.fn(async (_config, _action, args) => {
      if (!args.dryRun) throw new Error('The revoked command must never be dispatched');
      return { data: { result: { applied: false, dryRun: true, requestedState: { command: 'componentbuilder:push:power', options: input.options },
        preState: { contractFingerprint: 'f'.repeat(64) } } } };
    });
    const cli = {
      describe: async () => ({ data: { actions: [{ name: action, risk: 'high', effective: { allowed }, inputSchema: { properties: {
        options: { type: 'object', properties: { items: { type: 'string' } }, additionalProperties: false },
      } } }] } }),
      dispatch,
    } as unknown as JoomlaCliTransport;
    const { preflight } = await prepareJcbCommand(cli, site, action, input);
    const job = await withJcbSiteWriteLease(site, () => applyJcbCommand(cli, site, action, input, preflight, 'alice', randomUUID()));
    expect(job.status).toBe('queued');
    allowed = false;
    await redispatchJcbCommand(cli, site, 'alice', job.jobId);
    await vi.waitFor(async () => expect(await getJcbJob(site, 'alice', job.jobId)).toMatchObject({ status: 'failed', failurePhase: 'preflight' }));
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(redispatchJcbCommand(cli, site, 'alice', job.jobId)).rejects.toThrow(/never-started/i);
    await expect(withJcbSiteWriteLease(site, async () => 'released')).resolves.toBe('released');
  });

  it('fails before native execution if a pending payload does not match its approved digest', async () => {
    const { receipt, payload, run } = await stage('alice');
    await writeFile(join(jobs, receipt.jobId, 'pending.json'), JSON.stringify({ ...payload, input: { options: { items: randomUUID() } } }));
    await redispatchJcbJob(site, 'alice', receipt.jobId, run);
    await vi.waitFor(async () => expect((await getJcbJob(site, 'alice', receipt.jobId)).status).toBe('failed'));
    expect(run).not.toHaveBeenCalled();
  });
});
