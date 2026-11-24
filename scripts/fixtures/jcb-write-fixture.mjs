import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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
  const group = owned => owned.get('joomla_plugin_groups').guid;
  return [
    simple('snippet_types', { ...named, description }, { description: description + ' edited' }),
    simple('libraries', { ...named, target: 1, type: 1, how: '1' }, { description }),
    {
      resource: 'snippets',
      owner: 'name',
      dependencies: ['snippet_types', 'libraries'],
      data: owned => ({
        ...named,
        heading: description,
        url: 'https://example.invalid/disposable',
        type: owned.get('snippet_types').guid,
        library: owned.get('libraries').guid,
        snippet: '// Disposable fixture text.',
      }),
      update: { description },
      relationships: ['type', 'library'],
    },
    {
      resource: 'joomla_components',
      owner: 'system_name',
      // Same definition fields as the package roundtrip fixture and a fresh,
      // API-generated GUID. The project is never compiled or installed.
      data: () => ({
        ...named,
        system_name: marker,
        name_code: marker,
        short_description: description,
        component_version: '1.0.0',
        preferred_joomla_version: 6,
        add_namespace_prefix: '1',
        namespace_prefix: 'Fixture',
        add_powers: 0,
        companyname: 'MCP Fixture',
        author: 'MCP Fixture',
        email: 'fixture@example.invalid',
        website: 'https://example.invalid',
        buildcomp: 0,
      }),
      update: { short_description: description + ' edited' },
    },
    {
      resource: 'joomla_powers',
      owner: 'system_name',
      data: () => ({
        system_name: marker,
        settings: { settings0: { namespace: 'Joomla\\CMS\\Factory', joomla_version: '6' } },
      }),
      update: { description },
    },
    simple('templates', { ...named, description, alias: marker }, { description: description + ' edited' }),
    simple('layouts', { ...named, description, alias: marker }, { description: description + ' edited' }),
    simple(
      'joomla_modules',
      { ...named, system_name: marker, module_version: '1.0.0' },
      { module_version: '1.0.1' },
    ),
    simple('class_extendings', { ...named, extension_type: 'plugins' }, { comment: description }),
    {
      resource: 'joomla_plugin_groups',
      owner: 'name',
      dependencies: ['class_extendings'],
      data: owned => ({ ...named, class_extends: owned.get('class_extendings').guid }),
      update: { name: marker + 'edited' },
      relationships: ['class_extends'],
    },
    {
      resource: 'joomla_plugins',
      owner: 'name',
      dependencies: ['class_extendings', 'joomla_plugin_groups'],
      data: owned => ({
        ...named,
        system_name: marker,
        class_extends: owned.get('class_extendings').guid,
        joomla_plugin_group: group(owned),
      }),
      update: { description },
      relationships: ['class_extends', 'joomla_plugin_group'],
    },
    ...['class_properties', 'class_methods'].map(resource => ({
      resource,
      owner: 'name',
      dependencies: ['joomla_plugin_groups'],
      // The native group selector is visible when extension_type is plugins.
      data: owned => ({
        ...named,
        extension_type: 'plugins',
        visibility: 'public',
        joomla_plugin_group: group(owned),
      }),
      update: { visibility: 'protected' },
      relationships: ['joomla_plugin_group'],
    })),
    {
      resource: 'admin_views',
      owner: 'system_name',
      data: () => ({
        system_name: marker,
        name_single: marker,
        name_list: marker + 's',
        short_description: description,
        // The model resolves its conditional requirements from add_sql. The
        // disabled SQL branch must not require the hidden source selector.
        add_sql: 0,
      }),
      update: { addtabs: { addtabs0: { name: 'General' }, addtabs1: { name: 'Details' } } },
    },
  ];
}

async function call(session, name, args) {
  return session.call({ name, arguments: args });
}

async function write(session, site, resource, operation, input) {
  const issued = await call(session, 'joomla_action_write_plan', {
    site,
    action: `jcb.api.${resource}.${operation}`,
    transport: 'api',
    input,
    dryRun: false,
    idempotencyKey: randomUUID(),
  });
  assert.equal(typeof issued.confirmationToken, 'string');
  const result = await call(session, 'joomla_write_apply', { confirmationToken: issued.confirmationToken });
  if (result.verification?.status !== 'verified') {
    const status = result.mutation?.status;
    // Keep native HTTP status without retaining private request/response bodies.
    const rejected = result.verification?.nativeRejectedFields ?? [];
    const mismatch = /^Read-back did not verify the approved field ([A-Za-z_0-9]+)\.$/.exec(
      result.verification?.reason ?? '',
    );
    const fields = [...new Set([...rejected, ...(mismatch ? [mismatch[1]] : [])])].filter(name =>
      /^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(name),
    );
    const error = new Error('Unverified native mutation' + (Number.isInteger(status) ? ' HTTP ' + status : ''));
    error.fixtureDiagnostic = {
      category: mismatch ? 'read-back-mismatch' : status >= 400 ? 'native-rejection' : 'uncertain-mutation',
      ...(Number.isInteger(status) ? { httpStatus: status } : {}),
      fields,
    };
    throw error;
  }
  return result;
}

