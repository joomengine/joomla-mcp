import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  IMPLEMENTATION_MCP_TOOLS,
  REQUIRED_PUBLIC_MCP_TOOLS,
  SpecCatalogError,
  assertImplementationExposesPublicTools,
  extraImplementationTools,
  loadPublicToolsContract,
  missingPublicTools,
  summarizePublicTools,
} from '../../src/catalog/spec/index.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/joomla-mcp-spec');

describe('joomla-mcp-spec public MCP tools contract', () => {
  it('loads contracts/mcp-public-tools.json from the spec fixture', () => {
    const document = loadPublicToolsContract(fixtureRoot);
    expect(document.tools.map((tool) => tool.name)).toEqual([...REQUIRED_PUBLIC_MCP_TOOLS]);
    expect(document.tools.filter((tool) => tool.write).map((tool) => tool.name)).toEqual([
      'joomla_action_write_plan',
      'joomla_write_apply',
    ]);
    expect(document.tools.filter((tool) => tool.category === 'security')).toHaveLength(4);
    expect(summarizePublicTools(document)).toMatchObject({
      count: REQUIRED_PUBLIC_MCP_TOOLS.length,
      write: 2,
      read: REQUIRED_PUBLIC_MCP_TOOLS.length - 2,
    });
  });

  it('requires this implementation to expose every contract tool', () => {
    const document = loadPublicToolsContract(fixtureRoot);
    expect(missingPublicTools(IMPLEMENTATION_MCP_TOOLS, document)).toEqual([]);
    expect(() => assertImplementationExposesPublicTools(IMPLEMENTATION_MCP_TOOLS, document)).not.toThrow();
    const wrappers = extraImplementationTools(IMPLEMENTATION_MCP_TOOLS, document);
    expect(wrappers).toEqual(expect.arrayContaining([
      'joomla_content_articles_list',
      'joomla_content_article_get',
      'joomla_content_article_create_plan',
    ]));
  });

  it('fails closed when a required public tool is omitted from the implementation list', () => {
    const document = loadPublicToolsContract(fixtureRoot);
    const incomplete = IMPLEMENTATION_MCP_TOOLS.filter((name) => name !== 'joomla_write_apply');
    expect(missingPublicTools(incomplete, document)).toEqual(['joomla_write_apply']);
    expect(() => assertImplementationExposesPublicTools(incomplete, document)).toThrow(SpecCatalogError);
  });

  it('fails closed when the public tools contract file is missing', () => {
    expect(() => loadPublicToolsContract(join(fixtureRoot, 'catalog'))).toThrow(/missing contracts\/mcp-public-tools\.json/);
  });
});
