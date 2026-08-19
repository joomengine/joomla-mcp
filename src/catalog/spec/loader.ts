import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ToolsetSchema } from '../../config/schema.js';
import { failClosed, failInvalidDocument, failMissingFile, SpecCatalogError } from './errors.js';
import {
  SPEC_ACTIONS_DIRECTORY,
  SPEC_AUTHENTICATIONS,
  SPEC_BODY_POLICIES,
  SPEC_CATALOG_ENV,
  SPEC_DELETE_SEMANTICS,
  SPEC_DRIVER_KINDS,
  SPEC_GATES_DOCUMENT,
  SPEC_GATE_SEVERITIES,
  SPEC_HTTP_METHODS,
  SPEC_JSON_SCHEMA_TYPES,
  SPEC_MUTATION_BODIES,
  SPEC_OPERATIONS,
  SPEC_PUBLIC_TOOL_CATEGORIES,
  SPEC_PUBLIC_TOOLS_DOCUMENT,
  SPEC_REQUIRED_DOCUMENTS,
  SPEC_RESPONSE_SHAPES,
  SPEC_RISKS,
  SPEC_ROUTE_PARAMETER_KINDS,
  SPEC_SOURCE_REGISTRATIONS,
  SPEC_TRANSPORTS,
  type LoadedSpecCatalog,
  type LoadedSpecFamily,
  type SpecActionDescriptor,
  type SpecAuthentication,
  type SpecBodyPolicy,
  type SpecCatalogOptions,
  type SpecDeleteSemantics,
  type SpecDriver,
  type SpecDriverKind,
  type SpecExaminedHeads,
  type SpecFamilyBase,
  type SpecFamilyDocument,
  type SpecGateEntry,
  type SpecGateSeverity,
  type SpecGatesDocument,
  type SpecHttpMethod,
  type SpecJoomlaBaselines,
  type SpecJsonSchema,
  type SpecJsonSchemaType,
  type SpecMetaDocument,
  type SpecMutationBody,
  type SpecOperation,
  type SpecPublicTool,
  type SpecPublicToolCategory,
  type SpecPublicToolsDocument,
  type SpecResponseShape,
  type SpecRisk,
  type SpecRouteParameter,
  type SpecRouteParameterKind,
  type SpecSourceReference,
  type SpecSourceRegistration,
  type SpecToolsetEntry,
  type SpecToolsetsDocument,
  type SpecTransport,
  type SpecWriteFieldAllowlist,
  type SpecWriteFieldsDocument,
} from './types.js';

const ACTION_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const COMPONENT_PATTERN = /^com_[a-z0-9_]+$/;
const ROUTE_TEMPLATE_PATTERN = /^v1\/[A-Za-z0-9/_{}:.-]+$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const FAMILY_FILE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.json$/;
const TOOLSET_PATTERN = /^[a-z][a-z0-9._-]*$/;
const PLUGIN_PATTERN = /^webservices\/[a-z0-9-]+$/;
const SOURCE_PATH_PATTERN = /^plugins\/webservices\/[A-Za-z0-9_-]+\/src\/Extension\/[A-Za-z0-9]+\.php$/;
const MAXIMUM_FAMILY_ACTIONS = 32;
const MAXIMUM_WRITE_FIELDS = 128;
const MAXIMUM_JSON_DEPTH = 16;

