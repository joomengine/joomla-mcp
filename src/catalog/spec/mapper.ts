import type { Toolset } from '../../config/schema.js';
import type {
  CrudBaseDescriptor,
  CrudOperationDescriptor,
  JoomlaActionDescriptor,
  JoomlaApiDriverMetadata,
  JoomlaSourceReference,
  JoomlaVersionMetadata,
  JsonSchema,
  ReadActionDescriptor,
  RouteParameterDescriptor,
  WriteActionDescriptor,
} from '../../contracts/action-catalog.js';
import { acl, joomla6xVersions } from '../source-metadata.js';
import { failClosed } from './errors.js';
import {
  SPEC_GATE_ACTION_IDS,
  type LoadedSpecCatalog,
  type MappedSpecCatalog,
  type MappedSpecFamily,
  type SpecActionDescriptor,
  type SpecDriver,
  type SpecFamilyBase,
  type SpecFamilyDocument,
  type SpecJsonSchema,
  type SpecPublicToolsDocument,
  type SpecRouteParameter,
  type SpecSourceReference,
} from './types.js';

const READ_OPERATIONS = new Set(['list', 'get', 'export', 'healthcheck', 'status']);
const WRITE_OPERATIONS = new Set(['create', 'update', 'delete']);
const ROUTE_PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const LIST_FILTER_QUERY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  search: 'filter[search]',
  state: 'filter[state]',
  published: 'filter[published]',
  featured: 'filter[featured]',
  category: 'filter[category]',
  catid: 'filter[catid]',
  tag: 'filter[tag]',
  language: 'filter[language]',
  access: 'filter[access]',
  level: 'filter[level]',
  parent: 'filter[parent]',
  parent_id: 'filter[parent_id]',
  client_id: 'filter[client_id]',
  author: 'filter[author]',
  checked_out: 'filter[checked_out]',
  ordering: 'list[ordering]',
  direction: 'list[direction]',
  status: 'filter[status]',
  type: 'filter[type]',
  core: 'filter[core]',
  extension: 'filter[extension]',
  context: 'filter[context]',
  menutype: 'filter[menutype]',
  position: 'filter[position]',
  module: 'filter[module]',
  home: 'filter[home]',
  filter: 'filter[filter]',
});

export interface FallbackCatalog {
  readonly crudBases: readonly CrudBaseDescriptor[];
  readonly readActions: readonly ReadActionDescriptor[];
  readonly writeActions: readonly WriteActionDescriptor[];
  readonly writeFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sensitiveWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sourceOnlyGates: Readonly<Record<string, string>>;
}

export function mapSpecCatalog(loaded: LoadedSpecCatalog): MappedSpecCatalog {
  const versions = versionsFromMeta(loaded);
  const families = loaded.families.map((family) => mapFamily(family.document, family.relativePath, versions, loaded));
  const crudBases = Object.freeze(families.map((family) => family.base));
  const readActions = Object.freeze(families.flatMap((family) => family.readActions));
  const writeActions = Object.freeze(families.flatMap((family) => family.writeActions));
  const writeFieldsByBaseId: Record<string, readonly string[]> = {};
  const sensitiveWriteFieldsByBaseId: Record<string, readonly string[]> = {};
  for (const [baseId, allowlist] of Object.entries(loaded.writeFields.bases)) {
    writeFieldsByBaseId[baseId] = allowlist.fields;
    if (allowlist.sensitive.length > 0) {
      sensitiveWriteFieldsByBaseId[baseId] = allowlist.sensitive;
    }
  }

  return Object.freeze({
    specRoot: loaded.specRoot,
    meta: loaded.meta,
    toolsets: loaded.toolsets.toolsets,
    writeFieldsByBaseId: Object.freeze(writeFieldsByBaseId),
    sensitiveWriteFieldsByBaseId: Object.freeze(sensitiveWriteFieldsByBaseId),
    sourceOnlyGates: mapSourceOnlyGates(loaded),
    families: Object.freeze(families),
    crudBases,
    readActions,
    writeActions,
    actions: Object.freeze([...readActions, ...writeActions]),
    ...(loaded.publicTools === undefined ? {} : { publicTools: loaded.publicTools }),
  });
}

