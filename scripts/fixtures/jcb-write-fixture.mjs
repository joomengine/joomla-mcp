import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = 'http://127.0.0.1/api/index.php/v1/componentbuilder/';
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Relationships below always come from a previous native POST and independent
// GET in this run. The fixture never copies a site's confidential definitions or
// changes a pre-existing record to exercise a write.
function definitionCases(marker) {
  const named = { name: marker };
  const description = 'Disposable native JCB form ' + marker;
  const simple = (resource, data, update) => ({ resource, owner: 'name', data: () => data, update });
  const group = (owned) => owned.get('joomla_plugin_groups').guid;
  return [
    simple('snippet_types', { ...named, description }, { description: description + ' edited' }),
    simple('templates', { ...named, description, alias: marker }, { description: description + ' edited' }),
    simple('layouts', { ...named, description, alias: marker }, { description: description + ' edited' }),
    simple('joomla_modules', { ...named, system_name: marker, module_version: '1.0.0' }, { module_version: '1.0.1' }),
    simple('class_extendings', { ...named, extension_type: 'plugins' }, { comment: description }),
    {
      resource: 'joomla_plugin_groups', owner: 'name', dependencies: ['class_extendings'],
      data: owned => ({ ...named, class_extends: owned.get('class_extendings').guid }),
      update: { published: 1 }, relationship: 'class_extends',
    },
    ...['class_properties', 'class_methods'].map(resource => ({
      resource, owner: 'name', dependencies: ['joomla_plugin_groups'],
      // The native group selector is visible when extension_type is plugins.
      data: owned => ({ ...named, extension_type: 'plugins', visibility: 'public', joomla_plugin_group: group(owned) }),
      update: { visibility: 'protected' }, relationship: 'joomla_plugin_group',
    })),
    {
      resource: 'admin_views', owner: 'system_name',
      data: () => ({system_name: marker, name_single: marker, name_list: marker + 's', short_description: description,
        // The model resolves its conditional requirements from add_sql. The
        // disabled SQL branch must not require the hidden source selector.
        add_sql: 0}),
      update: {addtabs: {addtabs0: {name: 'General'}, addtabs1: {name: 'Details'}}},
    },
  ];
}

async function call(session, name, args) {
  return session.call({name, arguments: args});
}

async function write(session, site, resource, operation, input) {
  const issued = await call(session, 'joomla_action_write_plan', {
    site, action: `jcb.api.${resource}.${operation}`, transport: 'api', input,
    dryRun: false, idempotencyKey: randomUUID(),
  });
  assert.equal(typeof issued.confirmationToken, 'string');
  return call(session, 'joomla_write_apply', {confirmationToken: issued.confirmationToken});
}

function read(session, site, resource, operation, input) {
  return call(session, 'joomla_action_read', {
    site, action: `jcb.api.${resource}.${operation}`, transport: 'api', input,
  });
}

async function native(resource, suffix, query = {}) {
  const url = new URL(resource + suffix, root);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {redirect:'error', signal:AbortSignal.timeout(30000), headers:{
    Accept:'application/vnd.api+json', 'X-Joomla-Token':process.env.JOOMLA_MCP_LIVE_API_TOKEN,
  }});
  if (response.status === 404) return {status:404};
  assert.equal(response.status,200,'Native JSON:API control returned HTTP ' + response.status);
  return {status:200, data:(await response.json()).data};
}

function field(item, name) {
  if (Object.hasOwn(item.attributes ?? {},name)) return item.attributes[name];
  const relation = item.relationships?.[name]?.data;
  return Array.isArray(relation) ? relation.map(row => row.id) : relation?.id;
}

async function ownedIds(spec, marker) {
  // All selected controllers expose search. A separate trashed query also
  // recovers an interrupted cleanup after JCB's native trash transition.
  const ids = new Set();
  for (const state of [undefined,-2]) {
    const params = {'filter[search]':marker,'page[limit]':100};
    if (state !== undefined) params['filter[published]'] = state;
    for (let page = 0; page < 10; page++) {
      const result = await native(spec.resource,'',{...params,'page[offset]':page*100});
      assert.ok(Array.isArray(result.data),'Native identity search did not return a collection.');
      for (const item of result.data) {
        if (field(item,spec.owner) === marker) {
          const id = Number(item.id);
          assert.ok(Number.isSafeInteger(id) && id > 0);
          ids.add(id);
        }
      }
      if (result.data.length < 100) break;
      if (page === 9) throw new Error('Bounded ownership search was incomplete.');
    }
  }
  return ids;
}

async function recreateGrant(session, site) {
  const grant = await call(session,'joomla_permission_request',{
    site,toolsets:['jcb.write'],duration:'30-minutes',reason:'Verify fixture-owned JCB definition lifecycles and remove those records.',
  });
  await call(session,'joomla_permission_approve',{requestId:grant.requestId,acknowledgement:grant.acknowledgement});
}

function evidenceError(error) {
  if (error instanceof assert.AssertionError) return 'assertion';
  const status = /HTTP ([1-5][0-9]{2})/.exec(String(error?.message));
  return status ? `HTTP ${status[1]}` : 'operation failed';
}