export function resolveSpecRoot(options: SpecCatalogOptions = {}): string | undefined {
  const configured = options.specRoot ?? process.env[SPEC_CATALOG_ENV];
  if (configured === undefined) {
    return undefined;
  }
  const trimmed = configured.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

export function loadSpecCatalog(options: SpecCatalogOptions = {}): LoadedSpecCatalog {
  const specRoot = resolveSpecRoot(options);
  if (specRoot === undefined) {
    failClosed(
      'spec-root-unset',
      `A joomla-mcp-spec root is required (set ${SPEC_CATALOG_ENV} or pass specRoot).`,
    );
  }

  assertSpecRoot(specRoot);

  const meta = loadMeta(specRoot);
  const toolsets = loadToolsets(specRoot);
  const writeFields = loadWriteFields(specRoot);
  const gates = loadGates(specRoot);
  const families = loadFamilies(specRoot, meta, toolsets, writeFields);
  const publicTools = loadOptionalPublicTools(specRoot);

  return Object.freeze({
    specRoot,
    meta,
    toolsets,
    writeFields,
    gates,
    families,
    ...(publicTools === undefined ? {} : { publicTools }),
  });
}

export function loadSpecCatalogIfConfigured(options: SpecCatalogOptions = {}): LoadedSpecCatalog | undefined {
  const specRoot = resolveSpecRoot(options);
  if (specRoot === undefined) {
    return undefined;
  }
  return loadSpecCatalog({ ...options, specRoot });
}

function assertSpecRoot(specRoot: string): void {
  if (!existsSync(specRoot)) {
    failClosed('spec-root-missing', `joomla-mcp-spec root does not exist: ${specRoot}.`, { specPath: specRoot });
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(specRoot);
  } catch (cause) {
    failClosed('spec-root-unreadable', `joomla-mcp-spec root is unreadable: ${specRoot}.`, { specPath: specRoot, cause });
  }

  if (!stats.isDirectory()) {
    failClosed('spec-root-not-directory', `joomla-mcp-spec root is not a directory: ${specRoot}.`, { specPath: specRoot });
  }

  for (const relativePath of SPEC_REQUIRED_DOCUMENTS) {
    const absolute = join(specRoot, relativePath);
    if (!existsSync(absolute)) {
      failMissingFile(specRoot, relativePath);
    }
  }

  const actionsDirectory = join(specRoot, SPEC_ACTIONS_DIRECTORY);
  if (!existsSync(actionsDirectory)) {
    failMissingFile(specRoot, SPEC_ACTIONS_DIRECTORY);
  }
  try {
    if (!statSync(actionsDirectory).isDirectory()) {
      failClosed(
        'spec-actions-not-directory',
        `joomla-mcp-spec ${SPEC_ACTIONS_DIRECTORY} is not a directory.`,
        { specPath: specRoot },
      );
    }
  } catch (cause) {
    if (cause instanceof SpecCatalogError) {
      throw cause;
    }
    failClosed('spec-actions-unreadable', `joomla-mcp-spec ${SPEC_ACTIONS_DIRECTORY} is unreadable.`, {
      specPath: specRoot,
      cause,
    });
  }
}

function loadMeta(specRoot: string): SpecMetaDocument {
  const relativePath = 'catalog/meta.json';
  const raw = readJsonObject(specRoot, relativePath);
  const specVersion = requiredString(raw, 'specVersion', specRoot, relativePath);
  if (!VERSION_PATTERN.test(specVersion)) {
    failInvalidDocument(specRoot, relativePath, `specVersion ${specVersion} is not a dotted triple.`);
  }
  const name = requiredString(raw, 'name', specRoot, relativePath);
  if (name !== 'joomla-mcp-spec') {
    failInvalidDocument(specRoot, relativePath, `unexpected spec name ${name}.`);
  }
  const description = requiredString(raw, 'description', specRoot, relativePath);
  const status = requiredString(raw, 'status', specRoot, relativePath);
  const joomlaBaselines = parseJoomlaBaselines(raw['joomlaBaselines'], specRoot, relativePath);
  const examinedHeads = parseExaminedHeads(raw['examinedHeads'], specRoot, relativePath);
  const consumers = requiredStringArray(raw, 'consumers', specRoot, relativePath);
  if (!consumers.includes('joomengine/joomla-mcp-ts')) {
    failInvalidDocument(specRoot, relativePath, 'consumers must include joomengine/joomla-mcp-ts.');
  }
  const extractedFamilies = requiredStringArray(raw, 'extractedFamilies', specRoot, relativePath);
  if (extractedFamilies.length === 0) {
    failInvalidDocument(specRoot, relativePath, 'extractedFamilies must not be empty.');
  }
  const duplicateFamilies = duplicates(extractedFamilies);
  if (duplicateFamilies.length > 0) {
    failInvalidDocument(specRoot, relativePath, `duplicate extractedFamilies: ${duplicateFamilies.join(', ')}.`);
  }
  for (const family of extractedFamilies) {
    if (!ACTION_ID_PATTERN.test(family)) {
      failInvalidDocument(specRoot, relativePath, `extracted family id ${family} is not a valid identifier.`);
    }
  }
  const notes = optionalStringArray(raw, 'notes', specRoot, relativePath);

  return freezeJson({
    specVersion,
    name,
    description,
    joomlaBaselines,
    examinedHeads,
    consumers: Object.freeze([...consumers]),
    status,
    extractedFamilies: Object.freeze([...extractedFamilies]),
    ...(notes === undefined ? {} : { notes: Object.freeze([...notes]) }),
  });
}

function parseJoomlaBaselines(value: unknown, specRoot: string, relativePath: string): SpecJoomlaBaselines {
  const record = asObject(value, specRoot, relativePath, 'joomlaBaselines');
  const implementation = requiredString(record, 'implementation', specRoot, relativePath, 'joomlaBaselines.implementation');
  const compatibilityTarget = requiredString(
    record,
    'compatibilityTarget',
    specRoot,
    relativePath,
    'joomlaBaselines.compatibilityTarget',
  );
  const canary = requiredString(record, 'canary', specRoot, relativePath, 'joomlaBaselines.canary');
  if (!/^\d+\.\d+$/.test(implementation) && !/^\d+\.\d+\.x$/.test(implementation)) {
    failInvalidDocument(specRoot, relativePath, `joomlaBaselines.implementation ${implementation} is not a baseline.`);
  }
  return Object.freeze({ implementation, compatibilityTarget, canary });
}

function parseExaminedHeads(value: unknown, specRoot: string, relativePath: string): SpecExaminedHeads {
  const record = asObject(value, specRoot, relativePath, 'examinedHeads');
  const baseline = requiredCommit(record, '6.1-dev', specRoot, relativePath);
  const compatible = requiredCommit(record, '6.2-dev', specRoot, relativePath);
  const canary = requiredCommit(record, '7.0-dev', specRoot, relativePath);
  return Object.freeze({
    '6.1-dev': baseline,
    '6.2-dev': compatible,
    '7.0-dev': canary,
  });
}

function requiredCommit(record: Readonly<Record<string, unknown>>, key: string, specRoot: string, relativePath: string): string {
  const value = requiredString(record, key, specRoot, relativePath, `examinedHeads.${key}`);
  if (!COMMIT_PATTERN.test(value)) {
    failInvalidDocument(specRoot, relativePath, `examinedHeads.${key} is not a 40-character git commit.`);
  }
  return value;
}

function loadToolsets(specRoot: string): SpecToolsetsDocument {
  const relativePath = 'catalog/toolsets.json';
  const raw = readJsonObject(specRoot, relativePath);
  const description = optionalString(raw, 'description', specRoot, relativePath);
  const schema = optionalString(raw, '$schema', specRoot, relativePath);
  const entries = raw['toolsets'];
  if (!Array.isArray(entries) || entries.length === 0) {
    failInvalidDocument(specRoot, relativePath, 'toolsets must be a non-empty array.');
  }

  const toolsets: SpecToolsetEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const record = asObject(entry, specRoot, relativePath, `toolsets[${index}]`);
    const id = requiredString(record, 'id', specRoot, relativePath, `toolsets[${index}].id`);
    if (!TOOLSET_PATTERN.test(id)) {
      failInvalidDocument(specRoot, relativePath, `toolset id ${id} is not a valid identifier.`);
    }
    if (seen.has(id)) {
      failInvalidDocument(specRoot, relativePath, `duplicate toolset id ${id}.`);
    }
    const parsed = ToolsetSchema.safeParse(id);
    if (!parsed.success) {
      failInvalidDocument(specRoot, relativePath, `toolset ${id} is not an implementation Toolset.`);
    }
    const toolsetDescription = requiredString(record, 'description', specRoot, relativePath, `toolsets[${index}].description`);
    const write = record['write'];
    if (typeof write !== 'boolean') {
      failInvalidDocument(specRoot, relativePath, `toolsets[${index}].write must be a boolean.`);
    }
    if (id.endsWith('.write') || id.endsWith('.admin') || id === 'core-update') {
      if (write !== true) {
        failInvalidDocument(specRoot, relativePath, `mutating toolset ${id} must set write=true.`);
      }
    }
    if (id.endsWith('.read') || id === 'discovery' || id === 'cli.discovery') {
      if (write !== false) {
        failInvalidDocument(specRoot, relativePath, `read toolset ${id} must set write=false.`);
      }
    }
    seen.add(id);
    toolsets.push(Object.freeze({ id, description: toolsetDescription, write }));
  }

  return freezeJson({
    ...(schema === undefined ? {} : { $schema: schema }),
    ...(description === undefined ? {} : { description }),
    toolsets: Object.freeze(toolsets),
  });
}