export function overlaySpecCatalog(
  mapped: MappedSpecCatalog,
  fallback: FallbackCatalog,
  loaded: LoadedSpecCatalog | undefined,
): {
  readonly crudBases: readonly CrudBaseDescriptor[];
  readonly readActions: readonly ReadActionDescriptor[];
  readonly writeActions: readonly WriteActionDescriptor[];
  readonly actions: readonly JoomlaActionDescriptor[];
  readonly writeFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sensitiveWriteFieldsByBaseId: Readonly<Record<string, readonly string[]>>;
  readonly sourceOnlyGates: Readonly<Record<string, string>>;
  readonly publicTools: SpecPublicToolsDocument | undefined;
} {
  const specBases = new Map(mapped.crudBases.map((base) => [base.id, base]));
  const specReads = new Map(mapped.readActions.map((action) => [action.id, action]));
  const specWrites = new Map(mapped.writeActions.map((action) => [action.id, action]));

  const crudBases = Object.freeze([
    ...fallback.crudBases.map((base) => specBases.get(base.id) ?? base),
    ...mapped.crudBases.filter((base) => fallback.crudBases.every((candidate) => candidate.id !== base.id)),
  ]);
  const readActions = Object.freeze([
    ...fallback.readActions.map((action) => specReads.get(action.id) ?? action),
    ...mapped.readActions.filter((action) => fallback.readActions.every((candidate) => candidate.id !== action.id)),
  ]);
  const writeActions = Object.freeze([
    ...fallback.writeActions.map((action) => specWrites.get(action.id) ?? action),
    ...mapped.writeActions.filter((action) => fallback.writeActions.every((candidate) => candidate.id !== action.id)),
  ]);

  return Object.freeze({
    crudBases,
    readActions,
    writeActions,
    actions: Object.freeze([...readActions, ...writeActions]),
    writeFieldsByBaseId: Object.freeze({
      ...fallback.writeFieldsByBaseId,
      ...mapped.writeFieldsByBaseId,
    }),
    sensitiveWriteFieldsByBaseId: Object.freeze({
      ...fallback.sensitiveWriteFieldsByBaseId,
      ...mapped.sensitiveWriteFieldsByBaseId,
    }),
    sourceOnlyGates: Object.freeze({
      ...fallback.sourceOnlyGates,
      ...mapped.sourceOnlyGates,
    }),
    publicTools: mapped.publicTools ?? loaded?.publicTools,
  });
}

export function mapFamily(
  document: SpecFamilyDocument,
  relativePath: string,
  versions: JoomlaVersionMetadata,
  loaded: LoadedSpecCatalog,
): MappedSpecFamily {
  const base = mapFamilyBase(document.base, document.actions, versions);
  const readActions = Object.freeze(
    document.actions
      .filter((action) => READ_OPERATIONS.has(action.operation))
      .map((action) => mapReadAction(action, document.base, base, versions)),
  );
  const writeActions = Object.freeze(
    document.actions
      .filter((action) => WRITE_OPERATIONS.has(action.operation))
      .map((action) => mapWriteAction(action, document.base, base, versions, loaded)),
  );

  if (readActions.length + writeActions.length === 0) {
    failClosed(
      'spec-family-incomplete',
      `Spec family ${document.base.id} did not map to any runtime actions.`,
      { specPath: loaded.specRoot, detail: { relativePath, familyId: document.base.id } },
    );
  }

  return Object.freeze({
    familyId: document.base.id,
    relativePath,
    base,
    readActions,
    writeActions,
  });
}

export function convertSpecRouteTemplate(routeTemplate: string): `v1/${string}` {
  const converted = routeTemplate.replace(ROUTE_PLACEHOLDER, ':$1');
  if (!converted.startsWith('v1/')) {
    failClosed('spec-route-invalid', `Spec route template ${routeTemplate} is not a Joomla v1 path.`);
  }
  return converted as `v1/${string}`;
}

export function mapSpecListQueryFilters(
  values: Readonly<Record<string, unknown>>,
  schemaProperties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  routeParameterNames: ReadonlySet<string>,
): Readonly<Record<string, string | number>> {
  const query: Record<string, string | number> = {};
  for (const key of Object.keys(schemaProperties)) {
    if (key === 'offset' || key === 'limit' || key === 'id' || key === 'etag' || key === 'data' || routeParameterNames.has(key)) {
      continue;
    }
    if (!(key in values)) {
      continue;
    }
    const encoded = encodeFilterValue(values[key]);
    if (encoded === undefined) {
      continue;
    }
    query[queryKeyForFilter(key)] = encoded;
  }
  return Object.freeze(query);
}

