import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SpecCatalogError, loadSpecCatalog } from '../../src/catalog/spec/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/joomla-mcp-spec');
const requiredFiles = [
  'catalog/meta.json',
  'catalog/toolsets.json',
  'catalog/write-fields.json',
  'catalog/actions/content.articles.json',
  'catalog/actions/content.categories.json',
  'catalog/actions/media.json',
  'catalog/actions/tags.tags.json',
  'catalog/actions/users.users.json',
] as const;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('joomla-mcp-spec fail-closed loading', () => {
  it.each(requiredFiles)('fails closed when %s is missing', (relativePath) => {
    const root = cloneFixture();
    rmSync(join(root, relativePath), { force: true, recursive: true });
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(SpecCatalogError);
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/missing|unreadable|not a directory|incomplete|no family documents/i);
  });

  it('fails closed when meta.json is not JSON', () => {
    const root = cloneFixture();
    writeFileSync(join(root, 'catalog/meta.json'), '{not-json');
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/not valid JSON/);
  });

  it('fails closed when extractedFamilies lists a family file that does not exist', () => {
    const root = cloneFixture();
    const meta = JSON.parse(readFileSync(join(root, 'catalog/meta.json'), 'utf8')) as {
      extractedFamilies: string[];
    };
    meta.extractedFamilies = ['content.articles', 'content.categories', 'banners.banners'];
    writeFileSync(join(root, 'catalog/meta.json'), JSON.stringify(meta, null, 2));
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/banners\.banners\.json/);
  });

  it('fails closed when a family has no actions', () => {
    const root = cloneFixture();
    const family = JSON.parse(readFileSync(join(root, 'catalog/actions/content.articles.json'), 'utf8')) as {
      actions: unknown[];
    };
    family.actions = [];
    writeFileSync(join(root, 'catalog/actions/content.articles.json'), JSON.stringify(family, null, 2));
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/actions must be a non-empty array/);
  });

  it('fails closed when writeFields drift from catalog/write-fields.json', () => {
    const root = cloneFixture();
    const family = JSON.parse(readFileSync(join(root, 'catalog/actions/content.articles.json'), 'utf8')) as {
      actions: Array<{ operation: string; writeFields?: string[] }>;
    };
    const create = family.actions.find((action) => action.operation === 'create');
    create?.writeFields?.push('not_a_reviewed_field');
    writeFileSync(join(root, 'catalog/actions/content.articles.json'), JSON.stringify(family, null, 2));
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/not_a_reviewed_field/);
  });

  it('fails closed when an action toolset is not in catalog/toolsets.json', () => {
    const root = cloneFixture();
    const family = JSON.parse(readFileSync(join(root, 'catalog/actions/content.articles.json'), 'utf8')) as {
      actions: Array<{ toolset: string }>;
    };
    const list = family.actions[0];
    if (list) list.toolset = 'not-a-toolset';
    writeFileSync(join(root, 'catalog/actions/content.articles.json'), JSON.stringify(family, null, 2));
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/not declared in catalog\/toolsets\.json/);
  });

  it('fails closed when additionalProperties is not false on an input schema', () => {
    const root = cloneFixture();
    const family = JSON.parse(readFileSync(join(root, 'catalog/actions/content.articles.json'), 'utf8')) as {
      actions: Array<{ inputSchema: { additionalProperties: boolean } }>;
    };
    const list = family.actions[0];
    if (list) list.inputSchema.additionalProperties = true;
    writeFileSync(join(root, 'catalog/actions/content.articles.json'), JSON.stringify(family, null, 2));
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/additionalProperties must be false/);
  });

  it('fails closed when catalog/actions contains no family documents', () => {
    const root = cloneFixture();
    for (const entry of readdirSync(join(root, 'catalog/actions'))) {
      rmSync(join(root, 'catalog/actions', entry), { force: true, recursive: true });
    }
    expect(() => loadSpecCatalog({ specRoot: root })).toThrow(/no family documents|missing/);
  });
});

function cloneFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'joomla-mcp-spec-'));
  tempDirs.push(root);
  copyTree(fixtureRoot, root);
  return root;
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) {
      copyTree(source, target);
    } else {
      copyFileSync(source, target);
    }
  }
}