function loadWriteFields(specRoot: string): SpecWriteFieldsDocument {
  const relativePath = 'catalog/write-fields.json';
  const raw = readJsonObject(specRoot, relativePath);
  const comment = optionalString(raw, '$comment', specRoot, relativePath);
  const basesRaw = asObject(raw['bases'], specRoot, relativePath, 'bases');
  const bases: Record<string, SpecWriteFieldAllowlist> = {};

  for (const [baseId, value] of Object.entries(basesRaw)) {
    if (!ACTION_ID_PATTERN.test(baseId)) {
      failInvalidDocument(specRoot, relativePath, `write-fields base id ${baseId} is not a valid identifier.`);
    }
    const record = asObject(value, specRoot, relativePath, `bases.${baseId}`);
    const fields = requiredStringArray(record, 'fields', specRoot, relativePath, `bases.${baseId}.fields`);
    const sensitive = requiredStringArray(record, 'sensitive', specRoot, relativePath, `bases.${baseId}.sensitive`);
    if (fields.length === 0) {
      failInvalidDocument(specRoot, relativePath, `bases.${baseId}.fields must not be empty.`);
    }
    if (fields.length > MAXIMUM_WRITE_FIELDS) {
      failInvalidDocument(specRoot, relativePath, `bases.${baseId}.fields exceeds ${MAXIMUM_WRITE_FIELDS} entries.`);
    }
    const duplicateFields = duplicates(fields);
    if (duplicateFields.length > 0) {
      failInvalidDocument(specRoot, relativePath, `bases.${baseId} has duplicate fields: ${duplicateFields.join(', ')}.`);
    }
    for (const field of fields) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
        failInvalidDocument(specRoot, relativePath, `bases.${baseId} field ${field} is not a Joomla form key.`);
      }
    }
    for (const field of sensitive) {
      if (!fields.includes(field)) {
        failInvalidDocument(specRoot, relativePath, `bases.${baseId} sensitive field ${field} is not in the allowlist.`);
      }
    }
    bases[baseId] = Object.freeze({
      fields: Object.freeze([...fields]),
      sensitive: Object.freeze([...sensitive]),
    });
  }

  return freezeJson({
    ...(comment === undefined ? {} : { $comment: comment }),
    bases: Object.freeze(bases),
  });
}

function loadGates(specRoot: string): SpecGatesDocument {
  const relativePath = SPEC_GATES_DOCUMENT;
  const absolute = join(specRoot, relativePath);
  if (!existsSync(absolute)) {
    return Object.freeze({ gates: Object.freeze([]) });
  }

  const raw = readJsonObject(specRoot, relativePath);
  const comment = optionalString(raw, '$comment', specRoot, relativePath);
  const entries = raw['gates'];
  if (!Array.isArray(entries)) {
    failInvalidDocument(specRoot, relativePath, 'gates must be an array.');
  }

  const gates: SpecGateEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const record = asObject(entry, specRoot, relativePath, `gates[${index}]`);
    const id = requiredString(record, 'id', specRoot, relativePath, `gates[${index}].id`);
    if (!ACTION_ID_PATTERN.test(id)) {
      failInvalidDocument(specRoot, relativePath, `gate id ${id} is not a valid identifier.`);
    }
    if (seen.has(id)) {
      failInvalidDocument(specRoot, relativePath, `duplicate gate id ${id}.`);
    }
    const reason = requiredString(record, 'reason', specRoot, relativePath, `gates[${index}].reason`);
    const severity = requiredEnum(record, 'severity', SPEC_GATE_SEVERITIES, specRoot, relativePath, `gates[${index}].severity`);
    seen.add(id);
    gates.push(Object.freeze({ id, reason, severity: severity as SpecGateSeverity }));
  }

  return freezeJson({
    ...(comment === undefined ? {} : { $comment: comment }),
    gates: Object.freeze(gates),
  });
}

function loadFamilies(
  specRoot: string,
  meta: SpecMetaDocument,
  toolsets: SpecToolsetsDocument,
  writeFields: SpecWriteFieldsDocument,
): readonly LoadedSpecFamily[] {
  const relativeDirectory = SPEC_ACTIONS_DIRECTORY;
  const absoluteDirectory = join(specRoot, relativeDirectory);
  let entries: string[];
  try {
    entries = readdirSync(absoluteDirectory);
  } catch (cause) {
    failClosed('spec-actions-unreadable', `Unable to list ${relativeDirectory}.`, { specPath: specRoot, cause });
  }

  const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();
  if (jsonFiles.length === 0) {
    failClosed('spec-actions-empty', `joomla-mcp-spec ${relativeDirectory} contains no family documents.`, {
      specPath: specRoot,
    });
  }

  const toolsetIds = new Set(toolsets.toolsets.map((entry) => entry.id));
  const loaded: LoadedSpecFamily[] = [];
  const seenFamilyIds = new Set<string>();
  const seenActionIds = new Set<string>();

  for (const fileName of jsonFiles) {
    if (!FAMILY_FILE_PATTERN.test(fileName)) {
      failInvalidDocument(specRoot, `${relativeDirectory}/${fileName}`, 'family file name is not a dotted identifier.');
    }
    const relativePath = `${relativeDirectory}/${fileName}`;
    const document = parseFamilyDocument(specRoot, relativePath, toolsetIds, writeFields);
    if (seenFamilyIds.has(document.base.id)) {
      failInvalidDocument(specRoot, relativePath, `duplicate family id ${document.base.id}.`);
    }
    const expectedFile = `${document.base.id}.json`;
    if (fileName !== expectedFile) {
      failInvalidDocument(specRoot, relativePath, `file name must be ${expectedFile}.`);
    }
    for (const action of document.actions) {
      if (seenActionIds.has(action.id)) {
        failInvalidDocument(specRoot, relativePath, `duplicate action id ${action.id}.`);
      }
      seenActionIds.add(action.id);
    }
    seenFamilyIds.add(document.base.id);
    loaded.push(Object.freeze({ relativePath, document }));
  }

  for (const family of meta.extractedFamilies) {
    if (!seenFamilyIds.has(family)) {
      failMissingFile(specRoot, `${relativeDirectory}/${family}.json`);
    }
  }

  return Object.freeze(loaded);
}

