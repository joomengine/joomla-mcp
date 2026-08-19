import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findJoomlaReadActions,
  getJoomlaCrudBase,
  getJoomlaReadAction,
  getJoomlaWriteAction,
  joomlaReadActions,
  resolveJoomlaReadRequest,
  resolveJoomlaWriteRequest,
} from '../../src/catalog/action-catalog.js';
import { publicCatalog } from '../../src/catalog/core.js';
import {
  configureSpecCatalog,
  isSpecCatalogActive,
  resetSpecCatalog,
  specCatalogProvenance,
} from '../../src/catalog/spec/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/joomla-mcp-spec');

afterEach(() => {
  resetSpecCatalog();
});

describe('joomla-mcp-spec catalogue overlay', () => {
  it('keeps the in-repo catalogue when no spec root is configured', () => {
    const resolved = configureSpecCatalog({});
    expect(resolved.provenance).toEqual({ consumed: false, fallback: 'in-repo' });
    expect(isSpecCatalogActive()).toBe(false);
    expect(getJoomlaReadAction('content.articles.list')?.title).toBe(
      joomlaReadActions.find((action) => action.id === 'content.articles.list')?.title,
    );
    expect(publicCatalog()['spec']).toMatchObject({ consumed: false, fallback: 'in-repo' });
  });

  it('prefers spec-backed descriptors for overlapping action ids', () => {
    const resolved = configureSpecCatalog({ specRoot: fixtureRoot });
    expect(resolved.provenance.consumed).toBe(true);
    expect(resolved.provenance.specVersion).toBe('0.3.0');
    expect(isSpecCatalogActive()).toBe(true);

    const list = getJoomlaReadAction('content.articles.list');
    expect(list?.title).toBe('List Joomla articles');
    expect(list?.inputSchema.properties['search']).toMatchObject({ type: 'string' });
    expect(getJoomlaWriteAction('content.articles.create')?.title).toBe('Create a Joomla article');
    expect(getJoomlaCrudBase('content.articles')?.source.path).toContain('webservices/content');

    const inRepoOnly = getJoomlaReadAction('media.files.list') ?? getJoomlaReadAction('extensions.extensions.list');
    expect(inRepoOnly === undefined || inRepoOnly.method === 'GET').toBe(true);
    expect(findJoomlaReadActions({ domain: 'content' }).some((action) => action.id === 'content.articles.list')).toBe(true);
    expect(specCatalogProvenance()).toMatchObject({
      consumed: true,
      fallback: 'spec-overlay',
      extractedFamilies: ['content.articles', 'content.categories', 'tags.tags', 'users.users', 'media'],
    });
    expect(getJoomlaReadAction('media.adapters.list')?.title).toBe('List media adapters');
    expect(getJoomlaCrudBase('users.users')?.toolset).toBe('users.read');
    expect(publicCatalog()['spec']).toMatchObject({ consumed: true, specVersion: '0.3.0' });
  });

  it('resolves spec list filters through the existing read request helper', () => {
    configureSpecCatalog({ specRoot: fixtureRoot });
    expect(resolveJoomlaReadRequest('content.articles.list', {
      offset: 10,
      limit: 5,
      search: 'hello',
      featured: true,
      category: 7,
    })).toEqual({
      method: 'GET',
      path: 'v1/content/articles',
      query: {
        'page[offset]': 10,
        'page[limit]': 5,
        'filter[search]': 'hello',
        'filter[featured]': 1,
        'filter[category]': 7,
      },
    });
  });

  it('keeps write execution on the nested data body expected by the runtime', () => {
    configureSpecCatalog({ specRoot: fixtureRoot });
    expect(resolveJoomlaWriteRequest('content.articles.create', {
      data: { title: 'Hello', catid: 2 },
    })).toEqual({
      method: 'POST',
      path: 'v1/content/articles',
      body: { title: 'Hello', catid: 2 },
    });
  });

  it('still rejects undeclared read inputs', () => {
    configureSpecCatalog({ specRoot: fixtureRoot });
    expect(() => resolveJoomlaReadRequest('content.articles.list', { offset: 0, limit: 5, bogus: 'nope' }))
      .toThrow(/Unsupported action input properties: bogus/);
  });
});
