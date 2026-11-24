import { describe, expect, it } from 'vitest';

import { describeJcbApiAction, getJcbApiAction, getJcbParentBinding, jcbApiActions } from '../src/jcb/catalog.js';

describe('JCB registered API contracts', () => {
  it('accounts for each registration and preserves every declared item identifier', () => {
    const counts = Object.fromEntries(['GET', 'POST', 'PATCH', 'DELETE'].map(method =>
      [method, jcbApiActions.filter(action => action.method === method).length]));
    expect(counts).toEqual({GET: 125, POST: 51, PATCH: 72, DELETE: 72});
    expect(new Set(jcbApiActions.map(action => action.method + ' ' + action.path)).size).toBe(320);
    expect(new Set(jcbApiActions.map(action => action.resource)).size).toBe(53);
    expect(jcbApiActions.filter(action => action.identifier === 'guid')).toHaveLength(63);
    for (const action of jcbApiActions) {
      expect(getJcbApiAction(action.id)).toBe(action);
      if (action.method !== 'GET') {
        const getId = 'jcb.api.' + action.resource + '.get' + (action.identifier === 'guid' ? '.guid' : '');
        expect(getJcbApiAction(getId)?.identifier).toBe(action.identifier ?? 'id');
      }
    }
    expect(getJcbApiAction('jcb.api.languages.get.guid')).toBeUndefined();
  });

  it('keeps the two dynamic lists read-only and preserves native list filters', () => {
    for (const resource of ['compiler', 'extrusion']) {
      expect(jcbApiActions.filter(action => action.resource === resource)).toHaveLength(1);
      expect(getJcbApiAction('jcb.api.' + resource + '.list')).toMatchObject({
        paginated: false, filters: [], ordering: [], toolset: 'jcb.read',
      });
    }
    const list = getJcbApiAction('jcb.api.joomla_components.list')!;
    expect(list.filters).toEqual(['search', 'published', 'access', 'companyname', 'author']);
    expect(list.ordering).toContain('system_name');
  });

  it('binds association creates only to the read-only native selector and a registered parent GUID route', () => {
    const associations = jcbApiActions.filter(action => action.operation === 'create' && getJcbParentBinding(action.resource));
    expect(associations).toHaveLength(23);
    for (const action of associations) {
      const parent = getJcbParentBinding(action.resource)!;
      expect(action.fields[parent.field]).toMatchObject({readonly: true, disabled: false});
      expect(getJcbApiAction('jcb.api.' + parent.resource + '.get.guid')?.identifier).toBe('guid');
    }
    expect(getJcbParentBinding('language_translations')).toBeUndefined();
    expect(getJcbParentBinding('components_unregistered')).toBeUndefined();
  });

  it('binds form metadata to the registered resource, including nested rows and native conditions', () => {
    const create = getJcbApiAction('jcb.api.joomla_modules.create')!;
    expect(create.fields.add_class_helper?.integerStorage).toBe(true);
    expect(create.fields.module_version?.integerStorage).toBeUndefined();
    expect(getJcbApiAction('jcb.api.libraries.get')?.fields.how?.integerStorage).toBe(true);
    expect(getJcbApiAction('jcb.api.help_documents.get')?.fields.article?.integerStorage).toBe(true);
    const adminView = getJcbApiAction('jcb.api.admin_views.create')!;
    expect(adminView.formPluginDefaults?.privacy).toEqual({activate: '0', permissions: '1', anonymize: '0', user_link: '1'});
    expect(adminView.source.formPlugins).toHaveLength(3);
    expect(adminView.fields.params).toBeUndefined();
    expect(getJcbApiAction('jcb.api.admin_views.update')?.formPluginDefaults).toBeUndefined();
    expect(create.fields.fields).toMatchObject({
      type: 'subform', multiple: true, fields: {fields: {type: 'subform', multiple: true}},
    });
    const component = getJcbApiAction('jcb.api.joomla_components.update.guid')!;
    expect(component.fields.metadata).toMatchObject({type: 'group', fields: {robots: {type: 'list'}}});
    expect(component.fields.jcb_powers_path?.showon).toBe('add_jcb_powers_path:1');
    expect(component.conditionGroups.some(group => group.targets.includes('buildcompsql'))).toBe(true);
    expect(component.fields.guid).toMatchObject({readonly: true, serverGenerated: true});
    expect(getJcbApiAction('jcb.api.powers.update')?.fields.approved_paths).toMatchObject({
      type: 'superpowerpaths', multiple: true, dynamicOptions: true,
    });
    expect(Object.isFrozen(component.fields.guid)).toBe(true);
    const language = getJcbApiAction('jcb.api.language_translations.create')!;
    expect(language.sourceCreateDisabled).toBe(true);
    expect(language.fields.source).toMatchObject({readonly: true, disabled: true});
    expect(describeJcbApiAction(language)).toHaveProperty('inputSchema.properties.data');
  });
});