export function queryKeyForFilter(field: string): string {
  return LIST_FILTER_QUERY_KEYS[field] ?? `filter[${field}]`;
}

function mapFamilyBase(
  family: SpecFamilyBase,
  actions: readonly SpecActionDescriptor[],
  versions: JoomlaVersionMetadata,
): CrudBaseDescriptor {
  const itemAction = actions.find((action) => action.operation === 'get' || action.operation === 'update' || action.operation === 'delete');
  const routeParameter = mapRouteParameter(itemAction?.routeParameters?.[0] ?? defaultIdParameter());
  const controllerDefaults = Object.freeze({
    component: family.component,
    ...(family.defaults ?? {}),
    ...(family.controllerDefaults ?? {}),
  });
  const mutationPhase = family.toolsetRead === 'users.read' || family.toolsetWrite === 'users.admin' ? 6 : 4;

  return Object.freeze({
    id: family.id,
    domain: family.domain,
    resource: family.resource,
    collectionName: family.collectionName,
    itemName: family.itemName,
    basePath: convertSpecRouteTemplate(family.basePath),
    controller: family.controller,
    controllerDefaults,
    toolset: asToolset(family.toolsetRead, `family ${family.id} toolsetRead`),
    routeParameter,
    operations: crudOperationsFromActions(actions, mutationPhase),
    deleteSemantics: family.deleteSemantics ?? 'resource-model-defined',
    acl: acl(asComponent(family.component)),
    driver: mapApiDriver(family.driver, family.id, 'flat-joomla-form-json'),
    versions,
    source: mapSource(family.source, family.id),
  });
}

function crudOperationsFromActions(
  actions: readonly SpecActionDescriptor[],
  mutationPhase: 4 | 6,
): readonly CrudOperationDescriptor[] {
  const byName = new Map(actions.map((action) => [action.operation, action]));
  const descriptors: CrudOperationDescriptor[] = [];
  const list = byName.get('list');
  const get = byName.get('get');
  const create = byName.get('create');
  const update = byName.get('update');
  const remove = byName.get('delete');
  if (list) {
    descriptors.push(Object.freeze({
      name: 'list', method: 'GET', route: 'collection', risk: list.risk === 'sensitive-read' ? 'read' : 'read', deliveryPhase: 2,
    }));
  }
  if (get) {
    descriptors.push(Object.freeze({
      name: 'get', method: 'GET', route: 'item', risk: 'read', deliveryPhase: 2,
    }));
  }
  if (create) {
    descriptors.push(Object.freeze({
      name: 'create', method: 'POST', route: 'collection', risk: 'write', deliveryPhase: mutationPhase,
    }));
  }
  if (update) {
    descriptors.push(Object.freeze({
      name: 'update', method: 'PATCH', route: 'item', risk: 'write', deliveryPhase: mutationPhase,
    }));
  }
  if (remove) {
    descriptors.push(Object.freeze({
      name: 'delete', method: 'DELETE', route: 'item', risk: 'destructive', deliveryPhase: mutationPhase,
    }));
  }
  return Object.freeze(descriptors);
}

function mapReadAction(
  action: SpecActionDescriptor,
  family: SpecFamilyBase,
  base: CrudBaseDescriptor,
  versions: JoomlaVersionMetadata,
): ReadActionDescriptor {
  if (action.method !== 'GET') {
    failClosed('spec-read-method', `Spec read action ${action.id} must use GET.`);
  }
  const operation = action.operation;
  if (operation !== 'list' && operation !== 'get' && operation !== 'export' && operation !== 'healthcheck' && operation !== 'status') {
    failClosed('spec-read-operation', `Spec action ${action.id} operation ${operation} is not a read.`);
  }
  const risk = action.risk === 'sensitive-read' ? 'sensitive-read' : 'read';
  const driver = mapApiDriver(action.driver ?? family.driver, action.id, 'not-applicable');

  return Object.freeze({
    id: action.id,
    title: action.title,
    description: action.description,
    domain: action.domain,
    operation,
    method: 'GET',
    routeTemplate: convertSpecRouteTemplate(action.routeTemplate),
    routeParameters: Object.freeze((action.routeParameters ?? []).map(mapRouteParameter)),
    paginated: action.paginated === true,
    inputSchema: mapReadInputSchema(action),
    toolset: asToolset(action.toolset, action.id),
    risk,
    sideEffect: action.sideEffect === true,
    acl: base.acl,
    driver,
    versions,
    source: mapSource(action.source ?? family.source, action.id),
  });
}

