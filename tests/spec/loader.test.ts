import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SpecCatalogError, loadSpecCatalog, resolveSpecRoot } from '../../src/catalog/spec/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/joomla-mcp-spec');

describe('joomla-mcp-spec loader', () => {
  it('loads the fixture catalogue fail-closed and freezes family documents', () => {
    const loaded = loadSpecCatalog({ specRoot: fixtureRoot });

    expect(loaded.specRoot).toBe(fixtureRoot);
    expect(loaded.meta).toMatchObject({
      name: 'joomla-mcp-spec',
      specVersion: '0.3.0',
      extractedFamilies: ['content.articles', 'content.categories', 'tags.tags', 'users.users', 'media'],
    });
    expect(loaded.meta.consumers).toContain('joomengine/joomla-mcp-ts');
    expect(loaded.meta.examinedHeads['6.1-dev']).toMatch(/^[a-f0-9]{40}$/);
    expect(loaded.toolsets.toolsets.some((entry) => entry.id === 'content.read' && entry.write === false)).toBe(true);
    expect(loaded.toolsets.toolsets.some((entry) => entry.id === 'content.write' && entry.write === true)).toBe(true);
    expect(loaded.writeFields.bases['content.articles']?.fields).toContain('articletext');
    expect(loaded.families.map((family) => family.document.base.id)).toEqual([
      'content.articles',
      'content.categories',
      'media',
      'tags.tags',
      'users.users',
    ]);
    expect(loaded.families.find((family) => family.document.base.id === 'content.articles')?.document.actions.map((action) => action.operation)).toEqual([
      'list', 'get', 'create', 'update', 'delete',
    ]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.families[0]?.document.base)).toBe(true);
    expect(loaded.publicTools?.tools.map((tool) => tool.name)).toContain('joomla_action_read');
  });

  it('resolves a relative spec root against process.cwd', () => {
    expect(resolveSpecRoot({ specRoot: 'tests/fixtures/joomla-mcp-spec' })).toBe(fixtureRoot);
  });

  it('rejects an unset spec root instead of silently falling back', () => {
    expect(() => loadSpecCatalog({})).toThrow(SpecCatalogError);
    try {
      loadSpecCatalog({});
    } catch (error) {
      expect(error).toMatchObject({ code: 'spec-root-unset' });
    }
  });

  it('rejects a missing spec root directory', () => {
    expect(() => loadSpecCatalog({ specRoot: join(fixtureRoot, 'does-not-exist') })).toThrow(/does not exist/);
  });
});
