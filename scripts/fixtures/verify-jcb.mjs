import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { loadConfiguration } from '../../dist/config/load.js';
import { createHttpLiveSession, createStdioLiveSession } from '../../dist/live-test/transports.js';

assert.deepEqual(process.argv.slice(2), ['--disposable']);
const site = 'jcbApi';
const localSite = 'jcbLocal';
const deniedSite = 'jcbDenied';
const configFile = resolve('jcb-sites.json');
const evidence = { jcbPackageVersion: '6.2.0', checks: [], status: 'FAIL' };
const demo = '1c20aec5-bf1a-44e7-9deb-d1c920ca591d';

try {
  const packageVersion = execFileSync('php', ['-r',
    'echo simplexml_load_file("/var/www/html/administrator/manifests/packages/pkg_component_builder.xml")->version;'
  ], { encoding: 'utf8' });
  assert.equal(packageVersion, evidence.jcbPackageVersion);
  const phpBinary = execFileSync('php', ['-r', 'echo PHP_BINARY;'], { encoding: 'utf8' });
  process.env.JCB_FIXTURE_DENIED_TOKEN = execFileSync(phpBinary, ['tests/fixtures/joomengine/jcb-denied-token.php'], {encoding:'utf8'});
  const jobs = resolve('jobs');
  await mkdir(jobs, { mode: 0o700 });
  const api = { baseUrl: 'http://127.0.0.1', tokenEnv: 'JOOMLA_MCP_LIVE_API_TOKEN', allowInsecureLoopback: true };
  await writeFile(configFile, JSON.stringify({
    defaultSite: site,
    approval: { secretEnv: 'JOOMLA_MCP_LIVE_APPROVAL_SECRET' },
    sites: {
      [site]: { api, toolsets: ['discovery', 'jcb.read', 'jcb.write'] },
      [deniedSite]: { api: {...api, tokenEnv: 'JCB_FIXTURE_DENIED_TOKEN'}, toolsets: ['discovery','jcb.read'] },
      [localSite]: { cli: { root: '/var/www/html', phpBinary, jcbJobDirectory: jobs, timeoutMs: 300000,
        maxOutputBytes: 2097152 }, toolsets: ['discovery', 'cli.discovery', 'jcb.execute'] },
    },
  }), {mode: 0o600});
  const configuration = await loadConfiguration(configFile);
  for (const transport of ['stdio', 'http']) {
    const session = transport === 'stdio'
      ? await createStdioLiveSession({ configurationFile: configFile })
      : await createHttpLiveSession(configuration);
    try {
      await checkApi(session);
      if (transport === 'stdio') await checkJobs(session);
    } finally { await session.close(); }
  }
  evidence.status = 'PASS';
} finally {
  await writeFile('jcb-evidence.json', JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
}

function passed(session, name) {
  evidence.checks.push({transport: session.kind, name});
  console.log(`JMCP-FIXTURE state=PASS phase=jcb transport=${session.kind} check=${JSON.stringify(name)}`);
}

async function grant(session, site, toolset) {
  const request = await session.call({name:'joomla_permission_request', arguments:{
    site, toolsets:[toolset], duration:'30-minutes', reason:'Verify this JCB action in a disposable installed fixture.',
  }});
  await session.call({name:'joomla_permission_approve', arguments:{
    requestId:request.requestId, acknowledgement:request.acknowledgement,
  }});
}

function plan(session, site, action, input, transport, dryRun) {
  return session.call({name:'joomla_action_write_plan', arguments:{site, action, input, transport, dryRun, idempotencyKey:randomUUID()}});
}

async function write(session, site, action, input, transport) {
  const issued = await plan(session, site, action, input, transport, false);
  assert.equal(typeof issued.confirmationToken, 'string');
  return session.call({name:'joomla_write_apply', arguments:{confirmationToken:issued.confirmationToken}});
}

function read(session, site, suffix, input) {
  return session.call({name:'joomla_action_read', arguments:{site, action:`jcb.api.languages.${suffix}`, transport:'api', input}});
}

async function checkApi(session) {
  const name = 'JCB MCP ' + randomUUID();
  const action = 'jcb.api.languages.create';
  const input = {data:{name, langtag:'xx-MC'}};
  const findOwned = async () => {
    const list = await read(session, site, 'list', {limit:10, filter:{search:name}});
    assert.equal(list.status, 200);
    return list.data.data.filter(row => row.attributes.name === name || row.attributes.name === name + ' updated');
  };
  const search = await session.call({name:'joomla_actions_search', arguments:{site,text:'jcb.api.languages',includeWrites:true}});
  assert.ok(search.actions.some(item => item.id === action));
  const description = await session.call({name:'joomla_action_describe', arguments:{site,action}});
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
    const before = await read(session, site, 'get', {id});
    assert.equal(before.data.data.attributes.name, name);
    assert.equal(before.data.data.attributes.langtag, 'xx-MC');
    const denied = await fetch(`http://127.0.0.1/api/index.php/v1/componentbuilder/languages/${id}`, {
      headers: {'X-Joomla-Token':process.env.JCB_FIXTURE_DENIED_TOKEN, Accept:'application/vnd.api+json'},
    });
    assert.equal(denied.status, 403, 'Valid Joomla API identity lacks JCB language.access');
    await assert.rejects(() => read(session, deniedSite, 'get', {id}));
    const update = await write(session, site, 'jcb.api.languages.update', {id,data:{name:name + ' updated'}}, 'api');
    assert.equal(update.verification.status, 'verified');
    assert.equal((await read(session, site, 'get', {id})).data.data.attributes.name, name + ' updated');
    passed(session, 'Native API create, independent GET, Joomla ACL denial and verified update');
  } finally {
    // A create may persist before its response is lost. Locate only this run's
    // unique record before cleanup; never repeat the original create.
    const records = await findOwned();
    if (id) assert.ok(records.some(row => Number(row.id) === id));
    for (const row of records) {
      const ownedId = Number(row.id);
      const trash = await write(session, site, 'jcb.api.languages.update', {id:ownedId,data:{published:-2}}, 'api');
      assert.equal(trash.verification.status, 'verified');
      const removal = await write(session, site, 'jcb.api.languages.delete', {id:ownedId}, 'api');
      assert.equal(removal.verification.status, 'verified');
      const response = await fetch(`http://127.0.0.1/api/index.php/v1/componentbuilder/languages/${ownedId}`,
        {headers:{'X-Joomla-Token':process.env.JOOMLA_MCP_LIVE_API_TOKEN, Accept:'application/vnd.api+json'}});
      assert.equal(response.status, 404, 'The independently read item must be gone.');
    }
    assert.deepEqual(await findOwned(), []);
    passed(session, 'Owned language trashed, deleted and independently checked after cleanup');
  }
}

