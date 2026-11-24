import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, chmod, link, mkdir, mkdtemp, open, opendir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { JoomlaCompanionError } from '../infrastructure/cli/joomla-cli-client.js';
import { validateJcbJobDirectory } from '../config/jcb-job-directory.js';
import type { SiteConfig } from '../config/schema.js';

export interface JcbArtifact {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface JcbOutcome {
  readonly verification: 'verified' | 'partial' | 'unverified';
  readonly counts: Readonly<Record<string, number | boolean>>;
  readonly artifacts: readonly JcbArtifact[];
}

type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
interface Job {
  readonly jobId: string;
  readonly site: string;
  readonly action: string;
  readonly owner: string;
  readonly fingerprint: string;
  /** Present only on jobs whose approved inputs were durably staged before dispatch. */
  readonly payloadDigest?: string;
  readonly workerHost: string;
  readonly workerPid: number;
  readonly workerInstance: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: Status;
  readonly outcome?: JcbOutcome;
  readonly message?: string;
  readonly reasonCode?: string;
  readonly failurePhase?: 'preflight' | 'dispatch' | 'archive';
}

const verifiedFiles = new Set<string>();
const workerInstance = randomUUID();
// Job files and MCP responses carry only reviewed codes. Raw native error messages
// and output can include paths, settings or credentials and must stay out of receipts.
const publicCompanionErrors = new Set([
  'ACCESS_DENIED', 'ACTION_FAILED', 'INVALID_INPUT', 'INVALID_JSON', 'INVALID_PROTOCOL',
  'INVALID_REQUEST', 'UNKNOWN_ACTION', 'PLAN_STALE', 'RESULT_INVALID', 'RESULT_TOO_LARGE',
  'REQUEST_TOO_LARGE', 'JCB_ARCHIVE_INVALID', 'JCB_ARCHIVE_MISSING', 'JCB_ARTIFACT_STORAGE',
  'JCB_GRAPH_LIMIT', 'JCB_GRAPH_UNAVAILABLE', 'JCB_PARTIAL', 'JCB_SOURCE_UNAVAILABLE',
  'JCB_VERIFY_FILE', 'JCB_VERIFY_LIMIT', 'JCB_VERIFY_SOURCE', 'JCB_VERIFY_UNAVAILABLE',
  'CLI_TIMEOUT', 'CLI_OUTPUT_LIMIT', 'CLI_EXIT_FAILED', 'CLI_INVALID_JSON', 'CLI_INVALID_PROTOCOL',
]);

function fileIdentity(stat: BigIntStats, expectedDigest: string): string {
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, expectedDigest].join(':');
}

export interface JcbJobPayload {
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly preflight: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}
type ExecuteJob = (payload: JcbJobPayload, directory: string, markStarted: () => void) => Promise<JcbOutcome>;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const publicJob = ({ owner, fingerprint, payloadDigest, workerHost, workerPid, workerInstance: instance, outcome, ...job }: Job) => ({ ...job, ...outcome });