function read(session, site, resource, operation, input) {
  return call(session, 'joomla_action_read', {
    site,
    action: `jcb.api.${resource}.${operation}`,
    transport: 'api',
    input,
  });
}

async function native(resource, suffix, query = {}) {
  const url = new URL(resource + suffix, root);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: 'application/vnd.api+json',
      'X-Joomla-Token': process.env.JOOMLA_MCP_LIVE_API_TOKEN,
    },
  });
  if (response.status === 404) return { status: 404 };
  assert.equal(response.status, 200, 'Native JSON:API control returned HTTP ' + response.status);
  const { data } = await response.json();
  for (const row of Array.isArray(data) ? data : [data])
    assert.equal(row?.type, resource, 'Unexpected native ownership reference type.');
  return { status: 200, data };
}

function field(item, name) {
  if (Object.hasOwn(item.attributes ?? {}, name)) return item.attributes[name];
  const relation = item.relationships?.[name]?.data;
  return Array.isArray(relation) ? relation.map(row => row.id) : relation?.id;
}

function ownerValues(spec, marker, owned) {
  const first = spec.ownerValue ? spec.ownerValue(owned) : marker;
  assert.ok(
    typeof first === 'string' && first.length > 0,
    'Fixture ownership must have a nonempty marker or a verified parent GUID.',
  );
  const values = new Set([first]);
  if (Object.hasOwn(spec.update, spec.owner)) {
    const changed = spec.update[spec.owner];
    assert.ok(
      typeof changed === 'string' && changed.includes(marker),
      'A new fixture ownership field must carry the unique run marker.',
    );
    values.add(changed);
  }
  return values;
}

async function ownedIds(spec, marker, owned) {
  // Joomla may move foreign keys into JSON:API relationships. Search and
  // native item read-back establish ownership independently of the MCP result.
  const anchors = ownerValues(spec, marker, owned);
  const find = spec.ownerFilter ?? (spec.ownerValue ? undefined : 'search');
  const ids = new Set();
  for (const state of [undefined, -2]) {
    const params = { 'page[limit]': 100 };
    if (find) params['filter[' + find + ']'] = [...anchors][0];
    if (state !== undefined) params['filter[published]'] = state;
    for (let page = 0; page < 10; page++) {
      const result = await native(spec.resource, '', { ...params, 'page[offset]': page * 100 });
      assert.ok(Array.isArray(result.data), 'Native identity search did not return a collection.');
      for (const item of result.data) {
        const id = Number(item.id);
        assert.ok(Number.isSafeInteger(id) && id > 0);
        let anchor = field(item, spec.owner);
        if (anchor === undefined) {
          const single = await native(spec.resource, '/' + id);
          if (single.status === 404) continue;
          anchor = field(single.data, spec.owner);
        }
        if (anchors.has(anchor)) ids.add(id);
      }
      if (result.data.length < 100) break;
      if (page === 9) throw new Error('Bounded ownership search was incomplete.');
    }
  }
  return ids;
}

async function recreateGrant(session, site) {
  const grant = await call(session, 'joomla_permission_request', {
    site,
    toolsets: ['jcb.write'],
    duration: '30-minutes',
    reason: 'Verify fixture-owned JCB definition lifecycles and remove those records.',
  });
  await call(session, 'joomla_permission_approve', {
    requestId: grant.requestId,
    acknowledgement: grant.acknowledgement,
  });
}

function evidenceError(error) {
  if (error instanceof assert.AssertionError) return 'assertion';
  const status = /HTTP ([1-5][0-9]{2})/.exec(String(error?.message));
  return status ? `HTTP ${status[1]}` : 'operation failed';
}

