import { joomlaReadActions, joomlaWriteActions } from '../action-catalog.js';
import { joomlaCrudBases } from '../crud-bases.js';
import { crudWriteFieldsByBaseId, sensitiveCrudWriteFieldsByBaseId } from '../crud-write-fields.js';
import { sourceOnlyActionGates } from '../action-gates.js';
import type { Toolset } from '../../config/schema.js';
import { failClosed } from './errors.js';
import { loadSpecCatalog, loadSpecCatalogIfConfigured, resolveSpecRoot } from './loader.js';
import { mapSpecCatalog, overlaySpecCatalog, type FallbackCatalog } from './mapper.js';
import {
  getActionCatalogOverlay,
  isActionCatalogOverlayConfigured,
  resetActionCatalogOverlay,
  setActionCatalogOverlay,
} from './overlay.js';
import {
  assertImplementationExposesPublicTools,
  loadPublicToolsContract,
} from './public-tools.js';
import type {
  LoadedSpecCatalog,
  ResolvedActionCatalog,
  SpecCatalogOptions,
  SpecCatalogProvenance,
} from './types.js';
import { IMPLEMENTATION_MCP_TOOLS, SPEC_CATALOG_ENV } from './types.js';

export { SpecCatalogError, failClosed } from './errors.js';
export {
  loadSpecCatalog,
  loadSpecCatalogIfConfigured,
  loadPublicToolsDocument,
  resolveSpecRoot,
} from './loader.js';
export {
  convertSpecRouteTemplate,
  mapFamily,
  mapSpecCatalog,
  mapSpecListQueryFilters,
  overlaySpecCatalog,
  queryKeyForFilter,
} from './mapper.js';
export {
  IMPLEMENTATION_MCP_TOOLS,
  REQUIRED_PUBLIC_MCP_TOOLS,
  assertImplementationExposesPublicTools,
  assertPublicToolsContract,
  extraImplementationTools,
  loadPublicToolsContract,
  missingPublicTools,
  publicToolByName,
  publicToolsByCategory,
  summarizePublicTools,
} from './public-tools.js';
export {
  getActionCatalogOverlay,
  isActionCatalogOverlayConfigured,
  resetActionCatalogOverlay,
  setActionCatalogOverlay,
} from './overlay.js';
export {
  IMPLEMENTATION_MCP_TOOLS as implementationMcpTools,
  REQUIRED_PUBLIC_MCP_TOOLS as requiredPublicMcpTools,
  SPEC_ACTIONS_DIRECTORY,
  SPEC_CATALOG_ENV,
  SPEC_GATES_DOCUMENT,
  SPEC_GATE_ACTION_IDS,
  SPEC_PUBLIC_TOOLS_DOCUMENT,
  SPEC_REQUIRED_DOCUMENTS,
  type LoadedSpecCatalog,
  type MappedSpecCatalog,
  type MappedSpecFamily,
  type ResolvedActionCatalog,
  type SpecActionDescriptor,
  type SpecCatalogOptions,
  type SpecCatalogProvenance,
  type SpecFamilyDocument,
  type SpecGatesDocument,
  type SpecJsonSchema,
  type SpecMetaDocument,
  type SpecPublicToolsDocument,
  type SpecToolsetsDocument,
  type SpecWriteFieldsDocument,
} from './types.js';

const inRepoFallback: FallbackCatalog = Object.freeze({
  crudBases: joomlaCrudBases,
  readActions: joomlaReadActions,
  writeActions: joomlaWriteActions,
  writeFieldsByBaseId: crudWriteFieldsByBaseId,
  sensitiveWriteFieldsByBaseId: sensitiveCrudWriteFieldsByBaseId,
  sourceOnlyGates: sourceOnlyActionGates,
});

/**
 * Load joomla-mcp-spec when a root is configured and install it as the preferred
 * catalogue overlay. When the root is unset the in-repo catalogue remains the
 * authority. A configured root that cannot be loaded fails closed.
 */