export async function jcbJobDirectory(site: SiteConfig): Promise<string> {
  const configured = site.cli?.jcbJobDirectory;
  if (!site.cli || !configured || !site.toolsets.has('jcb.execute')) {
    throw new Error('JCB execution requires a local CLI, jcb.execute and a private absolute cli.jcbJobDirectory.');
  }
  return validateJcbJobDirectory(configured, site.cli.root);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function persist(path: string, job: Job): Promise<void> {
  const temporary = join(path, randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, join(path, 'job.json'));
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}

async function readOwnedJob(root: string, site: string, principal: string, id: string): Promise<Job | undefined> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown JCB job.');
  let value: Job;
  try {
    value = JSON.parse(await readFile(join(root, id, 'job.json'), 'utf8')) as Job;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (value.site !== site || value.owner !== digest(principal) || value.jobId !== id) return undefined;
  if (value.status === 'queued' && value.payloadDigest) {
    const directory = join(root, id);
    if (await exists(join(directory, 'pending.json'))) return value;
    if (await exists(join(directory, 'cancelled.json'))) return { ...value, status: 'cancelled' };
    // A claimed payload may have crossed into native code. Never infer that
    // its mutation can be retried from an out-of-date queued receipt.
    value = { ...value, status: 'running' };
  }
  if ((value.status === 'queued' || value.status === 'running') && value.workerHost === hostname()) {
    // A restarted container often gives its next Node process exactly the same PID.
    let interrupted = value.workerPid === process.pid && value.workerInstance !== workerInstance;
    if (!interrupted) {
      try { process.kill(value.workerPid, 0); }
      catch (error) {
        if (!hasCode(error, 'ESRCH')) throw error;
        interrupted = true;
      }
    }
    if (interrupted) return { ...value, status: 'uncertain', message: 'Worker interrupted. Inspect Joomla before attempting a new operation.' };
  }
  return value;
}

async function ownedJob(root: string, site: string, principal: string, id: string): Promise<Job> {
  const job = await readOwnedJob(root, site, principal, id);
  if (!job) throw new Error('Unknown JCB job.');
  return job;
}

export async function listJcbJobs(site: SiteConfig, principal: string, limit = 25, cursor?: string) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (cursor !== undefined && !/^[a-f0-9]{64}$/.test(cursor))) throw new Error('Invalid JCB job page.');
  const root = await jcbJobDirectory(site);
  const entries = await opendir(root);
  const page: { jobId: string; site: string; action: string; status: Status; createdAt: string; updatedAt: string }[] = [];
  for await (const entry of entries) {
    const id = entry.name;
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(id) || (cursor && id <= cursor)) continue;
    // Keep only enough sorted candidates to produce this page and its continuation.
    if (page.length > limit && id > page[limit]!.jobId) continue;
    const job = await readOwnedJob(root, site.id, principal, id);
    if (!job) continue;
    page.push({ jobId: id, site: job.site, action: job.action, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt });
    page.sort((a, b) => a.jobId < b.jobId ? -1 : 1);
    if (page.length > limit + 1) page.pop();
  }
  return { jobs: page.slice(0, limit), nextCursor: page.length > limit ? page[limit - 1]!.jobId : null };
}

export async function getJcbJob(site: SiteConfig, principal: string, jobId: string) {
  return publicJob(await ownedJob(await jcbJobDirectory(site), site.id, principal, jobId));
}