function parseFamilyDocument(
  specRoot: string,
  relativePath: string,
  toolsetIds: ReadonlySet<string>,
  writeFields: SpecWriteFieldsDocument,
): SpecFamilyDocument {
  const raw = readJsonObject(specRoot, relativePath);
  const comment = optionalString(raw, '$comment', specRoot, relativePath);
  const base = parseFamilyBase(asObject(raw['base'], specRoot, relativePath, 'base'), specRoot, relativePath, toolsetIds);
  const actionsRaw = raw['actions'];
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
    failInvalidDocument(specRoot, relativePath, 'actions must be a non-empty array.');
  }
  if (actionsRaw.length > MAXIMUM_FAMILY_ACTIONS) {
    failInvalidDocument(specRoot, relativePath, `actions exceeds ${MAXIMUM_FAMILY_ACTIONS} entries.`);
  }

  const allowlist = writeFields.bases[base.id];
  const actions = actionsRaw.map((entry, index) =>
    parseActionDescriptor(entry, index, specRoot, relativePath, base, toolsetIds, allowlist),
  );

  return freezeJson({
    ...(comment === undefined ? {} : { $comment: comment }),
    base,
    actions: Object.freeze(actions),
  });
}

function parseFamilyBase(
  raw: Readonly<Record<string, unknown>>,
  specRoot: string,
  relativePath: string,
  toolsetIds: ReadonlySet<string>,
): SpecFamilyBase {
  const id = requiredString(raw, 'id', specRoot, relativePath, 'base.id');
  if (!ACTION_ID_PATTERN.test(id)) {
    failInvalidDocument(specRoot, relativePath, `base.id ${id} is not a valid identifier.`);
  }
  const domain = requiredString(raw, 'domain', specRoot, relativePath, 'base.domain');
  const resource = requiredString(raw, 'resource', specRoot, relativePath, 'base.resource');
  const collectionName = requiredString(raw, 'collectionName', specRoot, relativePath, 'base.collectionName');
  const itemName = requiredString(raw, 'itemName', specRoot, relativePath, 'base.itemName');
  const basePath = requiredString(raw, 'basePath', specRoot, relativePath, 'base.basePath');
  if (!ROUTE_TEMPLATE_PATTERN.test(basePath)) {
    failInvalidDocument(specRoot, relativePath, `base.basePath ${basePath} is not a Joomla API path.`);
  }
  const controller = requiredString(raw, 'controller', specRoot, relativePath, 'base.controller');
  const component = requiredString(raw, 'component', specRoot, relativePath, 'base.component');
  if (!COMPONENT_PATTERN.test(component)) {
    failInvalidDocument(specRoot, relativePath, `base.component ${component} is not a Joomla component name.`);
  }
  const toolsetRead = requiredToolset(raw, 'toolsetRead', specRoot, relativePath, toolsetIds, 'base.toolsetRead');
  const toolsetWrite = requiredToolset(raw, 'toolsetWrite', specRoot, relativePath, toolsetIds, 'base.toolsetWrite');
  const deleteSemantics = optionalEnum(
    raw,
    'deleteSemantics',
    SPEC_DELETE_SEMANTICS,
    specRoot,
    relativePath,
    'base.deleteSemantics',
  );
  const driver = parseDriver(raw['driver'], specRoot, relativePath, 'base.driver', { requireKind: 'joomla-api' });
  const source = parseSource(raw['source'], specRoot, relativePath, 'base.source');
  const defaults = optionalStringNumberRecord(raw['defaults'], specRoot, relativePath, 'base.defaults');
  const controllerDefaults = optionalStringNumberRecord(
    raw['controllerDefaults'],
    specRoot,
    relativePath,
    'base.controllerDefaults',
  );

  return Object.freeze({
    id,
    domain,
    resource,
    collectionName,
    itemName,
    basePath,
    controller,
    component,
    toolsetRead,
    toolsetWrite,
    ...(deleteSemantics === undefined ? {} : { deleteSemantics: deleteSemantics as SpecDeleteSemantics }),
    driver,
    source,
    ...(defaults === undefined ? {} : { defaults }),
    ...(controllerDefaults === undefined ? {} : { controllerDefaults }),
  });
}

