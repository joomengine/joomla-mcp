import type { JoomlaApiRequest } from '../infrastructure/api/joomla-api-client.js';
import type { JcbApiAction, JcbField } from './catalog.js';

type Document = Readonly<Record<string, unknown>>;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const blockedFields = new Set([
  'id',
  'asset_id',
  'rules',
  'checked_out',
  'checked_out_time',
  'modified',
  'modified_by',
  'version',
  'not_required',
]);
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function isRecord(value: unknown): value is Document {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function integer(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function readIdentity(kind: 'id' | 'guid', value: unknown): string | undefined {
  if (kind === 'guid') return typeof value === 'string' && guid.test(value) ? value.toLowerCase() : undefined;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
}

export function itemPath(action: JcbApiAction, identity: unknown): string {
  if (!action.identifier) throw new Error('The JCB action does not identify an individual record.');
  const id = readIdentity(action.identifier, identity);
  if (!id || !action.path.endsWith('/:' + action.identifier)) {
    throw new Error(`Expected a valid ${action.identifier} for ${action.id}.`);
  }
  return action.path.replace(':' + action.identifier, id);
}

function filterValue(value: unknown): string | number | boolean {
  if (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 1024 && !value.includes('\0'))
  )
    return value;
  throw new Error('JCB filters accept bounded scalar values or an array of scalar values.');
}

function listQuery(
  action: JcbApiAction,
  input: Document,
  maxPage: number,
): NonNullable<JoomlaApiRequest['query']> {
  if (!action.paginated) {
    if (Object.keys(input).length)
      throw new Error('This JCB list controller does not accept pagination or filters.');
    return {};
  }
  const query: Record<string, string | number | boolean | readonly (string | number | boolean)[]> = {
    'page[offset]': integer(input['offset'] ?? 0, 0, 100000, 'offset'),
    'page[limit]': Math.min(maxPage, integer(input['limit'] ?? 20, 1, 500, 'limit')),
  };
  if (input['filter'] !== undefined) {
    const filters = input['filter'];
    if (!isRecord(filters) || Object.keys(filters).length > 32)
      throw new Error('Expected up to 32 named JCB filters.');
    for (const [key, value] of Object.entries(filters)) {
      if (!action.filters.includes(key)) throw new Error(`Unknown list filter ${key} on ${action.resource}.`);
      if (Array.isArray(value)) {
        if (!value.length || value.length > 64)
          throw new Error('JCB multiselect filters accept between 1 and 64 entries.');
        // [] is part of the query key, so PHP preserves every selected value.
        query[`filter[${key}][]`] = value.map(filterValue);
      } else query[`filter[${key}]`] = filterValue(value);
    }
  }
  if (input['ordering'] !== undefined) {
    const ordering = input['ordering'];
    if (typeof ordering !== 'string' || !action.ordering.includes(ordering))
      throw new Error('Unknown JCB ordering column.');
    query['list[ordering]'] = ordering;
  }
  if (input['direction'] !== undefined) {
    const direction = input['direction'];
    if (typeof direction !== 'string' || !/^(asc|desc)$/i.test(direction))
      throw new Error('Direction must be ASC or DESC.');
    query['list[direction]'] = direction.toLowerCase();
  }
  if (
    Buffer.byteLength(
      new URLSearchParams(
        Object.entries(query).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(one => [k, String(one)])),
      ).toString(),
    ) > 32768
  )
    throw new Error('JCB list filters exceed the bounded query size.');
  return query;
}

function writable(field: JcbField, name: string): boolean {
  return (
    !blockedFields.has(name) &&
    !unsafeKeys.has(name) &&
    !field.readonly &&
    !field.disabled &&
    !field.requestOnly &&
    field.filter?.toLowerCase() !== 'unset'
  );
}

