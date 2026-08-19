import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  convertSpecRouteTemplate,
  loadSpecCatalog,
  mapSpecCatalog,
  mapSpecListQueryFilters,
  queryKeyForFilter,
} from '../../src/catalog/spec/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/joomla-mcp-spec');
const fullSpecRoot = '/tmp/repos/joomla-mcp-spec';

describe('joomla-mcp-spec mapper', () => {
  it('maps the content.articles family into the TypeScript catalogue shape', () => {
    const mapped = mapSpecCatalog(loadSpecCatalog({ specRoot: fixtureRoot, installOverlay: false }));
    const base = mapped.crudBases.find((candidate) => candidate.id === 'content.articles');
    const list = mapped.readActions.find((action) => action.id === 'content.articles.list');
    const get = mapped.readActions.find((action) => action.id === 'content.articles.get');
    const create = mapped.writeActions.find((action) => action.id === 'content.articles.create');
    const update = mapped.writeActions.find((action) => action.id === 'content.articles.update');
    const remove = mapped.writeActions.find((action) => action.id === 'content.articles.delete');

    expect(base).toMatchObject({
      id: 'content.articles',
      domain: 'content',
      resource: 'article',
      collectionName: 'Articles',
      itemName: 'Article',
      basePath: 'v1/content/articles',
      controller: 'articles',
      toolset: 'content.read',
      deleteSemantics: 'resource-model-defined',
    });
    expect(base?.controllerDefaults).toMatchObject({ component: 'com_content' });
    expect(base?.driver).toMatchObject({
      kind: 'joomla-api',
      transport: 'https',
      authentication: 'joomla-api-token',
      plugin: 'webservices/content',
      mutationBody: 'flat-joomla-form-json',
    });
    expect(base?.source).toMatchObject({
      repository: 'joomla/joomla-cms',
      branch: '6.1-dev',
      registration: 'createCRUDRoutes',
    });
    expect(base?.acl.component).toBe('com_content');
    expect(base?.versions.examinedHeads['6.1-dev']).toBe('071afb7ad305c02983a653ccfc301b5c8360264b');

    expect(list).toMatchObject({
      method: 'GET',
      paginated: true,
      sideEffect: false,
      toolset: 'content.read',
      risk: 'read',
      routeTemplate: 'v1/content/articles',
    });
    expect(list?.inputSchema.additionalProperties).toBe(false);
    expect(list?.inputSchema.properties['search']).toMatchObject({ type: 'string' });
    expect(list?.inputSchema.properties['offset']).toMatchObject({ type: 'integer' });

    expect(get).toMatchObject({
      method: 'GET',
      paginated: false,
      routeTemplate: 'v1/content/articles/:id',
      toolset: 'content.read',
    });
    expect(get?.routeParameters).toEqual([
      expect.objectContaining({ name: 'id', kind: 'positive-integer', required: true }),
    ]);

    expect(create).toMatchObject({
      method: 'POST',
      bodyPolicy: 'required',
      toolset: 'content.write',
      risk: 'write',
      routeTemplate: 'v1/content/articles',
    });
    expect(create?.inputSchema.required).toEqual(['data']);
    expect(create?.inputSchema.properties['data']).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    const createFields = create?.inputSchema.properties['data']?.['properties'] as Readonly<Record<string, unknown>>;
    expect(Object.keys(createFields ?? {})).toEqual(expect.arrayContaining(['title', 'catid', 'articletext', 'tags']));

    expect(update).toMatchObject({
      method: 'PATCH',
      routeTemplate: 'v1/content/articles/:id',
      risk: 'write',
    });
    expect(update?.inputSchema.required).toEqual(['id', 'data']);
    expect(update?.inputSchema.properties['etag']).toMatchObject({ type: 'string' });

    expect(remove).toMatchObject({
      method: 'DELETE',
      bodyPolicy: 'none',
      risk: 'destructive',
      routeTemplate: 'v1/content/articles/:id',
    });
    expect(remove?.inputSchema.properties['data']).toBeUndefined();
    expect(mapped.writeFieldsByBaseId['content.articles']).toContain('featured');
    expect(mapped.sourceOnlyGates['configuration.component.get']).toMatch(/component configuration/i);
  });

  it('converts spec {id} placeholders into the runtime :id route form', () => {
    expect(convertSpecRouteTemplate('v1/content/articles/{id}')).toBe('v1/content/articles/:id');
    expect(convertSpecRouteTemplate('v1/content/articles')).toBe('v1/content/articles');
  });

  it('maps spec list filters onto Joomla query keys', () => {
    expect(queryKeyForFilter('search')).toBe('filter[search]');
    expect(queryKeyForFilter('ordering')).toBe('list[ordering]');
    expect(queryKeyForFilter('unknown_field')).toBe('filter[unknown_field]');
    expect(mapSpecListQueryFilters(
      { offset: 0, limit: 20, search: 'hello', featured: true, category: 4 },
      {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
        search: { type: 'string' },
        featured: { type: 'boolean' },
        category: { type: 'integer' },
      },
      new Set(),
    )).toEqual({
      'filter[search]': 'hello',
      'filter[featured]': 1,
      'filter[category]': 4,
    });
  });

  it('maps every extracted family from the canonical spec checkout when present', () => {
    if (!existsSync(join(fullSpecRoot, 'catalog/meta.json'))) {
      return;
    }

    const loaded = loadSpecCatalog({ specRoot: fullSpecRoot, installOverlay: false });
    const mapped = mapSpecCatalog(loaded);
    expect(mapped.families.length).toBe(loaded.meta.extractedFamilies.length);
    expect(mapped.actions.length).toBeGreaterThan(loaded.meta.extractedFamilies.length);
    expect(new Set(mapped.actions.map((action) => action.id)).size).toBe(mapped.actions.length);
    for (const family of mapped.families) {
      expect(family.base.basePath.startsWith('v1/')).toBe(true);
      expect(family.readActions.length + family.writeActions.length).toBeGreaterThan(0);
      expect(family.base.source.repository).toBe('joomla/joomla-cms');
      expect(family.base.driver.kind).toBe('joomla-api');
    }
    expect(mapped.readActions.some((action) => action.id === 'content.articles.list')).toBe(true);
    expect(mapped.writeActions.some((action) => action.id === 'content.articles.create')).toBe(true);
    expect(mapped.readActions.some((action) => action.id === 'media.adapters.list')).toBe(true);
  });
});