function parseActionDescriptor(
  value: unknown,
  index: number,
  specRoot: string,
  relativePath: string,
  base: SpecFamilyBase,
  toolsetIds: ReadonlySet<string>,
  allowlist: SpecWriteFieldAllowlist | undefined,
): SpecActionDescriptor {
  const path = `actions[${index}]`;
  const raw = asObject(value, specRoot, relativePath, path);
  const id = requiredString(raw, 'id', specRoot, relativePath, `${path}.id`);
  if (!ACTION_ID_PATTERN.test(id)) {
    failInvalidDocument(specRoot, relativePath, `${path}.id ${id} is not a valid identifier.`);
  }
  const title = requiredString(raw, 'title', specRoot, relativePath, `${path}.title`);
  if (title.length > 200) {
    failInvalidDocument(specRoot, relativePath, `${path}.title exceeds 200 characters.`);
  }
  const description = requiredString(raw, 'description', specRoot, relativePath, `${path}.description`);
  if (description.length > 2000) {
    failInvalidDocument(specRoot, relativePath, `${path}.description exceeds 2000 characters.`);
  }
  const domain = requiredString(raw, 'domain', specRoot, relativePath, `${path}.domain`);
  const operation = requiredEnum(raw, 'operation', SPEC_OPERATIONS, specRoot, relativePath, `${path}.operation`);
  const method = requiredEnum(raw, 'method', SPEC_HTTP_METHODS, specRoot, relativePath, `${path}.method`);
  assertOperationMethod(operation as SpecOperation, method as SpecHttpMethod, specRoot, relativePath, path);
  const routeTemplate = requiredString(raw, 'routeTemplate', specRoot, relativePath, `${path}.routeTemplate`);
  if (!ROUTE_TEMPLATE_PATTERN.test(routeTemplate)) {
    failInvalidDocument(specRoot, relativePath, `${path}.routeTemplate ${routeTemplate} is not a Joomla API path.`);
  }
  const routeParameters = parseRouteParameters(raw['routeParameters'], specRoot, relativePath, `${path}.routeParameters`);
  assertRouteParametersMatchTemplate(routeTemplate, routeParameters, specRoot, relativePath, path);
  const toolset = requiredToolset(raw, 'toolset', specRoot, relativePath, toolsetIds, `${path}.toolset`);
  const risk = requiredEnum(raw, 'risk', SPEC_RISKS, specRoot, relativePath, `${path}.risk`);
  assertOperationRisk(operation as SpecOperation, risk as SpecRisk, specRoot, relativePath, path);
  const inputSchema = parseInputSchema(raw['inputSchema'], specRoot, relativePath, `${path}.inputSchema`);
  const driver = parseDriver(raw['driver'], specRoot, relativePath, `${path}.driver`, { inherit: base.driver });
  const component = optionalString(raw, 'component', specRoot, relativePath, `${path}.component`);
  if (component !== undefined && !COMPONENT_PATTERN.test(component)) {
    failInvalidDocument(specRoot, relativePath, `${path}.component ${component} is not a Joomla component name.`);
  }
  const source = raw['source'] === undefined
    ? undefined
    : parseSource(raw['source'], specRoot, relativePath, `${path}.source`);
  const paginated = optionalBoolean(raw, 'paginated', specRoot, relativePath, `${path}.paginated`);
  const sideEffect = optionalBoolean(raw, 'sideEffect', specRoot, relativePath, `${path}.sideEffect`);
  const bodyPolicy = optionalEnum(raw, 'bodyPolicy', SPEC_BODY_POLICIES, specRoot, relativePath, `${path}.bodyPolicy`);
  const writeFields = optionalStringArray(raw, 'writeFields', specRoot, relativePath, `${path}.writeFields`);
  const deleteSemantics = optionalEnum(
    raw,
    'deleteSemantics',
    SPEC_DELETE_SEMANTICS,
    specRoot,
    relativePath,
    `${path}.deleteSemantics`,
  );
  const gate = optionalString(raw, 'gate', specRoot, relativePath, `${path}.gate`);
  const controllerDefaults = optionalStringNumberRecord(
    raw['controllerDefaults'],
    specRoot,
    relativePath,
    `${path}.controllerDefaults`,
  );

  if (operation === 'list' && paginated === undefined) {
    failInvalidDocument(specRoot, relativePath, `${path} list actions must declare paginated.`);
  }
  if ((operation === 'list' || operation === 'get' || operation === 'export' || operation === 'healthcheck' || operation === 'status')
    && sideEffect === undefined) {
    failInvalidDocument(specRoot, relativePath, `${path} read actions must declare sideEffect.`);
  }
  if (operation === 'create' || operation === 'update' || operation === 'delete' || operation === 'state' || operation === 'run') {
    if (bodyPolicy === undefined) {
      failInvalidDocument(specRoot, relativePath, `${path} write actions must declare bodyPolicy.`);
    }
  }
  if ((operation === 'create' || operation === 'update') && writeFields !== undefined && allowlist !== undefined) {
    const missing = writeFields.filter((field) => !allowlist.fields.includes(field));
    if (missing.length > 0) {
      failInvalidDocument(
        specRoot,
        relativePath,
        `${path}.writeFields contains names missing from catalog/write-fields.json: ${missing.join(', ')}.`,
      );
    }
  }
  if (operation === 'delete' && deleteSemantics === undefined && base.deleteSemantics === undefined) {
    failInvalidDocument(specRoot, relativePath, `${path} delete actions must declare deleteSemantics.`);
  }

  return Object.freeze({
    id,
    title,
    description,
    domain,
    operation: operation as SpecOperation,
    method: method as SpecHttpMethod,
    routeTemplate,
    ...(routeParameters === undefined ? {} : { routeParameters }),
    ...(paginated === undefined ? {} : { paginated }),
    ...(bodyPolicy === undefined ? {} : { bodyPolicy: bodyPolicy as SpecBodyPolicy }),
    ...(sideEffect === undefined ? {} : { sideEffect }),
    toolset,
    risk: risk as SpecRisk,
    inputSchema,
    ...(writeFields === undefined ? {} : { writeFields: Object.freeze([...writeFields]) }),
    ...(deleteSemantics === undefined ? {} : { deleteSemantics: deleteSemantics as SpecDeleteSemantics }),
    ...(driver === undefined ? {} : { driver }),
    ...(component === undefined ? {} : { component }),
    ...(source === undefined ? {} : { source }),
    ...(gate === undefined ? {} : { gate }),
    ...(controllerDefaults === undefined ? {} : { controllerDefaults }),
  });
}

