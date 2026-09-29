import { getJoomlaReadAction, resolveJoomlaReadRequest, validateJoomlaMutationJson } from '../catalog/action-catalog.js';
import { crudWriteFields } from '../catalog/crud-write-fields.js';
import type { ApiConfig, Toolset } from '../config/schema.js';
import type { JoomlaApiTransport } from '../infrastructure/api/joomla-api-client.js';

export interface ResolvedCustomField {
  readonly name: string;
  readonly type: string;
  readonly context: string;
}

interface CustomFieldTarget {
  readonly base: string;
  readonly context: string;
  readonly listAction: string;
  readonly nested: boolean;
}

// Only contexts whose native Joomla API form/save path has been reviewed.
const targets: readonly CustomFieldTarget[] = Object.freeze([
  { base: 'content.articles', context: 'com_content.article', listAction: 'fields.content-articles.list', nested: false },
  { base: 'content.categories', context: 'com_content.categories', listAction: 'fields.content-categories.list', nested: true },
  { base: 'contacts.contacts', context: 'com_contact.contact', listAction: 'fields.contact.list', nested: false },
  { base: 'users.users', context: 'com_users.user', listAction: 'fields.users.list', nested: false },
]);

const reserved = new Set([
  '__proto__', 'prototype', 'constructor', 'com_fields', 'id', 'asset_id', 'extension',
  'client_id', 'component', 'option', 'task', 'view', 'layout', 'format', 'controller',
  'model', 'method', 'path', 'url', 'token', 'jform', 'rules', 'created', 'created_by',
  'modified', 'modified_by', 'checked_out', 'checked_out_time', 'version', 'hits',
  'registerDate', 'lastvisitDate', 'activation', 'lastResetTime', 'resetCount', 'otpKey', 'otep', 'authProvider',
  'dryRun', '_edgeConfirmed', 'action', 'transport', 'etag', 'idempotencyKey',
]);

export function customFieldTarget(actionId: string): (CustomFieldTarget & { readonly readToolset: Toolset }) | undefined {
  const target = targets.find((candidate) => actionId === `${candidate.base}.create` || actionId === `${candidate.base}.update`);
  return target === undefined ? undefined : { ...target, readToolset: getJoomlaReadAction(target.listAction)!.toolset };
}

/** Retains dynamic input for site-backed validation; never broadens the static catalogue. */
export function customFieldInput(actionId: string, value: unknown): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly names: readonly string[];
} | undefined {
  const target = customFieldTarget(actionId);
  if (target === undefined) return undefined;
  validateJoomlaMutationJson(value);
  const data = structuredClone(value as Record<string, unknown>);
  const core = new Set(crudWriteFields(target.base));
  const alias = data['com_fields'];
  if (Object.hasOwn(data, 'com_fields')) {
    if (!isRecord(alias) || Object.keys(alias).length === 0) {
      throw new Error('com_fields must be a non-empty object mapping published field names to values.');
    }
    for (const [name, fieldValue] of Object.entries(alias)) {
      if (!safeName(name, core)) throw new Error(`Unsafe or reserved custom field name: ${name}.`);
      if (Object.hasOwn(data, name)) throw new Error(`Custom field ${name} is supplied both at the top level and in com_fields.`);
      data[name] = fieldValue;
    }
    delete data['com_fields'];
  }
  const names = Object.keys(data).filter((name) => !core.has(name)).sort();
  for (const name of names) {
    if (!safeName(name, core)) throw new Error(`Unsafe or reserved custom field name: ${name}.`);
    if (data[name] === null) {
      throw new Error(`Custom field ${name} cannot be null; use the field's supported empty string or array to clear it.`);
    }
  }
  validateJoomlaMutationJson(data);
  return { data, names };
}

