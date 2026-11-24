import {getJcbParentBinding, jcbApiActions} from '../../dist/jcb/catalog.js';
import assert from 'node:assert/strict';

// The translation case in jcb-write-fixture independently demonstrates its
// create gate. Every other registered writable family receives a real scenario.
export const familyMatrixBoundaries = {};

function storedRows(raw) {
  if (raw === '' || raw === null) return {};
  const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
  assert.ok(rows && typeof rows === 'object', 'Expected native repeatable rows on the owned association.');
  return rows;
}

const authoringLinks = {
  admins_fields: {
    target: 'fields', column: 'addfields',
    edit(owned, raw) {
      const rows = Object.values(storedRows(raw));
      const field = owned.get('fields').guid;
      assert.ok(rows.every(row => row.field !== field), 'Fresh field was already linked.');
      // Admin_fieldsModel reindexes and sorts by tab, alignment and edit order.
      const row = {field, tab: '1', alignment: 1, order_edit: '1'};
      const order = (left, right) => Number(left.tab) - Number(right.tab)
        || Number(left.alignment) - Number(right.alignment) || Number(left.order_edit) - Number(right.order_edit);
      return [...rows, row].sort(order);
    },
  },
  components_admin_views: {
    target: 'admin_views', column: 'addadmin_views',
    edit(owned, raw) {
      const rows = storedRows(raw);
      const adminview = owned.get('admin_views').guid;
      assert.ok(Object.values(rows).every(row => row.adminview !== adminview), 'Fresh view was already linked.');
      if (Array.isArray(rows) && rows.length) return [...rows, {adminview}];
      let index = 0;
      while (Object.hasOwn(rows, 'addadmin_views' + index)) index++;
      return {...rows, ['addadmin_views' + index]: {adminview}};
    },
  },
};

export function additionalFamilyCases(marker) {
  const description = 'Disposable JCB definition ' + marker;
  const edited = description + ' edited';
  const simple = (resource, owner, data, update) => ({
    resource, owner, data: () => data, update,
  });
  const scenarios = [
    simple('powers', 'system_name', {
      system_name: marker,
      name: 'FixtureDefinition',
      namespace: 'Fixture\\' + marker,
      type: 'class',
      power_version: '1.0.0',
      approved: 0,
    }, {description}),
    {
      resource: 'dynamic_gets',
      owner: 'name',
      dependencies: ['admin_views'],
      data: owned => ({
        name: marker, main_source: '1', gettype: '1',
        view_table_main: owned.get('admin_views').guid, view_selection: 'a.id',
        add_php_router_parse: 0, select_all: 0,
      }),
      update: {select_all: 1},
      relationships: ['view_table_main'],
    },
    ...['custom_admin_views', 'site_views'].map(resource => ({
      resource, owner: 'system_name', dependencies: ['dynamic_gets'],
      data: owned => ({name: marker, system_name: marker, description, main_get: owned.get('dynamic_gets').guid}),
      update: {description: edited},
      relationships: ['main_get'],
    })),
    simple('custom_codes', 'system_name', {
      system_name: marker, function_name: marker, target: 2, comment_type: 1,
      code: '// Fixture-owned definition.',
    }, {comment_type: 2}),
    {
      // The native placeholder model always wraps the target in triple brackets.
      ...simple('placeholders', 'target', {target: '[[[' + marker + ']]]', value: description}, {value: edited}),
      ownerValue: () => '[[[' + marker + ']]]',
    },
    simple('validation_rules', 'name', {
      name: marker, short_description: description, php: 'return true;',
    }, {short_description: edited}),
    simple('fieldtypes', 'name', {
      name: marker, short_description: description, has_defaults: 0,
    }, {short_description: edited}),
    {
      resource: 'fields', owner: 'name', dependencies: ['fieldtypes'],
      data: owned => ({
        name: marker, fieldtype: owned.get('fieldtypes').guid, datatype: 'VARCHAR',
        datalenght: '50', null_switch: 'NULL', store: 0, indexes: 0,
      }),
      update: {datalenght: '100'},
      relationships: ['fieldtype'],
    },
    // Only save local definitions. Nothing connects to a server or repository.
    simple('servers', 'name', {
      name: marker, protocol: 1, signature: 'fixture-only-' + marker,
    }, {published: 0}),
    simple('repositories', 'system_name', {
      system_name: marker, organisation: 'disposable-fixture', repository: marker,
      target: 4, type: 1, access_repo: 0, base: 'https://example.invalid',
    }, {read_branch: 'fixture-read'}),
    // Type 2 is authored help text. Its native conditions hide article (type 1)
    // and URL (type 3); submitting their placeholder defaults misstates the write.
    simple('help_documents', 'title', {
      title: marker, type: 2, location: 1, target: 2, admin_view: 'admin_views',
      content: description,
    }, {content: edited}),
  ];

  // The parent GUID, freshly created and read back by this run, proves ownership
  // even for association tables without a writable name or a GUID item route.
  for (const action of jcbApiActions.filter(action => action.operation === 'create')) {
    const binding = getJcbParentBinding(action.resource);
    if (!binding) continue;
    const {field, resource: parent} = binding;
    const ownParent = owned => owned.get(parent).guid;
    const link = authoringLinks[action.resource];
    scenarios.push({
      resource: action.resource,
      owner: field,
      ownerValue: ownParent,
      dependencies: [parent, ...(link ? [link.target] : [])],
      data: owned => ({[field]: ownParent(owned), published: 1}),
      relationships: [field],
      update: {published: 0},
      ...(link && {link}),
    });
  }
  return scenarios;
}
