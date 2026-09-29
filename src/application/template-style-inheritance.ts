import type { ApiConfig } from '../config/schema.js';
import type { JoomlaApiTransport } from '../infrastructure/api/joomla-api-client.js';

export function isTemplateStyleCreate(action: string): boolean {
  return action === 'templates.site-styles.create' || action === 'templates.administrator-styles.create';
}

/** Resolve hidden form fields from Joomla's own installed template manifest. */
export async function templateStyleInheritance(
  api: JoomlaApiTransport,
  config: ApiConfig,
  action: string,
  template: unknown,
): Promise<Readonly<{ parent: string; inheritable: number }>> {
  if (!isTemplateStyleCreate(action) || !templateName(template)) {
    throw new Error('Template style creation requires a valid installed template name.');
  }
  const client = action === 'templates.site-styles.create' ? 0 : 1;
  const path = `v1/templates/styles/${client === 0 ? 'site' : 'administrator'}`;
  const limit = Math.min(100, config.maxPageSize);
  const seen = new Set<number>();
  let inheritance: Readonly<{ parent: string; inheritable: number }> | undefined;
  let matches = 0;
  let offset = 0;

  // Never follow URLs returned by the server; every read stays on the selected site/client.
  for (let page = 0; page < 10; page += 1) {
    const response = await api.get(config, path, { 'page[offset]': offset, 'page[limit]': limit });
    const document = record(response.data);
    const items = document['data'];
    if (!Array.isArray(items) || items.length > limit) {
      throw new Error('Joomla returned an invalid template style collection.');
    }
    for (const item of items) {
      const resource = record(item);
      const attributes = record(resource['attributes']);
      const id = resourceId(resource['id']);
      if (seen.has(id) || !sameClient(attributes['client_id'], client)) {
        throw new Error('Joomla returned duplicate or incorrectly scoped template styles.');
      }
      seen.add(id);
      if (attributes['template'] !== template) continue;
      if (++matches > 20) throw new Error('Template inheritance discovery exceeds the 20 matching styles limit.');
      const detail = await api.get(config, `${path}/${id}`);
      const source = record(record(detail.data)['data']);
      const values = record(source['attributes']);
      if (resourceId(source['id']) !== id || values['template'] !== template || !sameClient(values['client_id'], client)) {
        throw new Error('Joomla returned a different template or client while resolving inheritance.');
      }
      const current = manifestInheritance(values['xml'], template, client);
      if (inheritance !== undefined && (inheritance.parent !== current.parent || inheritance.inheritable !== current.inheritable)) {
        throw new Error('Existing template styles have conflicting inheritance metadata.');
      }
      inheritance = current;
    }
    const hasNext = record(document['links'])['next'];
    const totalPages = record(document['meta'])['total-pages'];
    if (totalPages !== undefined && (!Number.isSafeInteger(totalPages) || (totalPages as number) < 0)) {
      throw new Error('Joomla returned invalid template style pagination metadata.');
    }
    const lastPage = typeof totalPages === 'number' && page + 1 >= totalPages;
    if ((items.length < limit || lastPage) && (hasNext === undefined || hasNext === null || hasNext === '')) {
      if (inheritance === undefined) throw new Error('No existing style for this installed template and client was found; create refused.');
      return inheritance;
    }
    if (items.length === 0) throw new Error('Joomla returned inconsistent template style pagination.');
    offset += items.length;
  }
  throw new Error('Template inheritance discovery exceeds the 10 page limit; create refused.');
}

function manifestInheritance(value: unknown, template: string, client: number): Readonly<{ parent: string; inheritable: number }> {
  const xml = record(value);
  if (typeof xml['name'] !== 'string' || xml['name'].trim() === '') {
    throw new Error('Joomla returned missing or invalid template manifest metadata.');
  }
  const attributes = record(xml['@attributes']);
  if ((attributes['type'] !== undefined && attributes['type'] !== 'template')
    || (attributes['client'] !== undefined && attributes['client'] !== (client === 0 ? 'site' : 'administrator'))) {
    throw new Error('Joomla returned incorrectly scoped template manifest metadata.');
  }
  // Joomla's installer treats absent/empty manifest elements as 0 and ''.
  const parent = emptyElement(xml['parent']) ? '' : xml['parent'];
  const rawInheritable = emptyElement(xml['inheritable']) ? 0 : xml['inheritable'];
  if ((parent !== '' && (!templateName(parent) || parent === template))
    || ![0, 1, '0', '1'].includes(rawInheritable as string | number)) {
    throw new Error('Joomla returned invalid template inheritance metadata.');
  }
  return Object.freeze({ parent: parent as string, inheritable: Number(rawInheritable) });
}

function emptyElement(value: unknown): boolean {
  return value === undefined || value === '' || (typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0);
}

function templateName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$/.test(value) && !value.includes('..');
}

function sameClient(value: unknown, expected: number): boolean {
  return value === expected || value === String(expected);
}

function resourceId(value: unknown): number {
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error('Joomla returned an invalid template style identifier.');
  }
  return Number(value);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