export async function runJcbWriteFixture(session, site) {
  assert.deepEqual(process.argv.slice(2),['--disposable']);
  assert.equal(process.cwd(),'/tmp/joomla-mcp-jcb-fixture');
  assert.equal(site,'jcbApi');
  const catalogue = JSON.parse(await readFile('dist/jcb/api-catalog.json','utf8'));
  const writable = Object.keys(catalogue.routes).filter(route => route.startsWith('POST ')).map(route => route.split('/').at(-1));
  assert.equal(new Set(writable).size,51);
  const families = Object.fromEntries(writable.map(name => [name,{status:'not-exercised',reason:'No fixture-owned write scenario for this family.'}]));
  families.languages = {status:'covered-by-language-fixture',reason:'Separate stdio/HTTP test verifies create, read, update, ACL denial, trash and delete.'};
  const failures = [];
  const owned = new Map();
  const attempted = [];
  const marker = 'jcbfixture' + randomUUID().replaceAll('-','');
  const scenarios = definitionCases(marker);
  await recreateGrant(session,site);

  for (const spec of scenarios) {
    const {resource} = spec;
    const problem = (spec.dependencies ?? []).find(parent => !owned.get(parent)?.guid);
    if (problem) {
      families[resource] = {status:'blocked-by-fixture-dependency',parent:problem};
      failures.push(resource + ': dependency ' + problem);
      continue;
    }
    let phase = 'initial ownership check';
    const detail = families[resource] = {status:'running',steps:[]};
    try {
      assert.equal((await ownedIds(spec,marker)).size,0,'Fresh unique marker already exists.');
      const data = spec.data(owned);
      phase = 'native create';
      // Mark ownership intent *before* forwarding. Even if the response is lost,
      // cleanup searches only this run's unique field marker.
      attempted.push(spec);
      const created = await write(session,site,resource,'create',{data});
      assert.equal(created.verification.status,'verified','JCB create was not independently verified.');
      const id = Number(created.verification.id);
      assert.ok(Number.isSafeInteger(id) && id>0);
      owned.set(resource,{id});
      phase = 'numeric identity and fields';
      const control = await native(resource,'/'+id);
      assert.equal(field(control.data,spec.owner),marker);
      assert.equal(control.data.type,resource);
      const byId = await read(session,site,resource,'get',{id});
      assert.equal(String(byId.data.data.id),String(control.data.id));
      if (spec.relationship) {
        assert.equal(String(field(control.data,spec.relationship)),String(data[spec.relationship]));
        assert.equal(String(field(byId.data.data,spec.relationship)),String(data[spec.relationship]));
      }
      const guid = field(control.data,'guid');
      assert.match(guid,guidPattern);
      const byGuid = await read(session,site,resource,'get.guid',{guid});
      assert.equal(String(byGuid.data.data.id),String(id));
      owned.set(resource,{id,guid});
      detail.steps.push('verified create, numeric and GUID reads');
      if (spec.relationship) detail.steps.push('independent native relationship identity');

      phase = 'GUID update and independent field read';
      const updated = await write(session,site,resource,'update.guid',{guid,data:spec.update});
      assert.equal(updated.verification.status,'verified','JCB did not verify the approved update.');
      const saved = (await native(resource,'/'+id)).data;
      assert.equal(field(saved,spec.owner),marker);
      for (const [name,expected] of Object.entries(spec.update)) {
        const raw = field(saved,name);
        if (typeof expected === 'object') {
          const observed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          assert.deepEqual(observed,expected);
          assert.deepEqual(Object.keys(observed),Object.keys(expected),'Repeatable row order is significant.');
        } else assert.equal(String(raw),String(expected));
      }
      detail.steps.push('verified GUID update and independent numeric read');
      detail.status = 'awaiting-cleanup';
    } catch (error) {
      detail.status = 'failed';
      detail.phase = phase;
      detail.diagnostic = evidenceError(error);
      failures.push(resource + ': ' + phase + ' (' + detail.diagnostic + ')');
    }
  }

  // The legacy form disabling source is a gated native contract with explicit
  // preflight failure. Do not dispatch a knowingly invalid create to the site.
  try {
    const action = 'jcb.api.language_translations.create';
    await assert.rejects(call(session,'joomla_action_write_plan',{
      site,action,input:{data:{source:marker}},transport:'api',dryRun:true,idempotencyKey:randomUUID(),
    }),/disables source/);
    families.language_translations = {status:'native-create-gated',reason:'Pinned native translation source form disables create.'};
  } catch (error) {
    failures.push('language_translations: unexpected create preflight (' + evidenceError(error) + ')');
    families.language_translations = {status:'failed',phase:'native create gate'};
  }

  // Descendants go first so an earlier failed assertion never leaves an owned
  // parent in use by a subsequent fixture. No pre-existing row can be mutated.
  for (const spec of attempted.reverse()) {
    const detail = families[spec.resource];
    try {
      const ids = await ownedIds(spec,marker);
      if (owned.has(spec.resource)) ids.add(owned.get(spec.resource).id);
      if (detail.status === 'awaiting-cleanup') assert.equal(ids.size,1);
      for (const id of ids) {
        const before = await native(spec.resource,'/'+id);
        if (before.status === 404) continue;
        assert.equal(field(before.data,spec.owner),marker,'Refusing to clean a row without the fixture marker.');
        const state = field(before.data,'published');
        if (String(state) !== '-2') {
          const trash = await write(session,site,spec.resource,'update',{id,data:{published:-2}});
          assert.equal(trash.verification.status,'verified','Native trash transition did not verify.');
        }
        const removed = await write(session,site,spec.resource,'delete',{id});
        assert.equal(removed.verification.status,'verified','Native removal did not verify.');
        assert.equal((await native(spec.resource,'/'+id)).status,404,'Deleted JCB row remains readable.');
      }
      assert.equal((await ownedIds(spec,marker)).size,0);
      detail.steps.push('verified owned-record cleanup');
      if (detail.status === 'awaiting-cleanup') detail.status = 'verified-lifecycle';
    } catch (error) {
      detail.cleanup = 'failed';
      failures.push(spec.resource + ': cleanup (' + evidenceError(error) + ')');
    }
  }
  const counts = {};
  for (const family of Object.values(families)) counts[family.status] = (counts[family.status] ?? 0) + 1;
  return {families,counts,failures};
}