async function checkJobs(session) {
  const site = localSite;
  const inventory = await session.call({name:'joomla_cli_inventory',arguments:{site}});
  for (const command of ['componentbuilder:init:joomla_component', 'componentbuilder:compile:component']) {
    assert.ok(inventory.data.commands.some(item => item.name === command), `Installed ${command}`);
  }
  passed(session, 'Native compiler and package commands appear in the installed inventory');
  await grant(session, site, 'jcb.execute');
  for (const [action, options] of [
    ['jcb.init.joomla_component', {items:demo}],
    ['jcb.compile.component', {component:demo, 'joomla-version':'6'}],
  ]) {
    const preview = await plan(session, site, action, {options}, 'cli', true);
    assert.ok(!preview.confirmationToken);
    const applied = await write(session, site, action, {options}, 'cli');
    const jobId = applied.job.jobId;
    let job = applied.job;
    const deadline = Date.now() + 330_000;
    while (['queued','running'].includes(job.status) && Date.now() < deadline) {
      await setTimeout(500);
      job = await session.call({name:'joomla_jcb_job_get',arguments:{site,jobId}});
    }
    assert.equal(job.status, 'succeeded', `${action} should finish and verify its native result`);
    if (action === 'jcb.compile.component') {
      assert.ok(job.artifacts.length > 0, 'The installed compiler must produce an archive.');
      for (const artifact of job.artifacts) await verifyArchive(session, site, jobId, artifact);
    }
    passed(session, `Native ${action} verified`);
  }
}

async function verifyArchive(session, site, jobId, artifact) {
  const file = resolve('verify-' + randomUUID() + '.zip');
  const output = await open(file, 'wx', 0o600);
  try {
    let offset = 0;
    const hash = createHash('sha256');
    do {
      const chunk = await session.call({name:'joomla_jcb_artifact_read',arguments:{
        site,jobId,name:artifact.name,offset,limit:262144,
      }});
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
    execFileSync('php', ['-r', `
      $zip = new ZipArchive();
      if ($zip->open($argv[1], ZipArchive::CHECKCONS) !== true) { exit(1); }
      for ($i = 0; $i < $zip->numFiles; $i++) {
        if (!str_ends_with($zip->getNameIndex($i), '.xml')) { continue; }
        $xml = @simplexml_load_string($zip->getFromIndex($i));
        if ($xml && $xml->getName() === 'extension') { exit(0); }
      }
      exit(1);`, file]);
  } finally {
    await output.close();
    await rm(file, {force:true});
  }
}
