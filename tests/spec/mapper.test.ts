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

function resolveFullSpecRoot(): string | undefined {
  const candidates = [
    process.env.JOOMLA_MCP_SPEC,
    '/tmp/work/spec',
    '/tmp/repos/joomla-mcp-spec',
  ];
  return candidates.find((root) => typeof root === 'string' && root.length > 0 && existsSync(join(root, 'catalog/meta.json')));
}

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

  it('maps representative extra families from the fixture (CRUD, users, tags, media)', () => {
    const mapped = mapSpecCatalog(loadSpecCatalog({ specRoot: fixtureRoot, installOverlay: false }));
    expect(mapped.families.map((family) => family.familyId)).toEqual([
      'content.articles',
      'content.categories',
      'media',
      'tags.tags',
      'users.users',
    ]);

    const categories = mapped.crudBases.find((candidate) => candidate.id === 'content.categories');
    expect(categories).toMatchObject({
      domain: 'content',
      resource: 'content-category',
      basePath: 'v1/content/categories',
      controller: 'categories',
      toolset: 'structure.read',
      deleteSemantics: 'resource-model-defined',
    });
    expect(categories?.controllerDefaults).toMatchObject({ component: 'com_categories', extension: 'com_content' });
    expect(mapped.readActions.find((action) => action.id === 'content.categories.list')?.routeTemplate).toBe(
      'v1/content/categories',
    );
    expect(mapped.writeActions.find((action) => action.id === 'content.categories.create')?.inputSchema.required).toEqual([
      'data',
    ]);

    const tags = mapped.crudBases.find((candidate) => candidate.id === 'tags.tags');
    expect(tags).toMatchObject({
      domain: 'tags',
      resource: 'tag',
      basePath: 'v1/tags',
      toolset: 'structure.read',
    });
    expect(mapped.writeActions.find((action) => action.id === 'tags.tags.update')?.routeTemplate).toBe('v1/tags/:id');

    const users = mapped.crudBases.find((candidate) => candidate.id === 'users.users');
    expect(users).toMatchObject({
      domain: 'users',
      resource: 'user',
      basePath: 'v1/users',
      toolset: 'users.read',
      deleteSemantics: 'permanent',
    });
    expect(users?.operations.find((operation) => operation.name === 'create')).toMatchObject({
      deliveryPhase: 6,
      risk: 'write',
    });
    const createUser = mapped.writeActions.find((action) => action.id === 'users.users.create');
    expect(createUser?.toolset).toBe('users.admin');
    const userData = createUser?.inputSchema.properties['data']?.['properties'] as Readonly<Record<string, unknown>>;
    expect(Object.keys(userData ?? {})).toEqual(expect.arrayContaining(['username', 'email', 'password', 'password2']));

    const media = mapped.crudBases.find((candidate) => candidate.id === 'media');
    expect(media).toMatchObject({
      domain: 'media',
      basePath: 'v1/media',
      toolset: 'media.read',
      deleteSemantics: 'permanent',
    });
    expect(media?.source.registration).toBe('Route');
    const adapters = mapped.readActions.find((action) => action.id === 'media.adapters.list');
    expect(adapters).toMatchObject({
      method: 'GET',
      paginated: true,
      routeTemplate: 'v1/media/adapters',
      toolset: 'media.read',
    });
    expect(mapped.readActions.find((action) => action.id === 'media.adapters.get')?.routeTemplate).toBe(
      'v1/media/adapters/:adapter',
    );
    expect(mapped.writeActions.find((action) => action.id === 'media.files.create')?.method).toBe('POST');
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
    const fullSpecRoot = resolveFullSpecRoot();
    if (fullSpecRoot === undefined) {
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