function parseRouteParameters(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): readonly SpecRouteParameter[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be an array.`);
  }
  const parameters = value.map((entry, index) => {
    const record = asObject(entry, specRoot, relativePath, `${path}[${index}]`);
    const name = requiredString(record, 'name', specRoot, relativePath, `${path}[${index}].name`);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      failInvalidDocument(specRoot, relativePath, `${path}[${index}].name ${name} is not a valid parameter name.`);
    }
    const kind = requiredEnum(
      record,
      'kind',
      SPEC_ROUTE_PARAMETER_KINDS,
      specRoot,
      relativePath,
      `${path}[${index}].kind`,
    );
    const required = record['required'];
    if (typeof required !== 'boolean') {
      failInvalidDocument(specRoot, relativePath, `${path}[${index}].required must be a boolean.`);
    }
    if (required !== true) {
      failInvalidDocument(specRoot, relativePath, `${path}[${index}].required must be true; optional route parameters are rejected.`);
    }
    const maximumLength = optionalPositiveInteger(record, 'maximumLength', specRoot, relativePath, `${path}[${index}].maximumLength`);
    return Object.freeze({
      name,
      kind: kind as SpecRouteParameterKind,
      required: true as const,
      ...(maximumLength === undefined ? {} : { maximumLength }),
    });
  });
  return Object.freeze(parameters);
}

function assertRouteParametersMatchTemplate(
  routeTemplate: string,
  parameters: readonly SpecRouteParameter[] | undefined,
  specRoot: string,
  relativePath: string,
  path: string,
): void {
  const placeholders = [...routeTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? '');
  const declared = (parameters ?? []).map((parameter) => parameter.name);
  if (placeholders.length !== declared.length) {
    failInvalidDocument(
      specRoot,
      relativePath,
      `${path}.routeParameters must match {placeholders} in ${routeTemplate}.`,
    );
  }
  for (const [index, name] of placeholders.entries()) {
    if (declared[index] !== name) {
      failInvalidDocument(
        specRoot,
        relativePath,
        `${path}.routeParameters[${index}] must be ${name} to match ${routeTemplate}.`,
      );
    }
  }
}

function parseInputSchema(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): SpecJsonSchema {
  const schema = parseJsonSchema(value, specRoot, relativePath, path, 0);
  if (schema.type !== 'object') {
    failInvalidDocument(specRoot, relativePath, `${path}.type must be object.`);
  }
  if (schema.additionalProperties !== false) {
    failInvalidDocument(specRoot, relativePath, `${path}.additionalProperties must be false.`);
  }
  if (schema.properties === undefined) {
    failInvalidDocument(specRoot, relativePath, `${path}.properties must be an object.`);
  }
  return schema;
}

function parseJsonSchema(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  depth: number,
): SpecJsonSchema {
  if (depth > MAXIMUM_JSON_DEPTH) {
    failInvalidDocument(specRoot, relativePath, `${path} exceeds the maximum JSON Schema nesting depth.`);
  }
  const raw = asObject(value, specRoot, relativePath, path);
  const type = parseJsonSchemaType(raw['type'], specRoot, relativePath, `${path}.type`);
  const properties = parseJsonSchemaProperties(raw['properties'], specRoot, relativePath, `${path}.properties`, depth);
  const items = parseJsonSchemaItems(raw['items'], specRoot, relativePath, `${path}.items`, depth);
  const required = optionalStringArray(raw, 'required', specRoot, relativePath, `${path}.required`);
  const additionalProperties = parseAdditionalProperties(
    raw['additionalProperties'],
    specRoot,
    relativePath,
    `${path}.additionalProperties`,
    depth,
  );
  const enumerated = raw['enum'];
  if (enumerated !== undefined && !Array.isArray(enumerated)) {
    failInvalidDocument(specRoot, relativePath, `${path}.enum must be an array.`);
  }
  const oneOf = parseJsonSchemaArray(raw['oneOf'], specRoot, relativePath, `${path}.oneOf`, depth);
  const anyOf = parseJsonSchemaArray(raw['anyOf'], specRoot, relativePath, `${path}.anyOf`, depth);
  const allOf = parseJsonSchemaArray(raw['allOf'], specRoot, relativePath, `${path}.allOf`, depth);
  const not = raw['not'] === undefined ? undefined : parseJsonSchema(raw['not'], specRoot, relativePath, `${path}.not`, depth + 1);

  return freezeJson({
    ...(type === undefined ? {} : { type }),
    ...(properties === undefined ? {} : { properties }),
    ...(items === undefined ? {} : { items }),
    ...(required === undefined ? {} : { required: Object.freeze([...required]) }),
    ...(additionalProperties === undefined ? {} : { additionalProperties }),
    ...(enumerated === undefined ? {} : { enum: Object.freeze([...enumerated]) }),
    ...(raw['const'] === undefined ? {} : { const: raw['const'] }),
    ...(oneOf === undefined ? {} : { oneOf }),
    ...(anyOf === undefined ? {} : { anyOf }),
    ...(allOf === undefined ? {} : { allOf }),
    ...(not === undefined ? {} : { not }),
    ...(optionalNumber(raw, 'minimum', specRoot, relativePath, `${path}.minimum`) === undefined
      ? {}
      : { minimum: raw['minimum'] as number }),
    ...(optionalNumber(raw, 'maximum', specRoot, relativePath, `${path}.maximum`) === undefined
      ? {}
      : { maximum: raw['maximum'] as number }),
    ...(raw['exclusiveMinimum'] === undefined ? {} : { exclusiveMinimum: asExclusiveBound(raw['exclusiveMinimum'], specRoot, relativePath, `${path}.exclusiveMinimum`) }),
    ...(raw['exclusiveMaximum'] === undefined ? {} : { exclusiveMaximum: asExclusiveBound(raw['exclusiveMaximum'], specRoot, relativePath, `${path}.exclusiveMaximum`) }),
    ...(optionalNonNegativeInteger(raw, 'minLength', specRoot, relativePath, `${path}.minLength`) === undefined
      ? {}
      : { minLength: raw['minLength'] as number }),
    ...(optionalNonNegativeInteger(raw, 'maxLength', specRoot, relativePath, `${path}.maxLength`) === undefined
      ? {}
      : { maxLength: raw['maxLength'] as number }),
    ...(optionalNonNegativeInteger(raw, 'minItems', specRoot, relativePath, `${path}.minItems`) === undefined
      ? {}
      : { minItems: raw['minItems'] as number }),
    ...(optionalNonNegativeInteger(raw, 'maxItems', specRoot, relativePath, `${path}.maxItems`) === undefined
      ? {}
      : { maxItems: raw['maxItems'] as number }),
    ...(optionalBoolean(raw, 'uniqueItems', specRoot, relativePath, `${path}.uniqueItems`) === undefined
      ? {}
      : { uniqueItems: raw['uniqueItems'] as boolean }),
    ...(optionalNonNegativeInteger(raw, 'minProperties', specRoot, relativePath, `${path}.minProperties`) === undefined
      ? {}
      : { minProperties: raw['minProperties'] as number }),
    ...(optionalNonNegativeInteger(raw, 'maxProperties', specRoot, relativePath, `${path}.maxProperties`) === undefined
      ? {}
      : { maxProperties: raw['maxProperties'] as number }),
    ...(optionalString(raw, 'pattern', specRoot, relativePath, `${path}.pattern`) === undefined
      ? {}
      : { pattern: raw['pattern'] as string }),
    ...(optionalString(raw, 'format', specRoot, relativePath, `${path}.format`) === undefined
      ? {}
      : { format: raw['format'] as string }),
    ...(raw['default'] === undefined ? {} : { default: raw['default'] }),
    ...(optionalString(raw, 'description', specRoot, relativePath, `${path}.description`) === undefined
      ? {}
      : { description: raw['description'] as string }),
    ...(optionalString(raw, 'title', specRoot, relativePath, `${path}.title`) === undefined
      ? {}
      : { title: raw['title'] as string }),
    ...(optionalBoolean(raw, 'writeOnly', specRoot, relativePath, `${path}.writeOnly`) === undefined
      ? {}
      : { writeOnly: raw['writeOnly'] as boolean }),
    ...(optionalBoolean(raw, 'readOnly', specRoot, relativePath, `${path}.readOnly`) === undefined
      ? {}
      : { readOnly: raw['readOnly'] as boolean }),
    ...(optionalBoolean(raw, 'nullable', specRoot, relativePath, `${path}.nullable`) === undefined
      ? {}
      : { nullable: raw['nullable'] as boolean }),
  });
}

function parseJsonSchemaType(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): SpecJsonSchemaType | readonly SpecJsonSchemaType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    if (!isEnumMember(value, SPEC_JSON_SCHEMA_TYPES)) {
      failInvalidDocument(specRoot, relativePath, `${path} ${value} is not a JSON Schema type.`);
    }
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    for (const entry of value) {
      if (!isEnumMember(entry, SPEC_JSON_SCHEMA_TYPES)) {
        failInvalidDocument(specRoot, relativePath, `${path} contains unknown type ${String(entry)}.`);
      }
    }
    return Object.freeze([...value]) as readonly SpecJsonSchemaType[];
  }
  failInvalidDocument(specRoot, relativePath, `${path} must be a type or type array.`);
}

function parseJsonSchemaProperties(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  depth: number,
): Readonly<Record<string, SpecJsonSchema>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = asObject(value, specRoot, relativePath, path);
  const properties: Record<string, SpecJsonSchema> = {};
  for (const [name, schema] of Object.entries(raw)) {
    properties[name] = parseJsonSchema(schema, specRoot, relativePath, `${path}.${name}`, depth + 1);
  }
  return Object.freeze(properties);
}

function parseJsonSchemaItems(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  depth: number,
): SpecJsonSchema | readonly SpecJsonSchema[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => parseJsonSchema(entry, specRoot, relativePath, `${path}[${index}]`, depth + 1)));
  }
  return parseJsonSchema(value, specRoot, relativePath, path, depth + 1);
}

function parseJsonSchemaArray(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  depth: number,
): readonly SpecJsonSchema[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a non-empty array.`);
  }
  return Object.freeze(value.map((entry, index) => parseJsonSchema(entry, specRoot, relativePath, `${path}[${index}]`, depth + 1)));
}