function subform(field: JcbField, value: unknown, label: string, depth: number): void {
  const fields = field.fields;
  if (!fields || !Object.keys(fields).length) throw new Error(`No reviewed row contract for ${label}.`);
  // Joomla accepts a repeatable subform as either a list or a map of named rows.
  let rows: readonly unknown[];
  if (field.multiple) {
    if (!Array.isArray(value) && !isRecord(value)) throw new Error(`Expected rows for ${label}.`);
    if (isRecord(value) && Object.keys(value).some(k => !/^[\w-]{1,128}$/.test(k) || unsafeKeys.has(k)))
      throw new Error(`Invalid row name for ${label}.`);
    rows = Object.values(value);
  } else rows = [value];
  if (rows.length > 1000) throw new Error(`Too many rows for ${label}.`);
  for (const row of rows) {
    if (!isRecord(row)) throw new Error(`Expected a row object for ${label}.`);
    validateFields(fields, row, label, depth + 1);
  }
}

function checkValue(field: JcbField, value: unknown, label: string, depth: number): void {
  if (depth > 12) throw new Error('JCB field nesting is too deep.');
  if (['subform', 'group'].includes(field.type.toLowerCase())) {
    subform(field, value, label, depth);
    return;
  }
  if (field.multiple) {
    if (!Array.isArray(value) || value.length > 1000)
      throw new Error(`Expected a bounded selection for ${label}.`);
    for (const item of value) checkValue({ ...field, multiple: false }, item, label, depth + 1);
    return;
  }
  if (
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new Error(`Unsupported field value for ${label}.`);
  }
  if (
    typeof value === 'string' &&
    field.maxlength &&
    /^[1-9]\d*$/.test(field.maxlength) &&
    [...value].length > Number(field.maxlength)
  )
    throw new Error(`Value exceeds the declared length for ${label}.`);
  if (
    value !== null &&
    value !== '' &&
    (field.validate === 'guid' || field.relationshipKey === 'guid') &&
    !(value === 0 || value === '0') &&
    !readIdentity('guid', value)
  )
    throw new Error(`Expected a GUID for ${label}.`);
  if (value !== null && value !== '' && /^(int|integer|intval|uint)$/i.test(field.filter ?? '')) {
    const raw = typeof value === 'boolean' ? Number(value) : value;
    if (
      (typeof raw === 'string' && !/^-?\d+$/.test(raw)) ||
      !Number.isSafeInteger(Number(raw)) ||
      (field.filter?.toLowerCase() === 'uint' && Number(raw) < 0)
    )
      throw new Error(`Expected an integer for ${label}.`);
    if (
      (field.min !== undefined && Number.isFinite(Number(field.min)) && Number(raw) < Number(field.min)) ||
      (field.max !== undefined && Number.isFinite(Number(field.max)) && Number(raw) > Number(field.max))
    )
      throw new Error(`Value is outside the declared range for ${label}.`);
  }
  if (value !== null && value !== '' && field.options?.length && !field.options.includes(String(value))) {
    throw new Error(`Value is outside the declared options for ${label}.`);
  }
}

function validateFields(
  fields: Readonly<Record<string, JcbField>>,
  data: Document,
  prefix: string,
  depth: number,
): void {
  for (const [name, value] of Object.entries(data)) {
    const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!field || !writable(field, name)) throw new Error(`Unknown or read-only JCB field ${prefix}.${name}.`);
    checkValue(field, value, `${prefix}.${name}`, depth);
  }
}