function mapWriteAction(
  action: SpecActionDescriptor,
  family: SpecFamilyBase,
  base: CrudBaseDescriptor,
  versions: JoomlaVersionMetadata,
  loaded: LoadedSpecCatalog,
): WriteActionDescriptor {
  if (action.method !== 'POST' && action.method !== 'PATCH' && action.method !== 'DELETE') {
    failClosed('spec-write-method', `Spec write action ${action.id} must use POST, PATCH, or DELETE.`);
  }
  const operation = action.operation;
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
    failClosed('spec-write-operation', `Spec action ${action.id} operation ${operation} is not a write.`);
  }
  const risk = operation === 'delete' ? 'destructive' : 'write';
  const allowlist = loaded.writeFields.bases[family.id];
  const writeFields = action.writeFields ?? allowlist?.fields ?? [];
  const sensitive = new Set(allowlist?.sensitive ?? []);
  const bodyPolicy = action.bodyPolicy ?? (operation === 'delete' ? 'none' : 'required');

  return Object.freeze({
    id: action.id,
    title: action.title,
    description: action.description,
    domain: action.domain,
    operation,
    method: action.method,
    routeTemplate: convertSpecRouteTemplate(action.routeTemplate),
    routeParameters: Object.freeze((action.routeParameters ?? []).map(mapRouteParameter)),
    bodyPolicy,
    inputSchema: mapWriteInputSchema(action, writeFields, sensitive, bodyPolicy),
    toolset: asToolset(action.toolset, action.id),
    risk,
    acl: base.acl,
    driver: mapApiDriver(action.driver ?? family.driver, action.id, operation === 'delete' ? 'not-applicable' : 'flat-joomla-form-json'),
    versions,
    source: mapSource(action.source ?? family.source, action.id),
  });
}

function mapReadInputSchema(action: SpecActionDescriptor): JsonSchema {
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [name, schema] of Object.entries(action.inputSchema.properties ?? {})) {
    properties[name] = jsonSchemaToRecord(schema);
  }
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    ...(action.inputSchema.required === undefined ? {} : { required: Object.freeze([...action.inputSchema.required]) }),
    additionalProperties: false,
  });
}

function mapWriteInputSchema(
  action: SpecActionDescriptor,
  writeFields: readonly string[],
  sensitive: ReadonlySet<string>,
  bodyPolicy: WriteActionDescriptor['bodyPolicy'],
): JsonSchema {
  const specProperties = action.inputSchema.properties ?? {};
  const routeNames = new Set((action.routeParameters ?? []).map((parameter) => parameter.name));
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};

  for (const parameter of action.routeParameters ?? []) {
    const existing = specProperties[parameter.name];
    properties[parameter.name] = existing === undefined
      ? Object.freeze({
        type: 'integer',
        minimum: 1,
        description: 'Positive Joomla resource identifier.',
      })
      : jsonSchemaToRecord(existing);
  }

  if (action.operation !== 'delete' && bodyPolicy !== 'none') {
    const dataProperties: Record<string, Readonly<Record<string, unknown>>> = {};
    const fieldNames = writeFields.length > 0 ? writeFields : Object.keys(specProperties).filter((name) => {
      return name !== 'id' && name !== 'etag' && !routeNames.has(name);
    });
    for (const field of fieldNames) {
      const existing = specProperties[field];
      const extra = sensitive.has(field) ? { writeOnly: true as const } : {};
      dataProperties[field] = existing === undefined
        ? Object.freeze({
          description: `Reviewed Joomla form field ${field}.`,
          ...extra,
        })
        : Object.freeze({ ...jsonSchemaToRecord(existing), ...extra });
    }
    const nestedRequired = (action.inputSchema.required ?? []).filter((name) => {
      return name !== 'id' && name !== 'etag' && !routeNames.has(name);
    });
    properties['data'] = Object.freeze({
      type: 'object',
      minProperties: 1,
      maxProperties: 512,
      properties: Object.freeze(dataProperties),
      additionalProperties: false,
      ...(nestedRequired.length === 0 ? {} : { required: Object.freeze(nestedRequired) }),
      description: 'Allowlisted Joomla form JSON. Joomla validates resource-specific values and ACL.',
    });
  }

  if (action.operation !== 'create') {
    const etag = specProperties['etag'];
    properties['etag'] = etag === undefined
      ? Object.freeze({
        type: 'string',
        maxLength: 512,
        description: 'Optional HTTP entity tag used as an If-Match precondition.',
      })
      : jsonSchemaToRecord(etag);
  }

  const required = [
    ...[...routeNames],
    ...(action.operation === 'delete' || bodyPolicy === 'none' ? [] : ['data']),
  ];

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: false,
  });
}

