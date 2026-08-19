import { failClosed } from './errors.js';
import { loadPublicToolsDocument } from './loader.js';
import {
  IMPLEMENTATION_MCP_TOOLS,
  REQUIRED_PUBLIC_MCP_TOOLS,
  type SpecPublicTool,
  type SpecPublicToolsDocument,
} from './types.js';

export {
  IMPLEMENTATION_MCP_TOOLS,
  REQUIRED_PUBLIC_MCP_TOOLS,
} from './types.js';

/**
 * Load contracts/mcp-public-tools.json from a spec root and fail closed when
 * the contract is missing, malformed, or omits a required public tool.
 */
export function loadPublicToolsContract(specRoot: string): SpecPublicToolsDocument {
  const document = loadPublicToolsDocument(specRoot);
  assertPublicToolsContract(document);
  return document;
}

export function assertPublicToolsContract(document: SpecPublicToolsDocument): void {
  const names = document.tools.map((tool) => tool.name);
  const missing = REQUIRED_PUBLIC_MCP_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    failClosed(
      'spec-public-tools-incomplete',
      `contracts/mcp-public-tools.json is missing required tools: ${missing.join(', ')}.`,
      { detail: { missing: Object.freeze(missing) } },
    );
  }

  const unexpectedWrite = document.tools.filter((tool) => tool.category === 'write' && tool.write !== true);
  if (unexpectedWrite.length > 0) {
    failClosed(
      'spec-public-tools-write-mismatch',
      `Public write tools must set write=true: ${unexpectedWrite.map((tool) => tool.name).join(', ')}.`,
    );
  }

  const unexpectedRead = document.tools.filter((tool) => tool.category !== 'write' && tool.write !== false);
  if (unexpectedRead.length > 0) {
    failClosed(
      'spec-public-tools-read-mismatch',
      `Non-write public tools must set write=false: ${unexpectedRead.map((tool) => tool.name).join(', ')}.`,
    );
  }
}

export function missingPublicTools(
  registered: readonly string[],
  document?: SpecPublicToolsDocument,
): readonly string[] {
  const required = document === undefined
    ? REQUIRED_PUBLIC_MCP_TOOLS
    : document.tools.map((tool) => tool.name);
  return Object.freeze(required.filter((name) => !registered.includes(name)));
}

export function extraImplementationTools(
  registered: readonly string[] = IMPLEMENTATION_MCP_TOOLS,
  document?: SpecPublicToolsDocument,
): readonly string[] {
  const required = new Set(document === undefined ? REQUIRED_PUBLIC_MCP_TOOLS : document.tools.map((tool) => tool.name));
  return Object.freeze(registered.filter((name) => !required.has(name)));
}

export function assertImplementationExposesPublicTools(
  registered: readonly string[] = IMPLEMENTATION_MCP_TOOLS,
  document?: SpecPublicToolsDocument,
): void {
  const missing = missingPublicTools(registered, document);
  if (missing.length > 0) {
    failClosed(
      'spec-public-tools-unimplemented',
      `This implementation does not expose required public MCP tools: ${missing.join(', ')}.`,
      { detail: { missing } },
    );
  }
}

export function publicToolByName(
  document: SpecPublicToolsDocument,
  name: string,
): SpecPublicTool | undefined {
  return document.tools.find((tool) => tool.name === name);
}

export function publicToolsByCategory(
  document: SpecPublicToolsDocument,
  category: SpecPublicTool['category'],
): readonly SpecPublicTool[] {
  return Object.freeze(document.tools.filter((tool) => tool.category === category));
}

export function summarizePublicTools(document: SpecPublicToolsDocument): Readonly<Record<string, unknown>> {
  return Object.freeze({
    count: document.tools.length,
    write: document.tools.filter((tool) => tool.write).length,
    read: document.tools.filter((tool) => !tool.write).length,
    categories: Object.freeze({
      discovery: publicToolsByCategory(document, 'discovery').map((tool) => tool.name),
      read: publicToolsByCategory(document, 'read').map((tool) => tool.name),
      write: publicToolsByCategory(document, 'write').map((tool) => tool.name),
      security: publicToolsByCategory(document, 'security').map((tool) => tool.name),
    }),
    tools: document.tools,
    notes: document.notes ?? Object.freeze([]),
  });
}