function parseAdditionalProperties(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  depth: number,
): boolean | SpecJsonSchema | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return parseJsonSchema(value, specRoot, relativePath, path, depth + 1);
}

function asExclusiveBound(value: unknown, specRoot: string, relativePath: string, path: string): number | boolean {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  failInvalidDocument(specRoot, relativePath, `${path} must be a boolean or number.`);
}

function parseDriver(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
  options: { readonly requireKind?: SpecDriverKind; readonly inherit?: SpecDriver } = {},
): SpecDriver {
  if (value === undefined) {
    if (options.inherit !== undefined) {
      return options.inherit;
    }
    failInvalidDocument(specRoot, relativePath, `${path} is required.`);
  }
  const raw = asObject(value, specRoot, relativePath, path);
  const kind = requiredEnum(raw, 'kind', SPEC_DRIVER_KINDS, specRoot, relativePath, `${path}.kind`) as SpecDriverKind;
  if (options.requireKind !== undefined && kind !== options.requireKind) {
    failInvalidDocument(specRoot, relativePath, `${path}.kind must be ${options.requireKind}.`);
  }
  const transport = optionalEnum(raw, 'transport', SPEC_TRANSPORTS, specRoot, relativePath, `${path}.transport`);
  const authentication = optionalEnum(
    raw,
    'authentication',
    SPEC_AUTHENTICATIONS,
    specRoot,
    relativePath,
    `${path}.authentication`,
  );
  const plugin = optionalString(raw, 'plugin', specRoot, relativePath, `${path}.plugin`);
  if (plugin !== undefined && kind === 'joomla-api' && !PLUGIN_PATTERN.test(plugin)) {
    failInvalidDocument(specRoot, relativePath, `${path}.plugin ${plugin} is not a webservices plugin id.`);
  }
  const responseShape = optionalEnum(
    raw,
    'responseShape',
    SPEC_RESPONSE_SHAPES,
    specRoot,
    relativePath,
    `${path}.responseShape`,
  );
  const mutationBody = optionalEnum(
    raw,
    'mutationBody',
    SPEC_MUTATION_BODIES,
    specRoot,
    relativePath,
    `${path}.mutationBody`,
  );
  if (kind === 'joomla-api' && transport !== undefined && transport !== 'https') {
    failInvalidDocument(specRoot, relativePath, `${path}.transport for joomla-api must be https.`);
  }
  if (kind === 'joomla-companion' && transport !== undefined && transport !== 'stdio-cli') {
    failInvalidDocument(specRoot, relativePath, `${path}.transport for joomla-companion must be stdio-cli.`);
  }

  return Object.freeze({
    kind,
    ...(transport === undefined ? {} : { transport: transport as SpecTransport }),
    ...(authentication === undefined ? {} : { authentication: authentication as SpecAuthentication }),
    ...(plugin === undefined ? {} : { plugin }),
    ...(responseShape === undefined ? {} : { responseShape: responseShape as SpecResponseShape }),
    ...(mutationBody === undefined ? {} : { mutationBody: mutationBody as SpecMutationBody }),
  });
}

function parseSource(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): SpecSourceReference {
  const raw = asObject(value, specRoot, relativePath, path);
  const repository = requiredString(raw, 'repository', specRoot, relativePath, `${path}.repository`);
  if (repository !== 'joomla/joomla-cms') {
    failInvalidDocument(specRoot, relativePath, `${path}.repository must be joomla/joomla-cms.`);
  }
  const branch = requiredString(raw, 'branch', specRoot, relativePath, `${path}.branch`);
  if (branch !== '6.1-dev') {
    failInvalidDocument(specRoot, relativePath, `${path}.branch must be 6.1-dev for this implementation.`);
  }
  const commit = requiredString(raw, 'commit', specRoot, relativePath, `${path}.commit`);
  if (!COMMIT_PATTERN.test(commit)) {
    failInvalidDocument(specRoot, relativePath, `${path}.commit is not a 40-character git commit.`);
  }
  const sourcePath = requiredString(raw, 'path', specRoot, relativePath, `${path}.path`);
  if (!SOURCE_PATH_PATTERN.test(sourcePath)) {
    failInvalidDocument(specRoot, relativePath, `${path}.path is not a Joomla webservices plugin path.`);
  }
  const registration = optionalEnum(
    raw,
    'registration',
    SPEC_SOURCE_REGISTRATIONS,
    specRoot,
    relativePath,
    `${path}.registration`,
  );
  return Object.freeze({
    repository,
    branch,
    commit,
    path: sourcePath,
    ...(registration === undefined ? {} : { registration: registration as SpecSourceRegistration }),
  });
}

function loadOptionalPublicTools(specRoot: string): SpecPublicToolsDocument | undefined {
  const relativePath = SPEC_PUBLIC_TOOLS_DOCUMENT;
  if (!existsSync(join(specRoot, relativePath))) {
    return undefined;
  }
  return parsePublicToolsDocument(specRoot, relativePath);
}

export function loadPublicToolsDocument(specRoot: string): SpecPublicToolsDocument {
  const resolved = isAbsolute(specRoot) ? specRoot : resolve(process.cwd(), specRoot);
  const relativePath = SPEC_PUBLIC_TOOLS_DOCUMENT;
  if (!existsSync(join(resolved, relativePath))) {
    failMissingFile(resolved, relativePath);
  }
  return parsePublicToolsDocument(resolved, relativePath);
}

