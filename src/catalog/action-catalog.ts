import type { Toolset } from '../config/schema.js';
import type {
  CrudBaseDescriptor,
  CrudOperationDescriptor,
  JoomlaActionDescriptor,
  JsonSchema,
  ReadActionDescriptor,
  ResolvedReadRequest,
  ResolvedWriteRequest,
  WriteActionDescriptor,
} from '../contracts/action-catalog.js';
import { boundedListQueryProperties, normalizeBoundedListQuery } from '../contracts/bounded-query.js';
import { resolveReadActionRoute } from '../contracts/route-resolution.js';
import { joomlaCrudBases } from './crud-bases.js';
import { crudWriteFields, sensitiveCrudWriteFieldsByBaseId } from './crud-write-fields.js';
import { joomlaSpecialReadActions } from './special-reads.js';
import { joomlaSpecialWriteActions } from './special-writes.js';

export interface ActionCatalogFilter {
  readonly toolsets?: ReadonlySet<Toolset>;
  readonly domain?: string;
  readonly text?: string;
  readonly includeSensitive?: boolean;
}

function crudReadAction(base: CrudBaseDescriptor, operation: 'list' | 'get'): ReadActionDescriptor {
  const isList = operation === 'list';
  const routeParameters = isList ? Object.freeze([]) : Object.freeze([base.routeParameter]);
  const risk = isSensitiveCrudRead(base) ? 'sensitive-read' : 'read';

  return Object.freeze({
    id: `${base.id}.${operation}`,
    title: isList ? `List ${base.collectionName}` : `Get ${base.itemName}`,
    description: isList
      ? `Lists ${base.collectionName.toLocaleLowerCase('en')} through Joomla's ${base.controller} API controller.`
      : `Gets one ${base.itemName.toLocaleLowerCase('en')} by numeric identifier.`,
    domain: base.domain,
    operation,
    method: 'GET',
    routeTemplate: isList ? base.basePath : `${base.basePath}/:id`,
    routeParameters,
    paginated: isList,
    inputSchema: crudReadInputSchema(isList),
    toolset: base.toolset,
    risk,
    sideEffect: false,
    acl: base.acl,
    driver: Object.freeze({ ...base.driver, mutationBody: 'not-applicable' }),
    versions: base.versions,
    source: base.source,
  });
}

function isSensitiveCrudRead(base: CrudBaseDescriptor): boolean {
  return base.domain === 'users' || base.domain === 'messages' || base.id === 'fields.users' || base.id === 'field-groups.users';
}

function crudReadInputSchema(list: boolean): JsonSchema {
  if (list) {
    return Object.freeze({
      type: 'object',
      properties: boundedListQueryProperties,
      additionalProperties: false,
    });
  }

  return Object.freeze({
    type: 'object',
    properties: Object.freeze({
      id: Object.freeze({ type: 'integer', minimum: 1, description: 'Positive Joomla resource identifier.' }),
    }),
    required: Object.freeze(['id']),
    additionalProperties: false,
  });
}

export const joomlaCrudReadActions: readonly ReadActionDescriptor[] = Object.freeze(
  joomlaCrudBases.flatMap((base) => [crudReadAction(base, 'list'), crudReadAction(base, 'get')]),
);

export const joomlaReadActions: readonly ReadActionDescriptor[] = Object.freeze([
  ...joomlaCrudReadActions,
  ...joomlaSpecialReadActions,
]);

function writeToolsetFor(base: CrudBaseDescriptor): Toolset {
  switch (base.toolset) {
    case 'content.read':
      return 'content.write';
    case 'structure.read':
      return 'structure.write';
    case 'users.read':
      return 'users.admin';
    case 'maintenance.read':
      return 'maintenance.admin';
    default:
      throw new Error(`CRUD base ${base.id} has no controlled write toolset mapping.`);
  }
}

