import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { runJcbWriteFixture } from './jcb-write-fixture.mjs';
import { loadConfiguration } from '../../dist/config/load.js';
import { createHttpLiveSession, createStdioLiveSession } from '../../dist/live-test/transports.js';

assert.deepEqual(process.argv.slice(2), ['--disposable']);
const site = 'jcbApi';
const localSite = 'jcbLocal';
const deniedSite = 'jcbDenied';
const configFile = resolve('jcb-sites.json');
const evidence = { jcbPackageVersion: '6.2.1', checks: [], failedSuites: [], status: 'FAIL' };
const failures = [];
const demo = '1c20aec5-bf1a-44e7-9deb-d1c920ca591d';

try {
  const packageVersion = execFileSync(
    'php',
    [
      '-r',
      'echo simplexml_load_file("/var/www/html/administrator/manifests/packages/pkg_component_builder.xml")->version;',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(packageVersion, evidence.jcbPackageVersion);
  const phpBinary = execFileSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' });
  process.env.JCB_FIXTURE_DENIED_TOKEN = execFileSync(
    phpBinary,
    ['tests/fixtures/joomengine/jcb-denied-token.php'],
    { encoding: 'utf8' },
  );
  const jobs = resolve('jobs');
  await mkdir(jobs, { mode: 0o700 });
  const api = {
    baseUrl: 'http://127.0.0.1',
    tokenEnv: 'JOOMLA_MCP_LIVE_API_TOKEN',
    allowInsecureLoopback: true,
  };
  await writeFile(
    configFile,
    JSON.stringify({
      defaultSite: site,
      approval: { secretEnv: 'JOOMLA_MCP_LIVE_APPROVAL_SECRET' },
      sites: {
        [site]: { api, toolsets: ['discovery', 'jcb.read', 'jcb.write'] },
        [deniedSite]: {
          api: { ...api, tokenEnv: 'JCB_FIXTURE_DENIED_TOKEN' },
          toolsets: ['discovery', 'jcb.read'],
        },
        [localSite]: {
          cli: {
            root: '/var/www/html',
            phpBinary,
            jcbJobDirectory: jobs,
            timeoutMs: 300000,
            maxOutputBytes: 2097152,
          },
          toolsets: ['discovery', 'cli.discovery', 'jcb.execute'],
        },
      },
    }),
    { mode: 0o600 },
  );
  const configuration = await loadConfiguration(configFile);
  for (const transport of ['stdio', 'http']) {
    const session =
      transport === 'stdio'
        ? await createStdioLiveSession({ configurationFile: configFile })
        : await createHttpLiveSession(configuration);
    try {
      await suite(session, 'API lifecycle', () => checkApi(session));
      if (transport === 'stdio') {
        await suite(session, 'installed API routes', () => checkInstalledRoutes(session, phpBinary));
        await suite(session, 'definition writes', async () => {
          evidence.definitionWrites = await runJcbWriteFixture(session, site);
          assert.deepEqual(
            evidence.definitionWrites.failures,
            [],
            'JCB fixture-owned definition lifecycles and cleanup',
          );
        });
        await suite(session, 'native commands and jobs', () => checkJobs(session, phpBinary));
      }
    } finally {
      await session.close();
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Failed JCB fixture suites: ' + evidence.failedSuites.join(', '));
  evidence.status = 'PASS';
} finally {
  await writeFile('jcb-evidence.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
}

async function suite(session, name, run) {
  try {
    await run();
  } catch (error) {
    evidence.failedSuites.push(session.kind + ' ' + name);
    failures.push(error);
  }
}

function passed(session, name) {
  evidence.checks.push({ transport: session.kind, name });
  console.log(`JMCP-FIXTURE state=PASS phase=jcb transport=${session.kind} check=${JSON.stringify(name)}`);
}

async function grant(session, site, toolset) {
  const request = await session.call({
    name: 'joomla_permission_request',
    arguments: {
      site,
      toolsets: [toolset],
      duration: '30-minutes',
      reason: 'Verify this JCB action in a disposable installed fixture.',
    },
  });
  await session.call({
    name: 'joomla_permission_approve',
    arguments: {
      requestId: request.requestId,
      acknowledgement: request.acknowledgement,
    },
  });
}

function plan(session, site, action, input, transport, dryRun, idempotencyKey = randomUUID()) {
  return session.call({
    name: 'joomla_action_write_plan',
    arguments: { site, action, input, transport, dryRun, idempotencyKey },
  });
}

async function write(session, site, action, input, transport, idempotencyKey = randomUUID()) {
  const issued = await plan(session, site, action, input, transport, false, idempotencyKey);
  assert.equal(typeof issued.confirmationToken, 'string');
  return session.call({
    name: 'joomla_write_apply',
    arguments: { confirmationToken: issued.confirmationToken },
  });
}

function read(session, site, suffix, input) {
  return session.call({
    name: 'joomla_action_read',
    arguments: { site, action: `jcb.api.languages.${suffix}`, transport: 'api', input },
  });
}

async function checkApi(session) {
  const name = 'JCB MCP ' + randomUUID();
  const action = 'jcb.api.languages.create';
  const input = { data: { name, langtag: 'xx-MC' } };
  const findOwned = async () => {
    const list = await read(session, site, 'list', { limit: 10, filter: { search: name } });
    assert.equal(list.status, 200);
    return list.data.data.filter(
      (row) => row.attributes.name === name || row.attributes.name === name + ' updated',
    );
  };
  const search = await session.call({
    name: 'joomla_actions_search',
    arguments: { site, text: 'jcb.api.languages', includeWrites: true },
  });
  assert.ok(search.actions.some((item) => item.id === action));
  const description = await session.call({ name: 'joomla_action_describe', arguments: { site, action } });
  assert.ok(description.availability.transports.includes('api'));
  const preview = await plan(session, site, action, input, 'api', true);
  assert.ok(!preview.confirmationToken);
  assert.deepEqual(await findOwned(), []);
  await assert.rejects(() => plan(session, site, action, input, 'api', false), /grant|permission/i);
  passed(session, 'API-only search, describe, non-mutating preview and ungranted plan denial');
  await grant(session, site, 'jcb.write');
  let id;
  try {
    const result = await write(session, site, action, input, 'api');
    assert.equal(result.verification.status, 'verified', 'Native create and independent item verification');
    id = Number(result.verification.id);
    assert.ok(Number.isSafeInteger(id) && id > 0);
    const before = await read(session, site, 'get', { id });
    assert.equal(before.data.data.attributes.name, name);
    assert.equal(before.data.data.attributes.langtag, 'xx-MC');
    const denied = await fetch(`http://127.0.0.1/api/index.php/v1/componentbuilder/languages/${id}`, {
      headers: { 'X-Joomla-Token': process.env.JCB_FIXTURE_DENIED_TOKEN, Accept: 'application/vnd.api+json' },
    });
    assert.equal(denied.status, 403, 'Valid Joomla API identity lacks JCB language.access');
    await assert.rejects(() => read(session, deniedSite, 'get', { id }));
    const update = await write(
      session,
      site,
      'jcb.api.languages.update',
      { id, data: { name: name + ' updated' } },
      'api',
    );
    assert.equal(update.verification.status, 'verified');
    assert.equal((await read(session, site, 'get', { id })).data.data.attributes.name, name + ' updated');
    passed(session, 'Native API create, independent GET, Joomla ACL denial and verified update');
  } finally {
    // A create may persist before its response is lost. Locate only this run's
    // unique record before cleanup; never repeat the original create.
    const records = await findOwned();
    if (id) assert.ok(records.some((row) => Number(row.id) === id));
    for (const row of records) {
      const ownedId = Number(row.id);
      const trash = await write(
        session,
        site,
        'jcb.api.languages.update',
        { id: ownedId, data: { published: -2 } },
        'api',
      );
      assert.equal(trash.verification.status, 'verified');
      const removal = await write(session, site, 'jcb.api.languages.delete', { id: ownedId }, 'api');
      assert.equal(removal.verification.status, 'verified');
      const response = await fetch(
        `http://127.0.0.1/api/index.php/v1/componentbuilder/languages/${ownedId}`,
        {
          headers: {
            'X-Joomla-Token': process.env.JOOMLA_MCP_LIVE_API_TOKEN,
            Accept: 'application/vnd.api+json',
          },
        },
      );
      assert.equal(response.status, 404, 'The independently read item must be gone.');
    }
    assert.deepEqual(await findOwned(), []);
    passed(session, 'Owned language trashed, deleted and independently checked after cleanup');
  }
}

async function checkInstalledRoutes(session, phpBinary) {
  const pinned = JSON.parse(await readFile('dist/jcb/api-catalog.json', 'utf8'));
  const installed = JSON.parse(
    execFileSync(phpBinary, ['tests/fixtures/joomengine/jcb-native-routes.php'], { encoding: 'utf8' }),
  );
  assert.deepEqual(
    installed,
    pinned.routes,
    'Native plugin method/path/controller triples match the Node catalogue',
  );
  const resources = Object.entries(pinned.resources);
  assert.equal(resources.length, 53);
  evidence.api = { registeredRoutes: Object.keys(installed).length, collections: {}, guidChecks: [] };
  const failures = [];
  for (const [resource, descriptor] of resources) {
    const action = 'jcb.api.' + resource + '.list';
    const input = descriptor.paginated ? { limit: 1 } : {};
    try {
      const result = await session.call({
        name: 'joomla_action_read',
        arguments: { site, action, transport: 'api', input },
      });
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.data.data));
      if (descriptor.paginated) assert.ok(result.data.data.length <= 1);
      evidence.api.collections[resource] = { outcome: 'read', returned: result.data.data.length };
    } catch (error) {
      // Direct native control isolates an installed controller error from an MCP
      // regression. In particular a missing route, lost credentials or a working
      // native JSON:API response must never turn a failed adapter test green.
      const url = new URL('http://127.0.0.1/api/index.php/v1/componentbuilder/' + resource);
      if (descriptor.paginated) {
        url.searchParams.set('page[limit]', '1');
        url.searchParams.set('page[offset]', '0');
      }
      const native = await fetch(url, {
        headers: {
          'X-Joomla-Token': process.env.JOOMLA_MCP_LIVE_API_TOKEN,
          Accept: 'application/vnd.api+json',
        },
      });
      const documentedDynamicList = !descriptor.paginated && ['compiler', 'extrusion'].includes(resource);
      const diagnostic = documentedDynamicList && [400, 405, 500].includes(native.status);
      evidence.api.collections[resource] = {
        outcome: diagnostic ? 'native controller error' : 'failed',
        nativeStatus: native.status,
      };
      if (!diagnostic)
        failures.push(
          new Error('Collection ' + resource + ' failed (native HTTP ' + native.status + ')', {
            cause: error,
          }),
        );
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  for (const resource of ['joomla_components', 'admin_views']) {
    const action = 'jcb.api.' + resource;
    const first = await session.call({
      name: 'joomla_action_read',
      arguments: { site, action: action + '.list', input: { limit: 1 } },
    });
    assert.equal(first.data.data.length, 1, 'Expected an installed ' + resource + ' definition');
    const id = Number(first.data.data[0].id);
    const numeric = await session.call({
      name: 'joomla_action_read',
      arguments: { site, action: action + '.get', input: { id } },
    });
    const guid = numeric.data.data.attributes.guid;
    assert.match(guid, /^[0-9a-f-]{36}$/i);
    const byGuid = await session.call({
      name: 'joomla_action_read',
      arguments: { site, action: action + '.get.guid', input: { guid } },
    });
    assert.equal(Number(byGuid.data.data.id), id);
    assert.equal(byGuid.data.data.attributes.guid, guid);
    evidence.api.guidChecks.push(resource);
  }
  passed(session, 'Inspected every registered API route, all 53 collection reads and numeric/GUID identity');
}

async function checkJobs(session, phpBinary) {
  const site = localSite;
  const inventory = await session.call({ name: 'joomla_cli_inventory', arguments: { site } });
  const nativeCommands = inventory.data.commands.filter((command) =>
    command.name.startsWith('componentbuilder:'),
  );
  const description = JSON.parse(
    execFileSync(
      phpBinary,
      [
        '/var/www/html/cli/joomla.php',
        'joomla:mcp:describe',
        '--format=json',
        '--no-interaction',
        '--no-ansi',
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
  const commands = new Map(
    description.actions
      .filter((item) => item.name.startsWith('jcb.') && item.effective.allowed)
      .map((item) => [item.name, item]),
  );
  const found = await session.call({
    name: 'joomla_actions_search',
    arguments: {
      site,
      domain: 'jcb',
      includeWrites: true,
    },
  });
  assert.deepEqual(found.actions.map((item) => item.id).sort(), [...commands.keys()].sort());
  evidence.commands = nativeCommands.map((command) => {
    const id = 'jcb.' + command.name.split(':').slice(1).join('.');
    const descriptor = commands.get(id);
    const options = descriptor?.inputSchema.properties.options;
    if (descriptor) {
      assert.equal(options.additionalProperties, false, id);
      const nativeOptions = new Set(command.options.map((option) => option.name));
      for (const key of Object.keys(options.properties))
        assert.ok(nativeOptions.has(key), id + ' option ' + key);
    }
    return {
      command: command.name,
      action: descriptor ? id : null,
      arguments: command.arguments.map((arg) => arg.name),
      nativeOptions: command.options.map((option) => option.name),
      exposedOptions: descriptor ? Object.keys(options.properties) : [],
    };
  });
  assert.ok(
    nativeCommands.length >= 111,
    'The installed fixture should include at least the pinned baseline command families.',
  );
  assert.equal(evidence.commands.filter((command) => command.action).length, commands.size);
  for (const command of ['componentbuilder:init:joomla_component', 'componentbuilder:compile:component']) {
    assert.ok(
      inventory.data.commands.some((item) => item.name === command),
      `Installed ${command}`,
    );
  }
  passed(session, 'Native compiler and package commands appear in the installed inventory');
  await grant(session, site, 'jcb.execute');
  await runJob(session, 'jcb.init.joomla_component', { items: demo });
  passed(session, 'Native jcb.init.joomla_component verified');

  // All ordinary package operations finish before compiling. If the compiler
  // reports an uncertain outcome, the same site's lease stops further writes.
  await checkPackageRoundtrip(session, phpBinary);
  const compiler = await runJob(session, 'jcb.compile.component', {
    component: demo,
    'joomla-version': '6',
    'add-build-date': '2',
    'build-date': '2026-01-01',
  });
  assert.ok(compiler.artifacts.length > 0, 'The installed compiler must produce an archive.');
  for (const artifact of compiler.artifacts)
    await verifyArchive(session, localSite, compiler.jobId, artifact);
  passed(session, 'Native jcb.compile.component independently verified');

  await checkPackageRoundtrip(session, phpBinary, true);
}

async function runJob(session, action, options, expected = 'succeeded', key = randomUUID()) {
  const site = localSite;
  const preview = await plan(session, site, action, { options }, 'cli', true);
  assert.equal(preview.dryRun, true);
  assert.ok(!preview.confirmationToken);
  const receipt = await write(session, site, action, { options }, 'cli', key);
  let job = receipt.job;
  const deadline = Date.now() + 330_000;
  while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
    await setTimeout(500);
    job = await session.call({ name: 'joomla_jcb_job_get', arguments: { site, jobId: job.jobId } });
  }
  evidence.jobs ??= [];
  evidence.jobs.push({
    action,
    jobId: job.jobId,
    status: job.status,
    verification: job.verification,
    counts: job.counts,
    message: job.message,
    failurePhase: job.failurePhase,
    reasonCode: job.reasonCode,
    artifacts: job.artifacts?.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  });
  const reason = job.reasonCode ? ' (' + job.failurePhase + ': ' + job.reasonCode + ')' : '';
  assert.equal(job.status, expected, action + ' must report its actual native outcome' + reason);
  return job;
}

async function checkPackageRoundtrip(session, phpBinary, rejectionOnly = false) {
  const guid = randomUUID();
  const repo = randomUUID();
  const fixture = spawn(phpBinary, ['tests/fixtures/joomengine/jcb-package-fixture.php', guid, repo], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(fixture, 'close');
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  async function request(command) {
    if (command) fixture.stdin.write(command + '\n');
    const reply = await lines.next();
    assert.equal(reply.done, false, 'The local package repository fixture must provide a reply.');
    return JSON.parse(reply.value);
  }
  try {
    assert.deepEqual(await request(), { ready: true });
    const execute = (verb, options = {}) =>
      runJob(session, 'jcb.' + verb + '.joomla_component', { items: guid, ...options });
    await execute('push');
    if (rejectionOnly) {
      const before = await request('reject-writes');
      const action = 'jcb.push.joomla_component';
      const options = { items: guid };
      const key = randomUUID();
      const rejected = await runJob(session, action, options, 'uncertain', key);
      const after = await request('fingerprint');
      assert.equal(after.sha256, before.sha256);
      assert.ok(
        after.requests > before.requests,
        'The installed command actually contacted the rejecting fixture.',
      );
      const replay = await write(session, localSite, action, { options }, 'cli', key);
      assert.equal(replay.job.jobId, rejected.jobId);
      assert.deepEqual(await request('fingerprint'), after, 'A repeated key cannot repeat the native push.');
      passed(
        session,
        'Rejected push retained its original job and left remote bytes unchanged, including on replay',
      );
      return;
    }

    const original = {
      nativeLocal: 'revision one',
      nativeRemote: 'revision one',
      linkedLocal: true,
      linkedRemote: true,
    };
    assert.deepEqual(await request('inspect'), original);
    for (const verb of ['get', 'init']) {
      assert.deepEqual(await request('delete-local'), { deleted: true });
      await execute(verb, verb === 'init' ? { repo } : {});
      assert.deepEqual(await request('inspect'), original);
    }
    const updated = { ...original, nativeLocal: 'revision two', nativeRemote: 'revision two' };
    await request('remote-revision');
    await execute('pull', { repo });
    assert.deepEqual(await request('inspect'), updated);
    assert.deepEqual(await request('local-revision'), { changed: true });
    await execute('reset');
    assert.deepEqual(await request('inspect'), updated);
    assert.deepEqual(await request('local-revision'), { changed: true });
    await execute('push');
    assert.deepEqual(await request('inspect'), {
      ...updated,
      nativeLocal: 'local revision',
      nativeRemote: 'local revision',
    });
    const requests = await request('requests');
    assert.deepEqual(requests.methods.sort(), ['GET', 'POST', 'PUT']);
    assert.deepEqual(requests.branches, ['fixture']);
    passed(
      session,
      'Loopback push/get/init/pull/reset preserved the component and its linked update definition',
    );
  } finally {
    fixture.stdin.end();
    const [code] = await exited;
    assert.equal(
      code,
      0,
      'Repository fixture cleaned up its owned records and restored site repository settings.',
    );
  }
}

async function verifyArchive(session, site, jobId, artifact) {
  const file = resolve('verify-' + randomUUID() + '.zip');
  const output = await open(file, 'wx', 0o600);
  try {
    let offset = 0;
    const hash = createHash('sha256');
    do {
      const chunk = await session.call({
        name: 'joomla_jcb_artifact_read',
        arguments: {
          site,
          jobId,
          name: artifact.name,
          offset,
          limit: 262144,
        },
      });
      const bytes = Buffer.from(chunk.data, 'base64');
      assert.equal(chunk.offset, offset);
      assert.ok(bytes.length > 0 && bytes.length <= 262144);
      assert.equal(bytes.length, chunk.bytes);
      hash.update(bytes);
      await output.writeFile(bytes);
      offset += bytes.length;
      assert.equal(chunk.eof, offset === artifact.size);
    } while (offset < artifact.size);
    assert.equal(hash.digest('hex'), artifact.sha256);
    await output.sync();
    execFileSync('php', [
      '-r',
      `
      $zip = new ZipArchive();
      if ($zip->open($argv[1], ZipArchive::CHECKCONS) !== true) { exit(1); }
      for ($i = 0; $i < $zip->numFiles; $i++) {
        if (!str_ends_with($zip->getNameIndex($i), '.xml')) { continue; }
        $xml = @simplexml_load_string($zip->getFromIndex($i));
        if ($xml && $xml->getName() === 'extension') { exit(0); }
      }
      exit(1);`,
      file,
    ]);
  } finally {
    await output.close();
    await rm(file, { force: true });
  }
}