// Publish a complete, nonempty directory with one rename. A competing submitter
// either claims the operation or reads the original receipt, including after restart.
export async function submitJcbJob(
  site: SiteConfig, principal: string, payload: JcbJobPayload, fingerprint: string, execute: ExecuteJob,
) {
  const root = await jcbJobDirectory(site);
  const { action, idempotencyKey } = payload;
  const encoded = JSON.stringify(payload);
  const jobId = digest(JSON.stringify([site.id, principal, idempotencyKey]));
  const directory = join(root, jobId);
  const temporary = await mkdtemp(join(root, '.new-'));
  const timestamp = new Date().toISOString();
  const job: Job = {
    jobId, site: site.id, action, owner: digest(principal), fingerprint, payloadDigest: digest(encoded), workerHost: hostname(), workerPid: process.pid, workerInstance,
    status: 'queued', createdAt: timestamp, updatedAt: timestamp,
  };
  try {
    await mkdir(join(temporary, 'work'), { mode: 0o700 });
    await mkdir(join(temporary, 'artifacts'), { mode: 0o700 });
    await writeFile(join(temporary, 'pending.json'), encoded, { flag: 'wx', flush: true, mode: 0o600 });
    await persist(temporary, job);
    try {
      await rename(temporary, directory);
    } catch (error) {
      if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error;
      const original = await ownedJob(root, site.id, principal, jobId);
      if (original.fingerprint !== fingerprint) throw new Error('JCB idempotency key already claimed for another operation.');
      return publicJob(original);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return dispatchPending(root, principal, job, execute);
}

/** Only a published, never-claimed payload can win this rename. */
export async function cancelJcbJob(site: SiteConfig, principal: string, jobId: string) {
  const root = await jcbJobDirectory(site);
  const job = await ownedJob(root, site.id, principal, jobId);
  if (job.status === 'cancelled') return publicJob(job);
  if (!job.payloadDigest || job.status !== 'queued') throw new Error('Only a never-started queued JCB job can be cancelled.');
  const directory = join(root, jobId);
  try { await rename(join(directory, 'pending.json'), join(directory, 'cancelled.json')); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) throw new Error('The JCB job was already cancelled or claimed for dispatch.');
    throw error;
  }
  const cancelled: Job = { ...job, status: 'cancelled', updatedAt: new Date().toISOString() };
  await persist(directory, cancelled);
  return publicJob(cancelled);
}

export async function redispatchJcbJob(site: SiteConfig, principal: string, jobId: string, execute: ExecuteJob) {
  const root = await jcbJobDirectory(site);
  const job = await ownedJob(root, site.id, principal, jobId);
  if (!job.payloadDigest || job.status !== 'queued') throw new Error('Only a never-started queued JCB job can be redispatched.');
  return dispatchPending(root, principal, job, execute);
}

async function dispatchPending(root: string, principal: string, job: Job, execute: ExecuteJob) {
  const directory = join(root, job.jobId);
  const lease = siteLease(root, job.site);
  try {
    // The linked receipt identifies its holder even after a process restart.
    await link(join(directory, 'job.json'), lease);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    // Keep the original approved payload pending while another job owns
    // this site. The owner can cancel or redispatch it under the same claim.
    return publicJob(await ownedJob(root, job.site, principal, job.jobId));
  }
  try { await rename(join(directory, 'pending.json'), join(directory, 'claimed.json')); }
  catch (error) {
    await unlink(lease);
    if (hasCode(error, 'ENOENT')) return publicJob(await ownedJob(root, job.site, principal, job.jobId));
    throw error;
  }
  const worker: Job = { ...job, workerHost: hostname(), workerPid: process.pid, workerInstance };
  void runJob(lease, directory, worker, execute).catch(() => {
    // A storage failure can leave a durable running receipt. Never release an
    // execution claim if we cannot record whether it changed the Joomla site.
    process.stderr.write('JCB job state could not be persisted; operator reconciliation required.\n');
  });
  return publicJob(job);
}

function siteLease(root: string, site: string): string {
  return join(root, 'active-' + digest(site));
}

/** Serialize existing writes with long-running JCB commands on participating sites. */
export async function withJcbSiteWriteLease<T>(site: SiteConfig, operation: () => Promise<T>): Promise<T> {
  if (!site.cli?.jcbJobDirectory || !site.toolsets.has('jcb.execute')) return operation();
  const lease = siteLease(await jcbJobDirectory(site), site.id);
  const owner = { site: site.id, kind: 'write', workerHost: hostname(), workerPid: process.pid, createdAt: new Date().toISOString() };
  try {
    await writeFile(lease, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new Error('Another write or unresolved JCB job holds the site execution claim.');
    throw error;
  }
  try { return await operation(); }
  finally { await unlink(lease); }
}

async function runJob(lease: string, directory: string, job: Job, execute: ExecuteJob): Promise<void> {
  const work = join(directory, 'work');
  let phase: 'preflight' | 'dispatch' | 'archive' = 'preflight';
  let terminal: Job;
  try {
    await persist(directory, { ...job, status: 'running', updatedAt: new Date().toISOString() });
    const encoded = await readFile(join(directory, 'claimed.json'), 'utf8');
    if (digest(encoded) !== job.payloadDigest) throw new Error('The approved JCB job payload changed.');
    const payload: JcbJobPayload = JSON.parse(encoded);
    if (payload.action !== job.action) throw new Error('The stored JCB action does not match its receipt.');
    const outcome = await execute(payload, work, () => { phase = 'dispatch'; });
    phase = 'archive';
    for (const artifact of outcome.artifacts) await retainArtifact(directory, artifact);
    terminal = { ...job, updatedAt: new Date().toISOString(), status: outcome.verification === 'verified' ? 'succeeded' : 'uncertain', outcome };
  } catch (error) {
    const fallback = { preflight: 'JCB_PREFLIGHT_FAILED', dispatch: 'JCB_DISPATCH_FAILED', archive: 'JCB_ARCHIVE_RETENTION_FAILED' };
    const reasonCode = error instanceof JoomlaCompanionError && publicCompanionErrors.has(error.code)
      ? error.code : fallback[phase];
    terminal = {
      ...job, updatedAt: new Date().toISOString(), status: phase === 'preflight' ? 'failed' : 'uncertain',
      failurePhase: phase, reasonCode,
      message: phase === 'preflight' ? 'JCB preflight failed before native execution.' : 'Native completion could not be verified. Reconcile the site before retrying.',
    };
  }
  await persist(directory, terminal);
  if (terminal.status !== 'uncertain') {
    await rm(work, { recursive: true, force: true });
    await unlink(lease);
  }
}

export function safeArtifactName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.zip$/i.test(name);
}

async function retainArtifact(directory: string, artifact: JcbArtifact): Promise<void> {
  if (!safeArtifactName(artifact.name)) throw new Error('Invalid JCB archive name.');
  const source = await open(join(directory, 'work', artifact.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const destination = join(directory, 'artifacts', artifact.name);
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.size) throw new Error('The JCB archive does not match its receipt.');
    const copy = await open(destination, 'wx', 0o400);
    const hash = createHash('sha256');
    try {
      // Bytes are copied from the opened regular file, never from a reopened native path.
      let written = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        written += chunk.length;
        if (written > artifact.size) throw new Error('JCB archive changed during collection.');
        hash.update(chunk);
        await copy.writeFile(chunk);
      }
      if (written !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('JCB archive digest mismatch.');
      await copy.sync();
    } finally { await copy.close(); }
  } finally { await source.close(); }
  await chmod(destination, 0o400);
}

export async function readJcbArtifact(
  site: SiteConfig, principal: string, jobId: string, name: string, offset = 0, limit = 65_536,
) {
  const root = await jcbJobDirectory(site);
  const job = await ownedJob(root, site.id, principal, jobId);
  const artifact = job.outcome?.artifacts.find((item) => item.name === name);
  if (job.status !== 'succeeded' || !safeArtifactName(name) || !artifact) throw new Error('Unknown verified JCB artifact.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size || !Number.isSafeInteger(limit) || limit < 1 || limit > 262_144) {
    throw new Error('Invalid JCB artifact byte range (maximum 262144 bytes).');
  }
  const file = await open(join(root, jobId, 'artifacts', name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(artifact.size) || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o400n) {
      throw new Error('Invalid retained JCB artifact.');
    }
    const identity = fileIdentity(stat, artifact.sha256);
    if (!verifiedFiles.has(identity)) {
      // Hash once per unchanged private file, even when a client downloads it in many chunks.
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
      if (hash.digest('hex') !== artifact.sha256) throw new Error('Retained JCB artifact digest mismatch.');
      if (verifiedFiles.size >= 1024) verifiedFiles.clear();
      verifiedFiles.add(identity);
    }
    const count = Math.min(limit, artifact.size - offset);
    const bytes = Buffer.alloc(count);
    let copied = 0;
    while (copied < count) {
      const { bytesRead } = await file.read(bytes, copied, count - copied, offset + copied);
      if (bytesRead === 0) throw new Error('Truncated JCB artifact.');
      copied += bytesRead;
    }
    if (fileIdentity(await file.stat({ bigint: true }), artifact.sha256) !== identity) {
      throw new Error('Retained JCB artifact changed during reading.');
    }
    return { ...artifact, jobId, offset, bytes: count, eof: offset + count === artifact.size, encoding: 'base64', data: bytes.toString('base64') };
  } finally { await file.close(); }
}