function crudWriteAction(base: CrudBaseDescriptor, operation: CrudOperationDescriptor): WriteActionDescriptor {
  if (operation.name !== 'create' && operation.name !== 'update' && operation.name !== 'delete') {
    throw new Error(`Operation ${operation.name} is not a write operation.`);
  }

  const itemOperation = operation.route === 'item';
  const routeParameters = itemOperation ? Object.freeze([base.routeParameter]) : Object.freeze([]);
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};

  if (itemOperation) {
    properties[base.routeParameter.name] = Object.freeze({
      type: 'integer',
      minimum: 1,
      description: 'Positive Joomla resource identifier.',
    });
  }

  if (operation.name !== 'delete') {
    const sensitiveFields = new Set(sensitiveCrudWriteFieldsByBaseId[base.id] ?? []);
    const dataProperties = Object.fromEntries(
      crudWriteFields(base.id).map((field) => [
        field,
        Object.freeze({
          description: `Reviewed Joomla ${base.itemName.toLocaleLowerCase('en')} form field.`,
          ...(sensitiveFields.has(field) ? { type: 'string', maxLength: 4_096, writeOnly: true } : {}),
        }),
      ]),
    );
    properties['data'] = Object.freeze({
      type: 'object',
      minProperties: 1,
      maxProperties: 512,
      properties: Object.freeze(dataProperties),
      additionalProperties: false,
      description: 'Allowlisted Joomla form JSON. Joomla validates resource-specific values and ACL.',
    });
  }

  if (itemOperation) {
    properties['etag'] = Object.freeze({
      type: 'string',
      maxLength: 512,
      description: 'Optional HTTP entity tag used as an If-Match precondition.',
    });
  }

  const required = [
    ...(itemOperation ? [base.routeParameter.name] : []),
    ...(operation.name === 'delete' ? [] : ['data']),
  ];
  const titleVerb = operation.name === 'create' ? 'Create' : operation.name === 'update' ? 'Update' : 'Delete';

  return Object.freeze({
    id: `${base.id}.${operation.name}`,
    title: `${titleVerb} ${base.itemName}`,
    description: `${titleVerb}s ${base.itemName.toLocaleLowerCase('en')} through Joomla's ${base.controller} API controller.`,
    domain: base.domain,
    operation: operation.name,
    method: operation.method as WriteActionDescriptor['method'],
    routeTemplate: itemOperation ? `${base.basePath}/:id` : base.basePath,
    routeParameters,
    bodyPolicy: operation.name === 'delete' ? 'none' : 'required',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze(properties),
      required: Object.freeze(required),
      additionalProperties: false,
    }),
    toolset: writeToolsetFor(base),
    risk: operation.risk as 'write' | 'destructive',
    acl: base.acl,
    driver: base.driver,
    versions: base.versions,
    source: base.source,
  });
}

export const joomlaCrudWriteActions: readonly WriteActionDescriptor[] = Object.freeze(
  joomlaCrudBases.flatMap((base) => base.operations
    .filter((operation) => operation.name === 'create' || operation.name === 'update' || operation.name === 'delete')
    .map((operation) => crudWriteAction(base, operation))),
);

export const joomlaWriteActions: readonly WriteActionDescriptor[] = Object.freeze([
  ...joomlaCrudWriteActions,
  ...joomlaSpecialWriteActions,
]);

export const joomlaActions: readonly JoomlaActionDescriptor[] = Object.freeze([
  ...joomlaReadActions,
  ...joomlaWriteActions,
]);

const actionById: ReadonlyMap<string, ReadActionDescriptor> = new Map(
  joomlaReadActions.map((action) => [action.id, action]),
);

const writeActionById: ReadonlyMap<string, WriteActionDescriptor> = new Map(
  joomlaWriteActions.map((action) => [action.id, action]),
);

export function getJoomlaReadAction(id: string): ReadActionDescriptor | undefined {
  return actionById.get(id);
}

export function getJoomlaWriteAction(id: string): WriteActionDescriptor | undefined {
  return writeActionById.get(id);
}

export function getJoomlaAction(id: string): JoomlaActionDescriptor | undefined {
  return getJoomlaReadAction(id) ?? getJoomlaWriteAction(id);
}

export function findJoomlaActions(
  filter: ActionCatalogFilter & { readonly includeWrites?: boolean } = {},
): readonly JoomlaActionDescriptor[] {
  const needle = filter.text?.trim().toLocaleLowerCase('en');

  return joomlaActions.filter((action) => {
    if (action.risk !== 'read' && action.risk !== 'sensitive-read' && filter.includeWrites !== true) {
      return false;
    }
    if (filter.toolsets !== undefined && !filter.toolsets.has(action.toolset)) {
      return false;
    }
    if (filter.domain !== undefined && action.domain !== filter.domain) {
      return false;
    }
    if (filter.includeSensitive !== true && action.risk === 'sensitive-read') {
      return false;
    }

    return needle === undefined || needle.length === 0 ||
      `${action.id} ${action.title} ${action.description} ${action.domain}`.toLocaleLowerCase('en').includes(needle);
  });
}

/**
 * Searches the catalogue without making Joomla route paths or credentials
 * searchable. Toolsets are an authorization intersection, not a presentation
 * preference.
 */
