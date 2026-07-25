import { describe, expect, it } from 'vitest';

import {
  completeJoomlaApiPatchBody,
  findJoomlaReadActions,
  getJoomlaReadAction,
  getJoomlaWriteAction,
  joomlaCrudReadActions,
  joomlaCrudWriteActions,
  joomlaReadActions,
  joomlaWriteActions,
  requiresJoomlaApiPatchCompletion,
  resolveJoomlaReadRequest,
  resolveJoomlaWriteRequest,
} from '../src/catalog/action-catalog.js';
import { apiCrudBases } from '../src/catalog/core.js';
import { joomlaCrudBases } from '../src/catalog/crud-bases.js';
import { crudWriteFieldsByBaseId } from '../src/catalog/crud-write-fields.js';
import { joomlaSpecialReadActions } from '../src/catalog/special-reads.js';
import { versionSupportFor } from '../src/catalog/source-metadata.js';

describe('Joomla source-backed action catalogue', () => {
  it('describes every Joomla 6.1 CRUD base exactly once', () => {
    expect(joomlaCrudBases).toHaveLength(36);
    expect(new Set(joomlaCrudBases.map((base) => base.id)).size).toBe(36);
    expect(joomlaCrudBases.map((base) => base.basePath).sort()).toEqual([...apiCrudBases].sort());
  });

  it('records all five generated CRUD operations with gated mutation phases', () => {
    for (const base of joomlaCrudBases) {
      expect(base.operations.map(({ name, method, route }) => ({ name, method, route }))).toEqual([
        { name: 'list', method: 'GET', route: 'collection' },
        { name: 'get', method: 'GET', route: 'item' },
        { name: 'create', method: 'POST', route: 'collection' },
        { name: 'update', method: 'PATCH', route: 'item' },
        { name: 'delete', method: 'DELETE', route: 'item' },
      ]);
      expect(base.operations[0]?.deliveryPhase).toBe(2);
      expect(base.operations[1]?.deliveryPhase).toBe(2);
      expect([4, 6]).toContain(base.operations[2]?.deliveryPhase);
      expect(base.acl.apiLogin).toBe('core.login.api');
      expect(base.acl.enforcement).toBe('joomla-controller');
      expect(base.driver.kind).toBe('joomla-api');
      expect(base.driver.authentication).toBe('joomla-api-token');
      expect(base.source.commit).toBe('071afb7ad305c02983a653ccfc301b5c8360264b');
      expect(base.source.registration).toBe('createCRUDRoutes');
      expect(base.versions).toMatchObject({ baseline: '6.1-dev', compatible: '6.2-dev', canary: '7.0-dev' });
    }
  });

  it('derives two Phase 2 read actions per CRUD base and adds explicit special reads', () => {
    expect(joomlaCrudReadActions).toHaveLength(72);
    expect(joomlaSpecialReadActions).toHaveLength(29);
    expect(joomlaReadActions).toHaveLength(101);
    expect(new Set(joomlaReadActions.map((action) => action.id)).size).toBe(joomlaReadActions.length);

    for (const action of joomlaReadActions) {
      expect(action.method).toBe('GET');
      expect(action.routeTemplate).toMatch(/^v1\//);
      expect(action.inputSchema.additionalProperties).toBe(false);
      expect(action.source.repository).toBe('joomla/joomla-cms');
    }
  });

  it('derives three controlled write actions per CRUD base with risk-specific toolsets', () => {
    expect(joomlaCrudWriteActions).toHaveLength(108);
    expect(Object.keys(crudWriteFieldsByBaseId).sort()).toEqual(joomlaCrudBases.map((base) => base.id).sort());
    expect(getJoomlaWriteAction('content.articles.create')).toMatchObject({
      method: 'POST', routeTemplate: 'v1/content/articles', toolset: 'content.write', risk: 'write',
    });
    expect(getJoomlaWriteAction('banners.banners.update')).toMatchObject({
      method: 'PATCH', routeTemplate: 'v1/banners/:id', toolset: 'content.write', risk: 'write',
    });
    expect(getJoomlaWriteAction('users.users.delete')).toMatchObject({
      method: 'DELETE', routeTemplate: 'v1/users/:id', toolset: 'users.admin', risk: 'destructive',
    });
    expect(getJoomlaWriteAction('menus.site-items.create')?.toolset).toBe('structure.write');
    for (const action of joomlaCrudWriteActions.filter((candidate) => candidate.operation !== 'delete')) {
      expect(action.inputSchema.properties['data']).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(Object.keys(
        action.inputSchema.properties['data']?.['properties'] as Readonly<Record<string, unknown>>,
      ).length).toBeGreaterThan(0);
    }
  });

  it('catalogues every reviewed special write, including the separate Joomla Update lifecycle', () => {
    expect(joomlaWriteActions).toHaveLength(135);
    expect(getJoomlaWriteAction('content.article-history.keep')).toMatchObject({ method: 'PATCH', toolset: 'content.write' });
    expect(getJoomlaWriteAction('contacts.form.submit')?.routeTemplate).toBe('v1/contacts/form/:id');
    expect(getJoomlaWriteAction('media.files.delete')).toMatchObject({ method: 'DELETE', toolset: 'media.write' });
    expect(getJoomlaWriteAction('configuration.application.update')?.toolset).toBe('configuration.write');
    expect(getJoomlaWriteAction('plugins.plugins.update')?.toolset).toBe('extensions.admin');
    expect(getJoomlaWriteAction('privacy.requests.create')?.toolset).toBe('users.admin');
    expect(getJoomlaWriteAction('languages.packages.install')?.toolset).toBe('extensions.admin');
    expect(getJoomlaWriteAction('languages.overrides.administrator.update')?.routeTemplate)
      .toBe('v1/languages/overrides/administrator/:language/:constant');
    expect(getJoomlaWriteAction('joomla-update.prepare')).toMatchObject({
      method: 'POST',
      routeTemplate: 'v1/joomlaupdate/prepareUpdate',
      bodyPolicy: 'required',
      toolset: 'core-update',
      driver: { authentication: 'joomla-update-token', responseShape: 'joomla-json' },
    });
    expect(getJoomlaWriteAction('joomla-update.finalize')?.routeTemplate)
      .toBe('v1/joomlaupdate/finalizeUpdate');
    expect(getJoomlaWriteAction('joomla-update.notification.success')?.routeTemplate)
      .toBe('v1/joomlaupdate/notificationSuccess');
    expect(getJoomlaWriteAction('joomla-update.notification.failed')?.routeTemplate)
      .toBe('v1/joomlaupdate/notificationFailed');
  });

  it('retains source controller defaults needed to distinguish shared controllers', () => {
    expect(joomlaCrudBases.find((base) => base.id === 'menus.site')?.controllerDefaults).toEqual({
      component: 'com_menus',
      client_id: 0,
    });
    expect(joomlaCrudBases.find((base) => base.id === 'menus.administrator')?.controllerDefaults).toEqual({
      component: 'com_menus',
      client_id: 1,
    });
    expect(joomlaCrudBases.find((base) => base.id === 'fields.contact-mail')?.controllerDefaults).toEqual({
      component: 'com_fields',
      context: 'com_contact.mail',
    });
  });

  it('injects fixed route defaults into write bodies without exposing them to callers', () => {
    expect(resolveJoomlaWriteRequest('menus.administrator.create', {
      data: {
        menutype: 'jmcp-admin',
        title: 'Joomla MCP administrator menu',
        description: '',
      },
    })).toMatchObject({
      method: 'POST',
      path: 'v1/menus/administrator',
      body: {
        menutype: 'jmcp-admin',
        title: 'Joomla MCP administrator menu',
        client_id: 1,
      },
    });
    expect(resolveJoomlaWriteRequest('fields.contact-mail.create', {
      data: {
        group_id: 1,
        title: 'Mail field',
        name: 'mail_field',
        label: 'Mail field',
        type: 'text',
      },
    })).toMatchObject({
      body: {
        context: 'com_contact.mail',
      },
    });
  });

  it('carries fixed Joomla controller context into reads and derives native form fields', () => {
    expect(resolveJoomlaReadRequest('menus.site.list', { offset: 0, limit: 10 }).query).toEqual({
      'page[offset]': 0,
      'page[limit]': 10,
    });
    expect(resolveJoomlaReadRequest('menus.administrator.list', { offset: 0, limit: 10 }).query).toEqual({
      'page[offset]': 0,
      'page[limit]': 10,
      client_id: 1,
    });
    expect(() => resolveJoomlaReadRequest('menus.administrator.list', {
      offset: 0,
      limit: 10,
      client_id: 0,
    })).toThrow('Unsupported action input properties');

    expect(resolveJoomlaWriteRequest('menus.site-items.create', {
      data: {
        menutype: 'jmcp-site',
        title: 'Joomla MCP article',
        alias: 'jmcp-article',
        type: 'component',
        link: 'index.php?option=com_content&view=article&id=42',
      },
    }).body).toMatchObject({
      client_id: 0,
      request: {
        option: 'com_content',
        view: 'article',
        id: '42',
      },
    });

    expect(resolveJoomlaWriteRequest('modules.site.create', {
      data: {
        title: 'Joomla MCP module',
        module: 'mod_custom',
        assigned: [41, 42],
      },
    }).body).toMatchObject({
      client_id: 0,
      assigned: [41, 42],
      assignment: 1,
    });

    expect(completeJoomlaApiPatchBody(
      'menus.site-items.update',
      {
        menutype: 'jmcp-site',
        type: 'component',
        parent_id: 1,
        link: 'index.php?option=com_content&view=article&id=42',
        params: { option: 'com_content', view: 'article', id: '42' },
      },
      { title: 'Updated title' },
    )).toMatchObject({
      title: 'Updated title',
      client_id: 0,
      request: { option: 'com_content', view: 'article', id: '42' },
    });

    expect(completeJoomlaApiPatchBody(
      'modules.site.update',
      { params: { layout: '_:default' }, assigned: [41, 42] },
      { published: 0 },
    )).toMatchObject({
      published: 0,
      params: { layout: '_:default' },
      assigned: [41, 42],
      assignment: 1,
      client_id: 0,
    });
    expect(requiresJoomlaApiPatchCompletion('modules.site.update')).toBe(true);
    expect(requiresJoomlaApiPatchCompletion('banners.banners.update')).toBe(false);
  });

  it('catalogues the special read surfaces that cannot be generated as ordinary CRUD', () => {
    const ids = new Set(joomlaSpecialReadActions.map((action) => action.id));

    expect(ids.size).toBe(29);
    expect(ids.has('media.directory.list')).toBe(true);
    expect(ids.has('languages.overrides.site.get')).toBe(true);
    expect(ids.has('privacy.requests.export')).toBe(true);
    expect(ids.has('configuration.component.get')).toBe(true);
    expect(ids.has('content.article-history.list')).toBe(true);
    expect(ids.has('joomla-update.healthcheck')).toBe(true);

    const update = getJoomlaReadAction('joomla-update.status');
    expect(update?.driver.authentication).toBe('joomla-update-token');
    expect(update?.acl.apiLogin).toBe('not-used');
    expect(getJoomlaReadAction('joomla-update.healthcheck')?.sideEffect).toBe(true);
  });

  it('filters catalogue discovery by authorized toolset and hides sensitive reads by default', () => {
    const media = findJoomlaReadActions({ toolsets: new Set(['media.read']), text: 'media' });
    expect(media.length).toBeGreaterThanOrEqual(5);
    expect(media.every((action) => action.toolset === 'media.read')).toBe(true);

    expect(findJoomlaReadActions({ domain: 'privacy' })).toHaveLength(0);
    expect(findJoomlaReadActions({ domain: 'privacy', includeSensitive: true })).toHaveLength(5);
    expect(findJoomlaReadActions({ text: 'application configuration', includeSensitive: true }).map((action) => action.id))
      .toContain('configuration.application.get');
  });

  it('applies the explicit 6.x production and Joomla 7 canary policy', () => {
    expect(joomlaReadActions[0]?.versions.examinedHeads).toEqual({
      '6.1-dev': '071afb7ad305c02983a653ccfc301b5c8360264b',
      '6.2-dev': 'df0e57da1cf3febfd8d4da0c522b87f3d5c6aec5',
      '7.0-dev': 'b3a08ce4cbca0c77ff34c9b1abe1c431536dbb3f',
    });
    expect(versionSupportFor('6.1.3')).toBe('supported');
    expect(versionSupportFor('6.2.0-alpha4')).toBe('supported');
    expect(versionSupportFor('7.0.0-alpha1')).toBe('canary');
    expect(versionSupportFor('6.0.9')).toBe('unsupported');
    expect(versionSupportFor('7.1.0')).toBe('unsupported');
    expect(versionSupportFor('not-a-version')).toBe('unsupported');
  });
});