function parsePublicToolsDocument(specRoot: string, relativePath: string): SpecPublicToolsDocument {
  const raw = readJsonObject(specRoot, relativePath);
  const description = requiredString(raw, 'description', specRoot, relativePath);
  const toolsRaw = raw['tools'];
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
    failInvalidDocument(specRoot, relativePath, 'tools must be a non-empty array.');
  }
  const tools: SpecPublicTool[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of toolsRaw.entries()) {
    const record = asObject(entry, specRoot, relativePath, `tools[${index}]`);
    const name = requiredString(record, 'name', specRoot, relativePath, `tools[${index}].name`);
    if (!/^joomla_[a-z0-9_]+$/.test(name)) {
      failInvalidDocument(specRoot, relativePath, `tools[${index}].name ${name} is not a joomla_* tool id.`);
    }
    if (seen.has(name)) {
      failInvalidDocument(specRoot, relativePath, `duplicate public tool ${name}.`);
    }
    const category = requiredEnum(
      record,
      'category',
      SPEC_PUBLIC_TOOL_CATEGORIES,
      specRoot,
      relativePath,
      `tools[${index}].category`,
    ) as SpecPublicToolCategory;
    const write = record['write'];
    if (typeof write !== 'boolean') {
      failInvalidDocument(specRoot, relativePath, `tools[${index}].write must be a boolean.`);
    }
    if ((category === 'write') !== write) {
      failInvalidDocument(specRoot, relativePath, `tools[${index}] category/write pairing is inconsistent.`);
    }
    seen.add(name);
    tools.push(Object.freeze({ name, category, write }));
  }
  const notes = optionalStringArray(raw, 'notes', specRoot, relativePath);
  return freezeJson({
    description,
    tools: Object.freeze(tools),
    ...(notes === undefined ? {} : { notes: Object.freeze([...notes]) }),
  });
}

function assertOperationMethod(
  operation: SpecOperation,
  method: SpecHttpMethod,
  specRoot: string,
  relativePath: string,
  path: string,
): void {
  const expected: Partial<Record<SpecOperation, SpecHttpMethod>> = {
    list: 'GET',
    get: 'GET',
    export: 'GET',
    healthcheck: 'GET',
    status: 'GET',
    create: 'POST',
    update: 'PATCH',
    delete: 'DELETE',
    state: 'PATCH',
    run: 'POST',
  };
  if (expected[operation] !== undefined && expected[operation] !== method) {
    failInvalidDocument(specRoot, relativePath, `${path} operation ${operation} cannot use method ${method}.`);
  }
}

function assertOperationRisk(
  operation: SpecOperation,
  risk: SpecRisk,
  specRoot: string,
  relativePath: string,
  path: string,
): void {
  if ((operation === 'list' || operation === 'get' || operation === 'export' || operation === 'healthcheck' || operation === 'status')
    && risk !== 'read' && risk !== 'sensitive-read') {
    failInvalidDocument(specRoot, relativePath, `${path} read operation cannot have risk ${risk}.`);
  }
  if ((operation === 'create' || operation === 'update' || operation === 'state' || operation === 'run') && risk !== 'write') {
    failInvalidDocument(specRoot, relativePath, `${path} mutating operation must have risk write.`);
  }
  if (operation === 'delete' && risk !== 'destructive') {
    failInvalidDocument(specRoot, relativePath, `${path} delete operation must have risk destructive.`);
  }
}

function requiredToolset(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  toolsetIds: ReadonlySet<string>,
  path = key,
): string {
  const value = requiredString(raw, key, specRoot, relativePath, path);
  if (!toolsetIds.has(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} ${value} is not declared in catalog/toolsets.json.`);
  }
  return value;
}

function readJsonObject(specRoot: string, relativePath: string): Readonly<Record<string, unknown>> {
  const absolute = join(specRoot, relativePath);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (cause) {
    failClosed('spec-file-unreadable', `Unable to read ${relativePath}.`, { specPath: specRoot, cause, detail: { relativePath } });
  }
  if (text.trim().length === 0) {
    failInvalidDocument(specRoot, relativePath, 'file is empty.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    failClosed('spec-json-invalid', `${relativePath} is not valid JSON.`, { specPath: specRoot, cause, detail: { relativePath } });
  }
  return asObject(parsed, specRoot, relativePath, '(root)');
}

function asObject(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be an object.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requiredString(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a non-empty string when present.`);
  }
  return value;
}

function requiredStringArray(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): readonly string[] {
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be an array of non-empty strings.`);
  }
  return value;
}

function optionalStringArray(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): readonly string[] | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be an array of non-empty strings.`);
  }
  return value;
}

function optionalBoolean(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): boolean | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    failInvalidDocument(specRoot, relativePath, `${path} must be a boolean.`);
  }
  return value;
}

function optionalNumber(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): number | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a finite number.`);
  }
  return value;
}

function optionalPositiveInteger(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): number | undefined {
  const value = optionalNumber(raw, key, specRoot, relativePath, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  specRoot: string,
  relativePath: string,
  path = key,
): number | undefined {
  const value = optionalNumber(raw, key, specRoot, relativePath, path);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    failInvalidDocument(specRoot, relativePath, `${path} must be a non-negative integer.`);
  }
  return value;
}

function optionalStringNumberRecord(
  value: unknown,
  specRoot: string,
  relativePath: string,
  path: string,
): Readonly<Record<string, string | number>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = asObject(value, specRoot, relativePath, path);
  const result: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      failInvalidDocument(specRoot, relativePath, `${path}.${key} must be a string or number.`);
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      failInvalidDocument(specRoot, relativePath, `${path}.${key} must be finite.`);
    }
    result[key] = entry;
  }
  return Object.freeze(result);
}

function requiredEnum(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly string[],
  specRoot: string,
  relativePath: string,
  path = key,
): string {
  const value = requiredString(raw, key, specRoot, relativePath, path);
  if (!allowed.includes(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} ${value} is not one of ${allowed.join(', ')}.`);
  }
  return value;
}

function optionalEnum(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly string[],
  specRoot: string,
  relativePath: string,
  path = key,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    failInvalidDocument(specRoot, relativePath, `${path} must be one of ${allowed.join(', ')}.`);
  }
  return value;
}

function isEnumMember<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      extra.push(value);
    }
    seen.add(value);
  }
  return extra;
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) {
        freezeJson(item);
      }
    } else {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        freezeJson(nested);
      }
    }
    Object.freeze(value);
  }
  return value;
}
