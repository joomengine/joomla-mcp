import { createHash } from 'node:crypto';

import { completeJoomlaApiPatchBody, resolveJoomlaReadRequest } from '../catalog/action-catalog.js';
import type { ApiConfig } from '../config/schema.js';
import type { ResolvedWriteRequest } from '../contracts/action-catalog.js';
import type { JoomlaApiResponse, JoomlaApiTransport } from '../infrastructure/api/joomla-api-client.js';
import type { PlannedOperation } from '../security/confirmation-service.js';

interface MenuBinding {
  readonly clientId: 0 | 1;
  readonly type: string;
  readonly link: string;
  readonly menutype: string;
  readonly option: string | null;
  readonly repair: 'native-derived-component-id';
  readonly verify: 'stored-menu-list';
}

export interface MenuWriteResult {
  readonly outcome: 'verified' | 'partial' | 'uncertain';
  readonly mutation?: JoomlaApiResponse;
  readonly repair?: JoomlaApiResponse;
  readonly verification: Readonly<Record<string, unknown>>;
}

export function isMenuItemWrite(action: string): boolean {
  return /^(?:menus\.site-items|menus\.administrator-items)\.(?:create|update)$/.test(action);
}

/** Resolve and bind the effective native menu form before the operator approves. */
export async function prepareMenuComponentBinding(
  action: string,
  request: ResolvedWriteRequest,
  config: ApiConfig,
  api: JoomlaApiTransport,
): Promise<{ readonly request: ResolvedWriteRequest; readonly preflight: Readonly<Record<string, unknown>> }> {
  let body = request.body!;
  const clientId = action.startsWith('menus.site-items.') ? 0 : 1;
  if (request.method === 'PATCH') {
    const current = await api.get(config, request.path);
    const currentItem = item(current.data);
    if (currentItem.id !== positiveId(request.path.split('/').at(-1)) || nonNegativeId(currentItem.attributes['client_id']) !== clientId) {
      throw new Error('Joomla returned a different menu item or client during plan preparation.');
    }
    body = completeJoomlaApiPatchBody(action, currentItem.attributes, body);
  }
  const type = body['type'];
  if (typeof type !== 'string' || !['component', 'url', 'alias', 'separator', 'heading', 'container'].includes(type)) {
    throw new Error('A menu item write requires a supported Joomla menu type.');
  }
  const link = ['separator', 'heading', 'container'].includes(type) ? '' : body['link'];
  if (typeof link !== 'string') throw new Error('A menu item write requires its effective Joomla link.');
  const menutype = body['menutype'];
  if (typeof menutype !== 'string' || menutype.length === 0 || menutype.length > 255) {
    throw new Error('A menu item write requires its effective Joomla menu type identifier.');
  }
  const option = type === 'component' ? componentOption(link) : null;
  const binding: MenuBinding = {
    clientId,
    type, link, menutype, option,
    repair: 'native-derived-component-id',
    verify: 'stored-menu-list',
  };
  // Never retain a previous component ID: Joomla getItem can otherwise leave an
  // old positive ID in place when a new link names an unavailable component.
  return {
    request: { ...request, body: freeze(structuredClone({ ...body, link, component_id: 0 })) },
    preflight: freeze({ menuComponentBinding: binding }),
  };
}

/**
 * Joomla's save does not derive component_id. Its item getter does; therefore
 * one approved menu write may need a fixed corrective PATCH before a collection
 * read can verify the actual stored value. Every post-mutation outcome is returned
 * for idempotency caching, including failures and ambiguous transport results.
 */
