import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '../src/config/schema.js';
import type { JoomlaCliTransport } from '../src/infrastructure/cli/joomla-cli-client.js';
import { applyJcbCommand, listJcbCommands, prepareJcbCommand } from '../src/jcb/commands.js';
import { getJcbJob, readJcbArtifact } from '../src/jcb/jobs.js';

const action = 'jcb.compile.component';
const principal = 'operator-a';
const input = { options: { component: 'a9985a93-4ff9-4d07-bd18-08035d24b36d' } };
const description = {
  protocol: 'joomla-mcp/1',
  actions: [{ name: action, description: 'Compile a JCB component', risk: 'high', effective: { allowed: true },
    inputSchema: { type: 'object', properties: {
      options: { type: 'object', additionalProperties: false, properties: { component: { type: 'string' } } },
      dryRun: { type: 'boolean' }, _edgeConfirmed: { type: 'boolean' },
    } },
  }],
};
const bytes = Buffer.from('compiled component bytes');
const archive = { name: 'com_demo.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

describe('installed local JCB command jobs', () => {
  let scratch: string;
  let jobs: string;
  let site: SiteConfig;
  let cli: JoomlaCliTransport;
  let fingerprint: string;
  let native: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'jcb-job-test-'));
    const root = join(scratch, 'joomla');
    jobs = join(scratch, 'jobs');
    await Promise.all([mkdir(root), mkdir(jobs, { mode: 0o700 })]);
    site = { id: 'local', toolsets: new Set(['jcb.execute']), cli: { root, jcbJobDirectory: jobs, phpBinary: process.execPath, timeoutMs: 5000, maxOutputBytes: 32768 } };
    fingerprint = 'a'.repeat(64);
    native = vi.fn(async (directory: string) => {
      await writeFile(join(directory, archive.name), bytes);
      return { applied: true, dryRun: false, verification: { status: 'verified', archives: 1 }, artifacts: [archive] };
    });
    cli = {
      describe: async () => ({ data: description }),
      dispatch: async (_config, command, args, options) => {
        expect(command).toBe(action);
        if (args.dryRun) {
          expect(args._edgeConfirmed).toBeUndefined();
          return { data: { result: { applied: false, dryRun: true, preState: { contractFingerprint: fingerprint } } } };
        }
        expect(args._edgeConfirmed).toBe(true);
        expect(args._expectedContractFingerprint).toBe(fingerprint);
        return { data: { result: await native(options?.jcbArtifactDirectory) } };
      },
    } as JoomlaCliTransport;
  });
  afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

  async function wait(id: string) {
    for (let i = 0; i < 200; i++) {
      const record = await getJcbJob(site, principal, id);
      if (!['queued', 'running'].includes(record.status)) return record;
      await sleep(5);
    }
    throw new Error('Timed out waiting for JCB job');
  }

  it('only exposes reviewed, executable identities and excludes internal controls', async () => {
    const entry = description.actions[0]!;
    const actions = [
      entry, { ...entry, name: 'jcb.compile.plugin' }, { ...entry, name: 'jcb.init.demo', effective: { allowed: false } },
      { ...entry, name: 'jcb.push.power' }, { ...entry, name: 'core.run' },
    ];
    const descriptors = listJcbCommands({ actions });
    expect(descriptors.map(item => item.id)).toEqual([action, 'jcb.push.power']);
    expect(Object.keys(descriptors[0]!.inputSchema.properties)).toEqual(['options']);
    await expect(prepareJcbCommand(cli, site, action, { ...input, _edgeConfirmed: true })).rejects.toThrow(/only/);
    await expect(prepareJcbCommand(cli, site, action, { options: { 'components-file': '/tmp/request' } })).rejects.toThrow(/unreviewed/);
    expect(native).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent claims, retains digest-verified archives and restricts access to their principal', async () => {
    const { preflight } = await prepareJcbCommand(cli, site, action, input);
    const key = randomUUID();
    const submit = () => applyJcbCommand(cli, site, action, input, preflight, principal, key);
    const [one, two] = await Promise.all([submit(), submit()]);
    expect(two.jobId).toBe(one.jobId);
    expect(await wait(one.jobId)).toMatchObject({ status: 'succeeded', verification: 'verified', artifacts: [archive] });
    expect(native).toHaveBeenCalledTimes(1);
    await expect(getJcbJob(site, 'another-principal', one.jobId)).rejects.toThrow('Unknown');
    await expect(readJcbArtifact(site, 'another-principal', one.jobId, archive.name)).rejects.toThrow('Unknown');
    await expect(readJcbArtifact(site, principal, one.jobId, '../com_demo.zip')).rejects.toThrow('Unknown');
    expect(await readJcbArtifact(site, principal, one.jobId, archive.name, 1, 4)).toMatchObject({
      data: bytes.subarray(1, 5).toString('base64'), bytes: 4, offset: 1, eof: false, sha256: archive.sha256,
    });
    expect((await submit()).status).toBe('succeeded');
    await expect(applyJcbCommand(cli, site, action, { options: { component: randomUUID() } }, preflight, principal, key)).rejects.toThrow(/already claimed/);
  });

  it('rejects native contract drift before mutation and never replays an uncertain mutation', async () => {
    const { preflight } = await prepareJcbCommand(cli, site, action, input);
    fingerprint = 'b'.repeat(64);
    const drift = await applyJcbCommand(cli, site, action, input, preflight, principal, randomUUID());
    expect((await wait(drift.jobId)).status).toBe('failed');
    expect(native).not.toHaveBeenCalled();
    fingerprint = 'a'.repeat(64);
    native.mockRejectedValue(new Error('the native connection stopped after dispatch'));
    const key = randomUUID();
    const first = await applyJcbCommand(cli, site, action, input, preflight, principal, key);
    expect((await wait(first.jobId)).status).toBe('uncertain');
    const replay = await applyJcbCommand(cli, site, action, input, preflight, principal, key);
    expect(replay.status).toBe('uncertain');
    expect(native).toHaveBeenCalledTimes(1);
    expect((await readdir(jobs)).some(name => name.startsWith('active-'))).toBe(true);
  });

  it('rejects an archive symlink and requires the private state directory', async () => {
    const { preflight } = await prepareJcbCommand(cli, site, action, input);
    native.mockImplementation(async (work: string) => {
      const target = join(scratch, 'outside.zip');
      await writeFile(target, bytes);
      await symlink(target, join(work, archive.name));
      return { applied: true, dryRun: false, verification: { status: 'verified' }, artifacts: [archive] };
    });
    const receipt = await applyJcbCommand(cli, site, action, input, preflight, principal, randomUUID());
    expect((await wait(receipt.jobId)).status).toBe('uncertain');
    await expect(readJcbArtifact(site, principal, receipt.jobId, archive.name)).rejects.toThrow('Unknown');
    await chmod(jobs, 0o755);
    await expect(prepareJcbCommand(cli, site, action, input)).rejects.toThrow(/0700/);
  });
});