export function findJoomlaReadActions(filter: ActionCatalogFilter = {}): readonly ReadActionDescriptor[] {
  const needle = filter.text?.trim().toLocaleLowerCase('en');

  return joomlaReadActions.filter((action) => {
    if (filter.toolsets !== undefined && !filter.toolsets.has(action.toolset)) {
      return false;
    }

    if (filter.domain !== undefined && action.domain !== filter.domain) {
      return false;
    }

    if (filter.includeSensitive !== true && action.risk === 'sensitive-read') {
      return false;
    }

    return needle === undefined || needle.length === 0 ||
      `${action.id} ${action.title} ${action.description} ${action.domain}`.toLocaleLowerCase('en').includes(needle);
  });
}

export function resolveJoomlaReadRequest(
  actionId: string,
  input: unknown,
  configuredMaximumPageSize = 100,
): ResolvedReadRequest {
  const action = getJoomlaReadAction(actionId);

  if (action === undefined) {
    throw new Error(`Unknown Joomla read action: ${actionId}.`);
  }

  const values = input === undefined ? {} : assertPlainInput(input);
  const allowed = new Set([
    ...action.routeParameters.map((parameter) => parameter.name),
    ...(action.paginated ? ['offset', 'limit'] : []),
  ]);
  const unexpected = Object.keys(values).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new Error(`Unsupported action input properties: ${unexpected.sort().join(', ')}.`);
  }

  const routeInput: Record<string, unknown> = {};

  for (const parameter of action.routeParameters) {
    if (parameter.name in values) {
      routeInput[parameter.name] = values[parameter.name];
    }
  }

  const path = resolveReadActionRoute(action, routeInput);
  const query = action.paginated
    ? normalizeBoundedListQuery({ offset: values['offset'], limit: values['limit'] }, configuredMaximumPageSize)
    : Object.freeze({});

  return Object.freeze({ method: 'GET', path, query });
}

export function resolveJoomlaWriteRequest(actionId: string, input: unknown): ResolvedWriteRequest {
  const action = getJoomlaWriteAction(actionId);

  if (action === undefined) {
    throw new Error(`Unknown Joomla write action: ${actionId}.`);
  }

  const values = assertPlainInput(input);
  const allowed = new Set([
    ...action.routeParameters.map((parameter) => parameter.name),
    ...(action.bodyPolicy === 'none' ? [] : ['data']),
    ...(action.operation === 'create' ? [] : ['etag']),
  ]);
  const unexpected = Object.keys(values).filter((key) => !allowed.has(key));

  if (unexpected.length > 0) {
    throw new Error(`Unsupported action input properties: ${unexpected.sort().join(', ')}.`);
  }

  const routeInput: Record<string, unknown> = {};

  for (const parameter of action.routeParameters) {
    if (parameter.name in values) {
      routeInput[parameter.name] = values[parameter.name];
    }
  }

  const path = resolveReadActionRoute(action, routeInput);
  if (action.bodyPolicy === 'required' && values['data'] === undefined) {
    throw new Error(`Joomla action ${action.id} requires a mutation body.`);
  }
  const body = values['data'] === undefined
    ? undefined
    : withFixedMutationDefaults(action.id, normalizeMutationBody(values['data'], action));
  const etag = values['etag'] === undefined ? undefined : normalizeEtag(values['etag']);

  return Object.freeze({
    method: action.method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(etag === undefined ? {} : { etag }),
  });
}

function withFixedMutationDefaults(
  actionId: string,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const base = joomlaCrudBases.find((candidate) => actionId.startsWith(`${candidate.id}.`));
  if (base === undefined) return body;
  const fixed = Object.fromEntries(
    Object.entries(base.controllerDefaults).filter(([key]) => key !== 'component'),
  );

  // Route-specific controller state (for example client_id, extension, and
  // com_fields context) is not caller-selectable, but Joomla's generic write
  // models still require it in form data. Fixed catalogue values deliberately
  // win over the normalized caller body.
  return Object.keys(fixed).length === 0
    ? body
    : Object.freeze({ ...body, ...fixed });
}

function assertPlainInput(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error('Action input must be an object.');
  }

  return input as Readonly<Record<string, unknown>>;
}

const forbiddenMutationKeys = new Set(['__proto__', 'prototype', 'constructor']);

function normalizeMutationBody(
  value: unknown,
  action: WriteActionDescriptor,
): Readonly<Record<string, unknown>> {
  const body = assertPlainInput(value);

  if (Object.keys(body).length === 0) {
    throw new Error('A Joomla mutation body must contain at least one field.');
  }

  validateJsonValue(body, 0);
  const serialized = JSON.stringify(body);

  if (Buffer.byteLength(serialized, 'utf8') > 1_048_576) {
    throw new Error('Joomla mutation body exceeds the 1048576-byte limit.');
  }

  validateMutationSchema(body, action);

  return body;
}