export async function runJcbWriteFixture(session, site) {
  assert.deepEqual(process.argv.slice(2), ['--disposable']);
  assert.equal(process.cwd(), '/tmp/joomla-mcp-jcb-fixture');
  assert.equal(site, 'jcbApi');
  const catalogue = JSON.parse(await readFile('dist/jcb/api-catalog.json', 'utf8'));
  const guidFamilies = new Set(Object.keys(catalogue.routes)
    .filter(route => route.startsWith('DELETE ') && route.endsWith('/guid/:guid'))
    .map(route => route.split('/')[2]));
  assert.equal(guidFamilies.size, 21);
  let grantAt = 0;
  const renewIfNeeded = async () => {
    if (Date.now() - grantAt < 20 * 60 * 1000) return;
    await recreateGrant(session, site);
    grantAt = Date.now();
  };
  const primary = await runDefinitionPass(session, site, catalogue, renewIfNeeded);
  // A second, separately marked record is necessary to prove both permanent
  // deletion routes. The second pass also removes children JCB creates itself.
  const alternate = await runDefinitionPass(session, site, catalogue, renewIfNeeded, guidFamilies);
  const guidDeleteVariants = Object.fromEntries([...guidFamilies].map(resource => [resource, alternate.families[resource]]));
  const verifiedActions = [...new Set([...Object.values(primary.families), ...Object.values(alternate.families)]
    .flatMap(detail => detail.verifiedActions ?? []))].sort();
  for (const resource of guidFamilies) {
    for (const operation of ['get', 'get.guid', 'update', 'update.guid', 'delete', 'delete.guid']) {
      const action = `jcb.api.${resource}.${operation}`;
      if (!verifiedActions.includes(action)) alternate.failures.push('Missing verified action: ' + action);
    }
  }
  return {...primary, guidDeleteVariants, verifiedActions,
    failures: [...primary.failures, ...alternate.failures.map(reason => 'GUID deletion pass: ' + reason)]};
}