export function resolveJcbApiRequest(action: JcbApiAction, input: Document, maxPage = 500): JoomlaApiRequest {
  if (!isRecord(input)) throw new Error('Expected a JCB input object.');
  const allowed = action.operation === 'list' ? ['offset', 'limit', 'filter', 'ordering', 'direction'] : [];
  if (action.identifier) allowed.push(action.identifier);
  if (action.operation === 'create' || action.operation === 'update') allowed.push('data');
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new Error(`Unexpected input for ${action.id}: ${key}.`);
  const path = action.identifier ? itemPath(action, input[action.identifier]) : action.path;
  if (action.operation === 'list') return { method: 'GET', path, query: listQuery(action, input, maxPage) };
  if (action.operation !== 'create' && action.operation !== 'update') return { method: action.method, path };
  const data = input['data'];
  if (!isRecord(data) || !Object.keys(data).length)
    throw new Error('Provide at least one writable JCB form field in data.');
  if (Buffer.byteLength(JSON.stringify(data)) > 1_048_576) throw new Error('JCB entity payload exceeds 1 MiB.');
  validateFields(action.fields, data, action.resource, 0);
  return { method: action.method, path, body: structuredClone(data) };
}

function fieldSchema(field: JcbField): Document {
  const type = field.type.toLowerCase();
  if (type === 'subform' || type === 'group') {
    const row = formSchema(field.fields ?? {});
    return field.multiple
      ? {
          anyOf: [
            { type: 'array', items: row, maxItems: 1000 },
            { type: 'object', additionalProperties: row, maxProperties: 1000 },
          ],
        }
      : row;
  }
  const scalar = field.options?.length
    ? { type: ['string', 'number', 'boolean', 'null'], description: 'Native choices: ' + field.options.join(', ') }
    : { type: ['string', 'number', 'boolean', 'null'] };
  const described = {
    ...scalar,
    ...(field.maxlength && /^[1-9]\d*$/.test(field.maxlength) ? { maxLength: Number(field.maxlength) } : {}),
    ...(field.relationshipKey ? { 'x-joomla-relationship-key': field.relationshipKey } : {}),
    ...(field.showon ? { 'x-joomla-showon': field.showon } : {}),
  };
  return field.multiple ? { type: 'array', items: described, maxItems: 1000 } : described;
}

function formSchema(fields: Readonly<Record<string, JcbField>>): Document {
  const properties = Object.fromEntries(
    Object.entries(fields)
      .filter(([key, field]) => writable(field, key))
      .map(([key, field]) => [key, fieldSchema(field)]),
  );
  return { type: 'object', properties, additionalProperties: false };
}

/** Schema used by discovery and by the runtime's reviewed form and filter allowlists. */
export function jcbInputSchema(action: JcbApiAction): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (action.identifier) {
    properties[action.identifier] =
      action.identifier === 'guid'
        ? { type: 'string', format: 'uuid' }
        : {
            anyOf: [
              { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
              { type: 'string', pattern: '^[1-9][0-9]*$' },
            ],
          };
    required.push(action.identifier);
  }
  if (action.operation === 'create' || action.operation === 'update') {
    const form = formSchema(action.fields);
    const mandatory =
      action.operation === 'create' && !action.dynamicRequired
        ? Object.entries(action.fields)
            .filter(
              ([name, field]) =>
                writable(field, name) &&
                field.required &&
                !field.default &&
                !field.showon &&
                !field.serverGenerated &&
                name !== 'guid',
            )
            .map(([name]) => name)
        : [];
    properties['data'] = { ...form, minProperties: 1, ...(mandatory.length ? { required: mandatory } : {}) };
    required.push('data');
  }
  if (action.operation === 'list' && action.paginated) {
    properties['offset'] = { type: 'integer', minimum: 0, maximum: 100000 };
    properties['limit'] = { type: 'integer', minimum: 1, maximum: 500 };
    properties['direction'] = { type: 'string', pattern: '^([aA][sS][cC]|[dD][eE][sS][cC])$' };
    if (action.ordering.length) properties['ordering'] = { type: 'string', enum: action.ordering };
    const scalar = { type: ['string', 'number', 'boolean'], maxLength: 1024 };
    properties['filter'] = {
      type: 'object',
      additionalProperties: false,
      maxProperties: 32,
      properties: Object.fromEntries(
        action.filters.map(key => [
          key,
          { anyOf: [scalar, { type: 'array', items: scalar, minItems: 1, maxItems: 64 }] },
        ]),
      ),
    };
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