function validateMutationSchema(
  body: Readonly<Record<string, unknown>>,
  action: WriteActionDescriptor,
): void {
  const schema = action.inputSchema.properties['data'];

  if (schema === undefined || schema['type'] !== 'object') {
    return;
  }

  const properties = isPlainRecord(schema['properties']) ? schema['properties'] : undefined;
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((field): field is string => typeof field === 'string')
    : [];

  for (const field of required) {
    if (!(field in body)) {
      throw new Error(`Joomla action ${action.id} requires data.${field}.`);
    }
  }

  if (schema['additionalProperties'] === false && properties !== undefined) {
    const unknown = Object.keys(body).filter((field) => !(field in properties)).sort();

    if (unknown.length > 0) {
      throw new Error(`Unsupported ${action.id} data properties: ${unknown.join(', ')}.`);
    }
  }

  if (properties === undefined) {
    return;
  }

  for (const [field, value] of Object.entries(body)) {
    const property = isPlainRecord(properties[field]) ? properties[field] : undefined;

    if (property !== undefined) {
      validateMutationProperty(value, property, `${action.id}.data.${field}`);
    }
  }

  validateActionSpecificMutation(body, action.id);
}

function validateMutationProperty(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
): void {
  const type = schema['type'];

  if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string.`);
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      throw new Error(`${path} is shorter than the permitted minimum.`);
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      throw new Error(`${path} exceeds the permitted maximum length.`);
    }
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) {
      throw new Error(`${path} does not match its required format.`);
    }
  } else if (type === 'integer') {
    if (!Number.isSafeInteger(value)) throw new Error(`${path} must be an integer.`);
    const integer = value as number;
    if (typeof schema['minimum'] === 'number' && integer < schema['minimum']) {
      throw new Error(`${path} is below the permitted minimum.`);
    }
    if (typeof schema['maximum'] === 'number' && integer > schema['maximum']) {
      throw new Error(`${path} exceeds the permitted maximum.`);
    }
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      throw new Error(`${path} contains too few items.`);
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      throw new Error(`${path} contains too many items.`);
    }
    const itemSchema = isPlainRecord(schema['items']) ? schema['items'] : undefined;
    if (itemSchema !== undefined) {
      value.forEach((item, index) => validateMutationProperty(item, itemSchema, `${path}[${index}]`));
    }
  } else if (type === 'object') {
    if (!isPlainRecord(value)) throw new Error(`${path} must be an object.`);
  }

  if (Array.isArray(schema['enum']) && !schema['enum'].some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} must be one of its declared values.`);
  }
}

function validateActionSpecificMutation(
  body: Readonly<Record<string, unknown>>,
  actionId: string,
): void {
  if (
    actionId === 'media.files.create' &&
    typeof body['path'] === 'string' &&
    body['path'].includes('.') &&
    (typeof body['content'] !== 'string' || body['content'].length === 0)
  ) {
    throw new Error('media.files.create requires non-empty Base64 content when path identifies a file.');
  }

  if (
    actionId === 'media.files.update' &&
    (typeof body['path'] !== 'string' || body['path'].length === 0) &&
    (typeof body['content'] !== 'string' || body['content'].length === 0)
  ) {
    throw new Error('media.files.update requires a non-empty new path or Base64 content.');
  }

  if (
    actionId.startsWith('languages.overrides.') &&
    actionId.endsWith('.create') &&
    typeof body['key'] === 'string' &&
    ['YES', 'NO', 'NULL', 'FALSE', 'ON', 'OFF', 'NONE', 'TRUE'].includes(body['key'].toLocaleUpperCase('en'))
  ) {
    throw new Error('The requested language override key is reserved by Joomla.');
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > 12) {
    throw new Error('Joomla mutation body exceeds the maximum nesting depth.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Joomla mutation body numbers must be finite.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error('Joomla mutation body arrays may contain at most 10000 items.');
    value.forEach((entry) => validateJsonValue(entry, depth + 1));
    return;
  }
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Joomla mutation body must contain JSON-compatible values.');
  }

  const entries = Object.entries(value as Record<string, unknown>);

  if (entries.length > 512) {
    throw new Error('Joomla mutation body objects may contain at most 512 fields.');
  }

  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > 255 || forbiddenMutationKeys.has(key)) {
      throw new Error(`Unsafe Joomla mutation field name: ${key || '(empty)'}.`);
    }
    validateJsonValue(entry, depth + 1);
  }
}

function normalizeEtag(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:W\/)?"[\x21\x23-\x7E]+"$/.test(value)) {
    throw new Error('Invalid ETag value.');
  }

  return value;
}