function jsonSchemaToRecord(schema: SpecJsonSchema): Readonly<Record<string, unknown>> {
  const record: Record<string, unknown> = {};
  if (schema.type !== undefined) record['type'] = schema.type;
  if (schema.properties !== undefined) {
    record['properties'] = Object.freeze(
      Object.fromEntries(Object.entries(schema.properties).map(([name, nested]) => [name, jsonSchemaToRecord(nested)])),
    );
  }
  if (schema.items !== undefined) {
    const items = schema.items;
    record['items'] = Array.isArray(items)
      ? Object.freeze((items as readonly SpecJsonSchema[]).map(jsonSchemaToRecord))
      : jsonSchemaToRecord(items as SpecJsonSchema);
  }
  if (schema.required !== undefined) record['required'] = Object.freeze([...schema.required]);
  if (schema.additionalProperties !== undefined) {
    record['additionalProperties'] = typeof schema.additionalProperties === 'boolean'
      ? schema.additionalProperties
      : jsonSchemaToRecord(schema.additionalProperties);
  }
  if (schema.enum !== undefined) record['enum'] = Object.freeze([...schema.enum]);
  if (schema.const !== undefined) record['const'] = schema.const;
  if (schema.oneOf !== undefined) record['oneOf'] = Object.freeze(schema.oneOf.map(jsonSchemaToRecord));
  if (schema.anyOf !== undefined) record['anyOf'] = Object.freeze(schema.anyOf.map(jsonSchemaToRecord));
  if (schema.allOf !== undefined) record['allOf'] = Object.freeze(schema.allOf.map(jsonSchemaToRecord));
  if (schema.not !== undefined) record['not'] = jsonSchemaToRecord(schema.not);
  if (schema.minimum !== undefined) record['minimum'] = schema.minimum;
  if (schema.maximum !== undefined) record['maximum'] = schema.maximum;
  if (schema.exclusiveMinimum !== undefined) record['exclusiveMinimum'] = schema.exclusiveMinimum;
  if (schema.exclusiveMaximum !== undefined) record['exclusiveMaximum'] = schema.exclusiveMaximum;
  if (schema.minLength !== undefined) record['minLength'] = schema.minLength;
  if (schema.maxLength !== undefined) record['maxLength'] = schema.maxLength;
  if (schema.minItems !== undefined) record['minItems'] = schema.minItems;
  if (schema.maxItems !== undefined) record['maxItems'] = schema.maxItems;
  if (schema.uniqueItems !== undefined) record['uniqueItems'] = schema.uniqueItems;
  if (schema.minProperties !== undefined) record['minProperties'] = schema.minProperties;
  if (schema.maxProperties !== undefined) record['maxProperties'] = schema.maxProperties;
  if (schema.pattern !== undefined) record['pattern'] = schema.pattern;
  if (schema.format !== undefined) record['format'] = schema.format;
  if (schema.default !== undefined) record['default'] = schema.default;
  if (schema.description !== undefined) record['description'] = schema.description;
  if (schema.title !== undefined) record['title'] = schema.title;
  if (schema.writeOnly !== undefined) record['writeOnly'] = schema.writeOnly;
  if (schema.readOnly !== undefined) record['readOnly'] = schema.readOnly;
  if (schema.nullable !== undefined) record['nullable'] = schema.nullable;
  return Object.freeze(record);
}