export async function executeMenuComponentBinding(
  config: ApiConfig,
  api: JoomlaApiTransport,
  operation: PlannedOperation,
): Promise<MenuWriteResult> {
  const binding = bindingFor(operation);
  const basePath = binding.clientId === 0 ? 'v1/menus/site/items' : 'v1/menus/administrator/items';
  const fixedPath = operation.method === 'POST'
    ? basePath
    : `${basePath}/${positiveId(operation.path.split('/').at(-1))}`;
  if (operation.path !== fixedPath) throw new Error('The approved menu route is inconsistent with its client.');

  let mutation: JoomlaApiResponse | undefined;
  let repair: JoomlaApiResponse | undefined;
  let id: number | undefined;
  let expectedComponentId: number | undefined;
  try {
    mutation = await api.request(config, {
      method: operation.method, path: fixedPath, body: operation.body!,
      ...(operation.etag === undefined ? {} : { etag: operation.etag }),
      idempotencyKey: operation.idempotencyKey,
      authentication: 'joomla-api-token',
    });
    id = operation.method === 'POST'
      ? positiveId(record(record(mutation.data)['data'])['id'])
      : positiveId(operation.path.split('/').at(-1));
    expectedComponentId = 0;

    if (binding.type === 'component') {
      const derived = await api.get(config, `${basePath}/${id}`);
      const derivedItem = item(derived.data);
      if (derivedItem.id !== id || !sameIdentity(derivedItem.attributes, binding)) {
        throw new Error('Joomla item read does not match the approved menu type, link and client; corrective PATCH was not attempted.');
      }
      expectedComponentId = positiveId(derivedItem.attributes['component_id']);
      const etag = derived.headers['etag'];
      if (etag !== undefined && !/^(?:W\/)?"[\x21\x23-\x7E]+"$/.test(etag)) {
        throw new Error('Joomla returned an invalid entity tag for the corrective menu PATCH.');
      }
      repair = await api.request(config, {
        method: 'PATCH', path: `${basePath}/${id}`,
        body: { ...operation.body, component_id: expectedComponentId },
        ...(etag === undefined ? {} : { etag }),
        idempotencyKey: menuRepairIdempotencyKey(operation.idempotencyKey),
        authentication: 'joomla-api-token',
      });
    }

    const stored = await storedMenuItem(api, config, binding, id);
    const storedComponentId = nonNegativeId(stored['component_id']);
    const matches = sameIdentity(stored, binding) && storedComponentId === expectedComponentId;
    return {
      outcome: matches ? 'verified' : 'partial', mutation,
      ...(repair === undefined ? {} : { repair }),
      verification: {
        acknowledgedBy: 'joomla-api', source: 'stored-menu-list',
        postcondition: matches ? 'verified' : 'failed', id,
        expectedComponentId, storedComponentId,
        ...(matches ? {} : { reason: 'Joomla accepted the write, but the stored menu binding does not match the approved component, type, link and client. Inspect this item before attempting another write.' }),
      },
    };
  } catch (error) {
    return {
      outcome: mutation === undefined ? 'uncertain' : 'partial',
      ...(mutation === undefined ? {} : { mutation }),
      ...(repair === undefined ? {} : { repair }),
      verification: {
        acknowledgedBy: mutation === undefined ? 'not-confirmed' : 'joomla-api',
        source: 'stored-menu-list', postcondition: 'not-verified',
        ...(id === undefined ? {} : { id }),
        ...(expectedComponentId === undefined ? {} : { expectedComponentId }),
        possiblyApplied: true,
        reason: `${error instanceof Error ? error.message.slice(0, 400) : 'Joomla menu verification failed.'} The menu may already exist or have changed. Inspect the item before retrying; this idempotency key will not execute the write again.`,
      },
    };
  }
}

