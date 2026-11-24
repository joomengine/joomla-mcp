import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
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

type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
interface Job {
  readonly jobId: string;
  readonly site: string;
  readonly action: string;
  readonly owner: string;
  readonly fingerprint: string;
  readonly workerHost: string;
  readonly workerPid: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: Status;
  readonly outcome?: JcbOutcome;
  readonly message?: string;
}

type ExecuteJob = (directory: string, markStarted: () => void) => Promise<JcbOutcome>;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const publicJob = ({ owner, fingerprint, workerHost, workerPid, outcome, ...job }: Job) => ({ ...job, ...outcome });

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

async function ownedJob(root: string, site: string, principal: string, id: string): Promise<Job> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unknown JCB job.');
  let value: Job;
  try {
    value = JSON.parse(await readFile(join(root, id, 'job.json'), 'utf8')) as Job;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) throw new Error('Unknown JCB job.');
    throw error;
  }
  if (value.site !== site || value.owner !== digest(principal) || value.jobId !== id) throw new Error('Unknown JCB job.');
  if ((value.status === 'queued' || value.status === 'running') && value.workerHost === hostname()) {
    try { process.kill(value.workerPid, 0); }
    catch (error) {
      if (hasCode(error, 'ESRCH')) return { ...value, status: 'uncertain', message: 'Worker interrupted. Inspect Joomla before attempting a new operation.' };
      throw error;
    }
  }
  return value;
}

export async function getJcbJob(site: SiteConfig, principal: string, jobId: string) {
  return publicJob(await ownedJob(await jcbJobDirectory(site), site.id, principal, jobId));
}

// Publish a complete, nonempty directory with one rename. A competing submitter
// either claims the operation or reads the original receipt, including after restart.
export async function submitJcbJob(
  site: SiteConfig, principal: string, idempotencyKey: string, action: string, fingerprint: string, execute: ExecuteJob,
) {
  const root = await jcbJobDirectory(site);
  const jobId = digest(JSON.stringify([site.id, principal, idempotencyKey]));
  const directory = join(root, jobId);
  const temporary = await mkdtemp(join(root, '.new-'));
  const timestamp = new Date().toISOString();
  const job: Job = {
    jobId, site: site.id, action, owner: digest(principal), fingerprint, workerHost: hostname(), workerPid: process.pid,
    status: 'queued', createdAt: timestamp, updatedAt: timestamp,
  };
  try {
    await mkdir(join(temporary, 'work'), { mode: 0o700 });
    await mkdir(join(temporary, 'artifacts'), { mode: 0o700 });
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
  void runJob(root, directory, job, execute).catch(() => {
    // A storage failure can leave a durable running receipt. Never release an
    // execution claim if we cannot record whether it changed the Joomla site.
    process.stderr.write('JCB job state could not be persisted; operator reconciliation required.\n');
  });
  return publicJob(job);
}

async function runJob(root: string, directory: string, job: Job, execute: ExecuteJob): Promise<void> {
  const lease = join(root, 'active-' + digest(job.site));
  try {
    // Hard-linking the receipt atomically identifies the holder even after a crash.
    await link(join(directory, 'job.json'), lease);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    await persist(directory, { ...job, status: 'failed', updatedAt: new Date().toISOString(), message: 'Another JCB job holds the site execution claim.' });
    return;
  }
  const work = join(directory, 'work');
  let started = false;
  let terminal: Job;
  try {
    await persist(directory, { ...job, status: 'running', updatedAt: new Date().toISOString() });
    const outcome = await execute(work, () => { started = true; });
    for (const artifact of outcome.artifacts) await retainArtifact(directory, artifact);
    terminal = { ...job, updatedAt: new Date().toISOString(), status: outcome.verification === 'verified' ? 'succeeded' : 'uncertain', outcome };
  } catch {
    terminal = {
      ...job, updatedAt: new Date().toISOString(), status: started ? 'uncertain' : 'failed',
      message: started ? 'Native completion could not be verified. Reconcile the site before retrying.' : 'The command or its preconditions changed before native execution.',
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
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== artifact.size || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o400) throw new Error('Invalid retained JCB artifact.');
    const count = Math.min(limit, artifact.size - offset);
    const bytes = Buffer.alloc(count);
    let copied = 0;
    while (copied < count) {
      const { bytesRead } = await file.read(bytes, copied, count - copied, offset + copied);
      if (bytesRead === 0) throw new Error('Truncated JCB artifact.');
      copied += bytesRead;
    }
    return { ...artifact, jobId, offset, bytes: count, eof: offset + count === artifact.size, encoding: 'base64', data: bytes.toString('base64') };
  } finally { await file.close(); }
}