async function runDefinitionPass(session, site, catalogue, renewIfNeeded, guidFamilies) {
  const writable = Object.keys(catalogue.routes)
    .filter(route => route.startsWith('POST '))
    .map(route => route.split('/').at(-1));
  assert.equal(new Set(writable).size, 51);
  const families = Object.fromEntries(
    writable.map(name => [
      name,
      { status: 'not-exercised', reason: 'No fixture-owned write scenario for this family.' },
    ]),
  );
  families.languages = {
    status: 'covered-by-language-fixture',
    reason: 'Separate stdio/HTTP test verifies create, read, update, ACL denial, trash and delete.',
  };
  const failures = [];
  const owned = new Map();
  const attempted = [];
  const marker = 'jcbfixture' + randomUUID().replaceAll('-', '');
  const { additionalFamilyCases, familyMatrixBoundaries } = await import('./jcb-family-matrix.mjs');
  for (const [family, reason] of Object.entries(familyMatrixBoundaries)) {
    assert.ok(writable.includes(family), 'Unknown boundary family: ' + family);
    families[family] = { status: 'not-exercised', reason };
  }
  const translationSource = 'MCP translation ' + marker + ' %s';
  const scenarios = [
    ...definitionCases(marker), ...additionalFamilyCases(marker),
    {
      resource: 'language_translations', owner: 'source', ownerValue: () => translationSource,
      ownerFilter: 'search', data: () => ({source: translationSource}),
      update: {translation: {translation0: {language: 'en-GB', translation: 'Fixture translation for %s'}}},
      seed: () => Number(execFileSync('php', ['tests/fixtures/joomengine/jcb-seed-translation.php', marker],
        {encoding: 'utf8', timeout: 30000}).trim()),
    },
  ];
  assert.equal(
    new Set(scenarios.map(spec => spec.resource)).size,
    scenarios.length,
    'Duplicate JCB fixture scenario.',
  );
  for (const spec of scenarios)
    assert.ok(writable.includes(spec.resource), 'Unregistered JCB fixture family: ' + spec.resource);
  await renewIfNeeded();

  for (const spec of scenarios) {
    const { resource } = spec;
    const secondaryChild = guidFamilies && !guidFamilies.has(resource) && spec.ownerValue && spec.dependencies?.length;
    if (guidFamilies && !guidFamilies.has(resource) && !secondaryChild) continue;
    const problem = (spec.dependencies ?? []).find(parent => !owned.has(parent));
    if (problem) {
      families[resource] = { status: 'blocked-by-fixture-dependency', parent: problem };
      failures.push(resource + ': dependency ' + problem);
      continue;
    }
    let phase = 'initial ownership check';
    const detail = (families[resource] = { status: 'running', steps: [], verifiedActions: [] });
    try {
      await renewIfNeeded();
      const existing = await ownedIds(spec, marker, owned);
      if (secondaryChild && existing.size === 0) {
        detail.status = 'no-native-child';
        continue;
      }
      const nativeChild = (
        spec.ownerValue &&
        existing.size &&
        (spec.dependencies ?? []).some(parent => owned.get(parent)?.guid === spec.ownerValue(owned))
      );
      if (nativeChild) {
        assert.equal(existing.size, 1, 'Expected exactly one child for the newly created parent.');
      } else {
        assert.equal(existing.size, 0, 'Fresh unique marker already exists.');
      }
      const data = spec.data(owned);
      phase = 'native create';
      // Mark ownership intent *before* forwarding. Even if the response is lost,
      // cleanup searches only this run's unique field marker.
      attempted.push(spec);
      let id;
      if (nativeChild) {
        // This row may be touched only because its GUID references a parent
        // actually created and independently verified during this run.
        [id] = existing;
        detail.creation = 'native-parent';
      } else if (spec.seed) {
        phase = 'native create gate and model seed';
        await assert.rejects(call(session, 'joomla_action_write_plan', {
          site, action: 'jcb.api.language_translations.create', input: {data}, transport: 'api',
          dryRun: true, idempotencyKey: randomUUID(),
        }), /disables source/);
        detail.creation = 'gated-api-create-native-model-seed';
        id = spec.seed();
      } else {
        const created = await write(session, site, resource, 'create', { data });
        assert.equal(created.verification.status, 'verified', 'JCB create was not independently verified.');
        id = Number(created.verification.id);
        detail.creation = 'verified-mcp-create';
        detail.verifiedActions.push(`jcb.api.${resource}.create`);
      }
      assert.ok(Number.isSafeInteger(id) && id > 0);
      owned.set(resource, { id });
      phase = 'numeric identity and fields';
      const control = await native(resource, '/' + id);
      assert.ok(
        ownerValues(spec, marker, owned).has(field(control.data, spec.owner)),
        'Native create returned a record with a different owner marker.',
      );
      assert.equal(control.data.type, resource);
      const byId = await read(session, site, resource, 'get', { id });
      assert.equal(String(byId.data.data.id), String(control.data.id));
      detail.verifiedActions.push(`jcb.api.${resource}.get`);
      for (const name of spec.relationships ?? []) {
        assert.equal(String(field(control.data, name)), String(data[name]));
        assert.equal(String(field(byId.data.data, name)), String(data[name]));
      }
      const supportsGuid = Object.hasOwn(catalogue.routes, `GET v1/componentbuilder/${resource}/guid/:guid`);
      const guid = field(control.data, 'guid');
      if (supportsGuid) {
        assert.match(guid, guidPattern);
        const byGuid = await read(session, site, resource, 'get.guid', { guid });
        assert.equal(String(byGuid.data.data.id), String(id));
        owned.set(resource, { id, guid });
        detail.verifiedActions.push(`jcb.api.${resource}.get.guid`);
      }
      detail.steps.push(supportsGuid ? 'verified numeric and GUID reads' : 'verified numeric read');
      if (spec.relationships) detail.steps.push('independent native relationship identity');
      if (spec.seed) {
        phase = 'reject immutable source change';
        await assert.rejects(call(session, 'joomla_action_write_plan', {
          site, action: 'jcb.api.language_translations.update', transport: 'api',
          input: {id, data: {source: translationSource + ' modified'}}, dryRun: true,
          idempotencyKey: randomUUID(),
        }), /read-only|immutable/i);
        detail.steps.push('confirmed source is immutable');
      }

      const updateByGuid = supportsGuid && !guidFamilies;
      const route = updateByGuid ? 'update.guid' : 'update';
      const identifier = updateByGuid ? { guid } : { id };
      let linkedRows;
      if (spec.link) {
        phase = 'append owned target to existing association rows';
        const {column, edit} = spec.link;
        linkedRows = edit(owned, field(control.data, column));
        await write(session, site, resource, route, {...identifier, data: {[column]: linkedRows}});
        const linked = field((await native(resource, '/' + id)).data, column);
        assert.deepEqual(typeof linked === 'string' ? JSON.parse(linked) : linked, linkedRows);
        detail.steps.push('independent native read verified linked target GUID and existing rows');
      }
      phase = route + ' and independent field read';
      const updated = await write(session, site, resource, route, {
        ...identifier,
        data: spec.update,
      });
      assert.equal(updated.verification.status, 'verified', 'JCB did not verify the approved update.');
      const saved = (await native(resource, '/' + id)).data;
      if (spec.link) {
        const preserved = field(saved, spec.link.column);
        assert.deepEqual(typeof preserved === 'string' ? JSON.parse(preserved) : preserved, linkedRows);
        detail.steps.push('native sibling update preserved the complete relationship rows');
      }
      assert.ok(
        ownerValues(spec, marker, owned).has(field(saved, spec.owner)),
        'The updated JCB record has a different ownership marker.',
      );
      for (const [name, expected] of Object.entries(spec.update)) {
        const raw = field(saved, name);
        if (typeof expected === 'object') {
          const observed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          assert.deepEqual(observed, expected);
          assert.deepEqual(Object.keys(observed), Object.keys(expected), 'Repeatable row order is significant.');
        } else assert.equal(String(raw), String(expected));
      }
      if (spec.seed) {
        const record = (await read(session, site, resource, 'get', {id})).data.data;
        assert.equal(field(record, 'source'), translationSource);
        assert.equal(field(saved, 'source'), translationSource);
        detail.steps.push('native read independently verified original source and new translation');
      }
      detail.steps.push('verified ' + route + ' and independent numeric read');
      detail.verifiedActions.push(`jcb.api.${resource}.${route}`);
      detail.status = 'awaiting-cleanup';
    } catch (error) {
      detail.status = 'failed';
      detail.phase = phase;
      if (error.fixtureDiagnostic) detail.native = error.fixtureDiagnostic;
      detail.diagnostic = evidenceError(error);
      failures.push(resource + ': ' + phase + ' (' + detail.diagnostic + ')');
    }
  }

  // Descendants go first so an earlier failed assertion never leaves an owned
  // parent in use by a subsequent fixture. No pre-existing row can be mutated.
  for (const spec of attempted.reverse()) {
    const detail = families[spec.resource];
    try {
      await renewIfNeeded();
      const ids = await ownedIds(spec, marker, owned);
      if (owned.has(spec.resource)) ids.add(owned.get(spec.resource).id);
      if (detail.status === 'awaiting-cleanup') assert.equal(ids.size, 1);
      for (const id of ids) {
        const before = await native(spec.resource, '/' + id);
        if (before.status === 404) continue;
        assert.ok(
          ownerValues(spec, marker, owned).has(field(before.data, spec.owner)),
          'Refusing to clean a row without the independently verified fixture ownership field.',
        );
        const state = field(before.data, 'published');
        const deleteByGuid = guidFamilies?.has(spec.resource);
        const guid = field(before.data, 'guid');
        if (deleteByGuid) {
          assert.match(guid, guidPattern);
          assert.equal(String((await native(spec.resource, '/guid/' + guid)).data.id), String(id));
        }
        const identifier = deleteByGuid ? {guid} : {id};
        if (String(state) !== '-2') {
          const patch = deleteByGuid ? 'update.guid' : 'update';
          const trash = await write(session, site, spec.resource, patch, { ...identifier, data: { published: -2 } });
          assert.equal(trash.verification.status, 'verified', 'Native trash transition did not verify.');
          const action = `jcb.api.${spec.resource}.${patch}`;
          if (!detail.verifiedActions.includes(action)) detail.verifiedActions.push(action);
        }
        const removal = deleteByGuid ? 'delete.guid' : 'delete';
        try {
          const removed = await write(session, site, spec.resource, removal, identifier);
          assert.equal(removed.verification.status, 'verified', 'Native removal did not verify.');
        } catch (error) {
          if (!deleteByGuid) throw error;
          // The variant still fails. Use the standard route to remove the row
          // only after independently rechecking its ID, GUID and run ownership.
          const remaining = await native(spec.resource, '/' + id);
          if (remaining.status === 200) {
            assert.equal(field(remaining.data, 'guid'), guid);
            assert.ok(ownerValues(spec, marker, owned).has(field(remaining.data, spec.owner)));
            await write(session, site, spec.resource, 'delete', {id});
          }
          throw error;
        }
        assert.equal((await native(spec.resource, '/' + id)).status, 404, 'Deleted JCB row remains readable.');
        if (deleteByGuid) assert.equal((await native(spec.resource, '/guid/' + guid)).status, 404);
        detail.verifiedActions.push(`jcb.api.${spec.resource}.${removal}`);
      }
      assert.equal((await ownedIds(spec, marker, owned)).size, 0);
      detail.steps.push('verified owned-record cleanup');
      if (detail.status === 'awaiting-cleanup') {
        detail.status = detail.creation === 'verified-mcp-create'
          ? 'verified-lifecycle'
          : 'verified-native-seeded-read-update-delete';
      }
    } catch (error) {
      detail.cleanup = 'failed';
      failures.push(spec.resource + ': cleanup (' + evidenceError(error) + ')');
    }
  }
  const counts = {};
  for (const family of Object.values(families)) counts[family.status] = (counts[family.status] ?? 0) + 1;
  return { families, counts, failures };
}