export function configureSpecCatalog(options: SpecCatalogOptions = {}): ResolvedActionCatalog {
  const specRoot = resolveSpecRoot(options);
  if (specRoot === undefined) {
    const resolved = fallbackResolvedCatalog();
    if (options.installOverlay !== false) {
      setActionCatalogOverlay(undefined);
    }
    return resolved;
  }

  const loaded = loadSpecCatalog({ ...options, specRoot });
  const mapped = mapSpecCatalog(loaded);
  if (loaded.publicTools !== undefined) {
    assertImplementationExposesPublicTools(IMPLEMENTATION_MCP_TOOLS, loaded.publicTools);
  } else {
    loadPublicToolsContract(specRoot);
  }

  const overlaid = overlaySpecCatalog(mapped, inRepoFallback, loaded);
  const resolved = Object.freeze({
    provenance: Object.freeze({
      consumed: true,
      specRoot,
      specVersion: loaded.meta.specVersion,
      status: loaded.meta.status,
      extractedFamilies: loaded.meta.extractedFamilies,
      familyCount: loaded.families.length,
      actionCount: mapped.actions.length,
      fallback: 'spec-overlay',
    }) satisfies SpecCatalogProvenance,
    spec: loaded,
    mapped,
    crudBases: overlaid.crudBases,
    readActions: overlaid.readActions,
    writeActions: overlaid.writeActions,
    actions: overlaid.actions,
    readById: new Map(overlaid.readActions.map((action) => [action.id, action])),
    writeById: new Map(overlaid.writeActions.map((action) => [action.id, action])),
    writeFieldsByBaseId: overlaid.writeFieldsByBaseId,
    sensitiveWriteFieldsByBaseId: overlaid.sensitiveWriteFieldsByBaseId,
    sourceOnlyGates: overlaid.sourceOnlyGates,
    publicTools: overlaid.publicTools,
    toolsetIds: new Set(loaded.toolsets.toolsets.map((entry) => entry.id as Toolset)),
  }) satisfies ResolvedActionCatalog;

  if (options.installOverlay !== false) {
    setActionCatalogOverlay(resolved);
  }

  return resolved;
}

export function resetSpecCatalog(): void {
  resetActionCatalogOverlay();
}

export function specCatalogProvenance(): SpecCatalogProvenance {
  return getActionCatalogOverlay()?.provenance ?? Object.freeze({
    consumed: false,
    fallback: 'in-repo',
  });
}

export function getResolvedActionCatalog(): ResolvedActionCatalog {
  return getActionCatalogOverlay() ?? fallbackResolvedCatalog();
}

export function isSpecCatalogActive(): boolean {
  return getActionCatalogOverlay()?.provenance.consumed === true;
}

/**
 * Configure from JOOMLA_MCP_SPEC / specRoot at most once per process unless
 * resetSpecCatalog() has been called. createRuntime uses this so stdio, HTTP,
 * and embeddable hosts pick up the shared spec without rewriting the server.
 */
export function ensureSpecCatalogConfigured(options: SpecCatalogOptions = {}): ResolvedActionCatalog {
  if (isActionCatalogOverlayConfigured() && options.specRoot === undefined && options.installOverlay !== false) {
    return getResolvedActionCatalog();
  }
  return configureSpecCatalog(options);
}

export function requireSpecCatalog(options: SpecCatalogOptions = {}): LoadedSpecCatalog {
  const loaded = loadSpecCatalogIfConfigured(options);
  if (loaded === undefined) {
    failClosed(
      'spec-root-unset',
      `A joomla-mcp-spec root is required (set ${SPEC_CATALOG_ENV} or pass specRoot).`,
    );
  }
  return loaded;
}

function fallbackResolvedCatalog(): ResolvedActionCatalog {
  return Object.freeze({
    provenance: Object.freeze({
      consumed: false,
      fallback: 'in-repo',
    }),
    spec: undefined,
    mapped: undefined,
    crudBases: joomlaCrudBases,
    readActions: joomlaReadActions,
    writeActions: joomlaWriteActions,
    actions: Object.freeze([...joomlaReadActions, ...joomlaWriteActions]),
    readById: new Map(joomlaReadActions.map((action) => [action.id, action])),
    writeById: new Map(joomlaWriteActions.map((action) => [action.id, action])),
    writeFieldsByBaseId: crudWriteFieldsByBaseId,
    sensitiveWriteFieldsByBaseId: sensitiveCrudWriteFieldsByBaseId,
    sourceOnlyGates: sourceOnlyActionGates,
    publicTools: undefined,
    toolsetIds: new Set<Toolset>(),
  });
}