function mapRouteParameter(parameter: SpecRouteParameter): RouteParameterDescriptor {
  return Object.freeze({
    name: parameter.name,
    kind: parameter.kind,
    required: true as const,
    ...(parameter.maximumLength === undefined ? {} : { maximumLength: parameter.maximumLength }),
  });
}

function defaultIdParameter(): SpecRouteParameter {
  return Object.freeze({ name: 'id', kind: 'positive-integer', required: true, maximumLength: 16 });
}

function mapApiDriver(
  driver: SpecDriver,
  owner: string,
  mutationBody: JoomlaApiDriverMetadata['mutationBody'],
): JoomlaApiDriverMetadata {
  if (driver.kind !== 'joomla-api') {
    failClosed('spec-driver-kind', `Spec ${owner} driver.kind must be joomla-api to map into the TypeScript catalogue.`);
  }
  const plugin = driver.plugin;
  if (plugin === undefined || !plugin.startsWith('webservices/')) {
    failClosed('spec-driver-plugin', `Spec ${owner} driver.plugin must be a webservices/* identifier.`);
  }
  const authentication = driver.authentication ?? 'joomla-api-token';
  if (authentication !== 'joomla-api-token' && authentication !== 'joomla-update-token') {
    failClosed('spec-driver-authentication', `Spec ${owner} authentication ${authentication} is not a Joomla API token kind.`);
  }

  return Object.freeze({
    kind: 'joomla-api',
    transport: 'https',
    authentication,
    plugin: plugin as `webservices/${string}`,
    responseShape: driver.responseShape === 'joomla-json' ? 'joomla-json' : 'json-api',
    mutationBody: driver.mutationBody ?? mutationBody,
  });
}

function mapSource(source: SpecSourceReference, owner: string): JoomlaSourceReference {
  if (source.repository !== 'joomla/joomla-cms') {
    failClosed('spec-source-repository', `Spec ${owner} source.repository must be joomla/joomla-cms.`);
  }
  if (source.branch !== '6.1-dev') {
    failClosed('spec-source-branch', `Spec ${owner} source.branch must be 6.1-dev.`);
  }
  const registration = source.registration === 'Route' ? 'Route' : 'createCRUDRoutes';
  const path = source.path;
  if (!path.startsWith('plugins/webservices/') || !path.endsWith('.php')) {
    failClosed('spec-source-path', `Spec ${owner} source.path is not a Joomla webservices plugin path.`);
  }

  return Object.freeze({
    repository: 'joomla/joomla-cms',
    branch: '6.1-dev',
    commit: source.commit,
    path: path as JoomlaSourceReference['path'],
    registration,
  });
}

function versionsFromMeta(loaded: LoadedSpecCatalog): JoomlaVersionMetadata {
  return Object.freeze({
    ...joomla6xVersions,
    examinedHeads: Object.freeze({
      '6.1-dev': loaded.meta.examinedHeads['6.1-dev'],
      '6.2-dev': loaded.meta.examinedHeads['6.2-dev'],
      '7.0-dev': loaded.meta.examinedHeads['7.0-dev'],
    }),
  });
}

function mapSourceOnlyGates(loaded: LoadedSpecCatalog): Readonly<Record<string, string>> {
  const gates: Record<string, string> = {};
  for (const gate of loaded.gates.gates) {
    if (gate.severity !== 'source-only') {
      continue;
    }
    const actionIds = SPEC_GATE_ACTION_IDS[gate.id] ?? [gate.id];
    for (const actionId of actionIds) {
      gates[actionId] = gate.reason;
    }
  }
  return Object.freeze(gates);
}

function asToolset(value: string, owner: string): Toolset {
  const parsed = value as Toolset;
  if (typeof parsed !== 'string' || parsed.length === 0) {
    failClosed('spec-toolset', `Spec ${owner} toolset is empty.`);
  }
  return parsed;
}

function asComponent(value: string): `com_${string}` {
  if (!value.startsWith('com_')) {
    failClosed('spec-component', `Spec component ${value} is not a com_* identifier.`);
  }
  return value as `com_${string}`;
}

function encodeFilterValue(value: unknown): string | number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return undefined;
}