async function storedMenuItem(
  api: JoomlaApiTransport,
  config: ApiConfig,
  binding: MenuBinding,
  id: number,
): Promise<Readonly<Record<string, unknown>>> {
  const action = binding.clientId === 0 ? 'menus.site-items.list' : 'menus.administrator-items.list';
  const limit = Math.min(config.maxPageSize, 100);
  const seen = new Set<number>();
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const request = resolveJoomlaReadRequest(action, { offset, limit }, config.maxPageSize);
    const response = await api.get(config, request.path, { ...request.query, 'filter[menutype]': binding.menutype });
    const collection = record(response.data);
    const rows = collection['data'];
    if (!Array.isArray(rows) || rows.length > limit || offset + rows.length > 10_000) {
      throw new Error('Joomla returned an invalid or oversized stored-menu collection.');
    }
    for (const value of rows) {
      const row = item({ data: value });
      if (seen.has(row.id)) throw new Error('Joomla repeated a menu item while verifying the stored binding.');
      seen.add(row.id);
      if (row.id === id) return row.attributes;
    }
    const next = record(collection['links'])['next'];
    const totalPages = record(collection['meta'])['total-pages'];
    if (totalPages !== undefined && (!Number.isSafeInteger(totalPages) || (totalPages as number) < 0 || (totalPages as number) > 100)) {
      throw new Error('Joomla returned an invalid menu collection page count.');
    }
    const more = (next !== undefined && next !== null && next !== '') ||
      (typeof totalPages === 'number' && page + 1 < totalPages);
    if (rows.length === 0 || (!more && (rows.length < limit || typeof totalPages === 'number'))) break;
    offset += rows.length;
  }
  throw new Error('The mutated menu item was not found within the bounded stored-menu collection; persistence is not verified.');
}

function bindingFor(operation: PlannedOperation): MenuBinding {
  const value = record(operation.preflight?.['menuComponentBinding']);
  if (!isMenuItemWrite(operation.action) || value['repair'] !== 'native-derived-component-id' || value['verify'] !== 'stored-menu-list' ||
    (value['clientId'] !== 0 && value['clientId'] !== 1) || typeof value['type'] !== 'string' || typeof value['link'] !== 'string' || typeof value['menutype'] !== 'string' ||
    operation.body?.['component_id'] !== 0 || operation.body['type'] !== value['type'] || operation.body['link'] !== value['link'] || operation.body['menutype'] !== value['menutype']) {
    throw new Error('The menu write does not contain an approved native component binding plan.');
  }
  const binding = value as unknown as MenuBinding;
  if (binding.type === 'component' && componentOption(binding.link) !== binding.option) {
    throw new Error('The approved menu component option does not match its link.');
  }
  return binding;
}

function sameIdentity(attributes: Readonly<Record<string, unknown>>, binding: MenuBinding): boolean {
  return attributes['type'] === binding.type && attributes['link'] === binding.link &&
    attributes['menutype'] === binding.menutype &&
    nonNegativeId(attributes['client_id']) === binding.clientId;
}

function componentOption(link: string): string {
  if (!link.startsWith('index.php?')) throw new Error('A component menu link must start with index.php?.');
  const url = new URL(link, 'https://joomla.invalid/');
  if (url.search.includes(';')) throw new Error('A component menu link cannot use ambiguous semicolon option separators.');
  const values = url.searchParams.getAll('option');
  if ([...url.searchParams.keys()].some((key) => key !== 'option' && /^option(?:\[|\0|$)/.test(key.trimStart())) ||
    values.length !== 1 || !/^com_[A-Za-z0-9_]{1,60}$/.test(values[0]!)) {
    throw new Error('A component menu link requires exactly one valid Joomla component option.');
  }
  return values[0]!;
}

function menuRepairIdempotencyKey(key: string): string {
  const bytes = createHash('sha256').update(`${key}:menu-component-id`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function item(value: unknown): { readonly id: number; readonly attributes: Readonly<Record<string, unknown>> } {
  const data = record(record(value)['data']);
  const attributes = data['attributes'];
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw new Error('Joomla returned invalid menu item metadata.');
  }
  return { id: positiveId(data['id']), attributes: attributes as Record<string, unknown> };
}

function positiveId(value: unknown): number {
  const result = nonNegativeId(value);
  if (result < 1) throw new Error('Joomla did not provide a positive native menu/component identifier.');
  return result;
}

function nonNegativeId(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Joomla returned an invalid numeric menu/component identifier.');
  }
  return Number(value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((entry) => freeze(entry));
    Object.freeze(value);
  }
  return value;
}