/** Uses fixed catalogue routes and numeric offsets, never a response-provided URL. */
export async function resolvePublishedCustomFields(
  actionId: string,
  apiConfig: ApiConfig,
  api: JoomlaApiTransport,
): Promise<readonly ResolvedCustomField[]> {
  const target = customFieldTarget(actionId);
  if (target === undefined) return [];
  const core = new Set(crudWriteFields(target.base));
  const found = new Map<string, ResolvedCustomField>();
  const seenIds = new Set<string>();
  const limit = Math.min(100, apiConfig.maxPageSize);
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const request = resolveJoomlaReadRequest(target.listAction, { offset, limit }, apiConfig.maxPageSize);
    const response = await api.get(apiConfig, request.path, request.query);
    if (!isRecord(response.data) || !Array.isArray(response.data['data'])) {
      throw new Error('Joomla custom field discovery returned an invalid collection.');
    }
    const rows: unknown[] = response.data['data'];
    if (rows.length > limit || offset + rows.length > 1_000) throw new Error('Joomla custom field discovery exceeded its 1000-field collection limit.');
    for (const row of rows) {
      if (!isRecord(row) || !isRecord(row['attributes']) || !/^[1-9][0-9]*$/.test(String(row['id']))) {
        throw new Error('Joomla custom field discovery returned invalid field metadata.');
      }
      const id = String(row['id']);
      if (seenIds.has(id)) throw new Error('Joomla custom field discovery repeated a field; pagination is not stable.');
      seenIds.add(id);
      const field = row['attributes'];
      if (field['context'] !== target.context || (field['state'] !== 1 && field['state'] !== '1')) continue;
      const groupId = field['group_id'];
      if ((typeof groupId !== 'number' && typeof groupId !== 'string') || !/^[0-9]+$/.test(String(groupId))) continue;
      if (Number(groupId) !== 0 && field['group_state'] !== 1 && field['group_state'] !== '1') continue;
      // Joomla's stock field API omits only_use_in_subform. Honour it when an
      // implementation supplies it; Joomla remains responsible for applicability.
      if (field['only_use_in_subform'] === true || Number(field['only_use_in_subform']) === 1) continue;
      const name = field['name'];
      const type = field['type'];
      if (!target.nested && typeof name === 'string' && (core.has(name) || reserved.has(name))) {
        throw new Error(`Published custom field ${name} collides with a core Joomla form field; rename the custom field before planning this write.`);
      }
      if (typeof name !== 'string' || !safeName(name, core)) continue;
      if (typeof type !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(type)) throw new Error('Joomla custom field discovery returned an invalid field type.');
      if (found.has(name)) throw new Error(`Joomla custom field discovery returned duplicate field name: ${name}.`);
      found.set(name, Object.freeze({ name, type, context: target.context }));
    }
    const links = response.data['links'];
    const hasNext = isRecord(links) && links['next'] !== undefined && links['next'] !== null && links['next'] !== '';
    const meta = response.data['meta'];
    const totalPages = isRecord(meta) ? meta['total-pages'] : undefined;
    if (totalPages !== undefined && (!Number.isSafeInteger(totalPages) || (totalPages as number) < 0 || (totalPages as number) > 100)) {
      throw new Error('Joomla custom field discovery returned an invalid page count.');
    }
    const morePages = typeof totalPages === 'number' && page + 1 < totalPages;
    if (rows.length === 0) {
      if (hasNext || morePages) throw new Error('Joomla custom field discovery returned an empty unfinished page.');
      return Object.freeze([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }
    offset += rows.length;
    if (!hasNext && !morePages && (rows.length < limit || typeof totalPages === 'number')) {
      return Object.freeze([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }
  }
  throw new Error('Joomla custom field discovery exceeded its 100-page limit.');
}

export function encodeCustomFieldBody(
  actionId: string,
  body: Readonly<Record<string, unknown>>,
  fields: readonly ResolvedCustomField[],
): Readonly<Record<string, unknown>> {
  if (customFieldTarget(actionId)?.nested !== true || fields.length === 0) return body;
  const result = { ...body };
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    values[field.name] = result[field.name];
    delete result[field.name];
  }
  result['com_fields'] = values;
  validateJoomlaMutationJson(result);
  return result;
}

function safeName(name: string, core: ReadonlySet<string>): boolean {
  return /^[\p{L}\p{N}\p{M}_-]{1,255}$/u.test(name) && !reserved.has(name) && !core.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
