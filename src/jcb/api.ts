import { createHash, randomUUID } from 'node:crypto';
import type { ApiConfig } from '../config/schema.js';
import { JoomlaApiError } from '../infrastructure/api/joomla-api-error.js';
import type { JoomlaApiRequest, JoomlaApiResponse, JoomlaApiTransport } from '../infrastructure/api/joomla-api-client.js';
import { getJcbApiAction, type JcbApiAction, type JcbField } from './catalog.js';
import { isRecord, itemPath, readIdentity, resolveJcbApiRequest } from './api-input.js';

export { resolveJcbApiRequest } from './api-input.js';

type Document = Readonly<Record<string, unknown>>;
type Identity = {kind: 'id' | 'guid'; value: string};

export interface JcbApiPlan {
  readonly action: string;
  readonly request: JoomlaApiRequest;
  readonly identity?: Identity;
  readonly retainedSourceHash?: string;
  readonly alreadyTrashed?: boolean;
  readonly preview: {
    readonly action: string;
    readonly method: JoomlaApiRequest['method'];
    readonly path: string;
    readonly fields: readonly string[];
    readonly identifier?: string;
    readonly generatedGuid?: string;
    readonly preconditionFingerprint?: string;
  };
}

export interface JcbApiWriteResult {
  readonly mutation: {readonly status: number} | null;
  readonly verification: {
    readonly status: 'verified' | 'uncertain';
    readonly reason?: string;
    readonly id?: string;
    readonly fields?: readonly string[];
  };
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]]))
    : item);
}

function digest(value: unknown): string {
  return createHash('sha256').update(sortedJson(value)).digest('hex');
}

function itemAction(action: JcbApiAction, kind: Identity['kind']): JcbApiAction {
  const read = getJcbApiAction(`jcb.api.${action.resource}.get${kind === 'guid' ? '.guid' : ''}`);
  if (read?.operation !== 'get' || read.identifier !== kind) throw new Error('No independent JCB item read is registered for this identifier.');
  return read;
}

function resourceDocument(response: JoomlaApiResponse): Document {
  if (response.status !== 200 && response.status !== 201) throw new Error('Joomla did not return a successful JSON:API item.');
  if (!isRecord(response.data) || !isRecord(response.data['data'])) throw new Error('Expected one JSON:API item from Joomla.');
  const item = response.data['data'];
  if (typeof item['type'] !== 'string' || !isRecord(item['attributes'])) throw new Error('The Joomla item has no resource type or attributes.');
  const attributes = item['attributes'];
  if (item['id'] !== undefined && attributes['id'] !== undefined && String(item['id']) !== String(attributes['id'])) {
    throw new Error('Joomla returned inconsistent resource identifiers.');
  }
  return {...attributes, ...(item['id'] === undefined ? {} : {id:item['id']})};
}

async function readItem(api: JoomlaApiTransport, config: ApiConfig, action: JcbApiAction, identity: Identity) {
  const read = itemAction(action,identity.kind);
  const response = await api.get(config,itemPath(read,identity.value));
  const fields = resourceDocument(response);
  if (readIdentity(identity.kind,fields[identity.kind]) !== identity.value) throw new Error('Joomla returned a different JCB record.');
  return {fields,etag:response.headers['etag']};
}

function secretField(action: JcbApiAction, key: string): boolean {
  return (Object.hasOwn(action.fields,key) && action.fields[key]?.type.toLowerCase() === 'password') ||
    /^(?:password|passwd|secret|token|access_token|private_key)$/i.test(key) ||
    (action.resource === 'servers' && (key === 'signature' || key === 'private'));
}

function publicData(value: unknown, action: JcbApiAction): unknown {
  if (Array.isArray(value)) return value.map(item => publicData(item,action));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretField(action,key)).map(([key,item]) => [key,publicData(item,action)]));
}

export async function readJcbApiAction(api: JoomlaApiTransport, config: ApiConfig, action: JcbApiAction, input: Document): Promise<JoomlaApiResponse> {
  if (action.method !== 'GET') throw new Error('A JCB mutation requires an approved plan.');
  const request = resolveJcbApiRequest(action,input,config.maxPageSize);
  const response = await api.get(config,request.path,request.query);
  if (action.operation === 'get' && action.identifier) {
    const item = resourceDocument(response);
    if (readIdentity(action.identifier,item[action.identifier]) !== readIdentity(action.identifier,input[action.identifier])) {
      throw new Error('Joomla returned a different JCB record.');
    }
  } else if (response.status !== 200 || !isRecord(response.data) || !Array.isArray(response.data['data'])) {
    throw new Error('Expected a JSON:API collection from the installed JCB Web Services plugin.');
  }
  return {...response,data:publicData(response.data,action)};
}

export async function probeJcbApiResource(api: JoomlaApiTransport, config: ApiConfig, action: JcbApiAction): Promise<boolean> {
  const list = getJcbApiAction(`jcb.api.${action.resource}.list`);
  if (list?.operation !== 'list') return false;
  try {
    await readJcbApiAction(api,config,list,list.paginated ? {limit:1} : {});
    return true;
  } catch { return false; }
}

export async function prepareJcbApiWrite(api: JoomlaApiTransport, config: ApiConfig, action: JcbApiAction, input: Document): Promise<JcbApiPlan> {
  if (action.method === 'GET') throw new Error('Choose a writable JCB action.');
  if (action.operation === 'create' && action.sourceCreateDisabled) throw new Error('The installed JCB translation form disables source on create.');
  let request = resolveJcbApiRequest(action,input);
  const fields = Object.keys(request.body ?? {}).sort();
  const identity = action.identifier ? {kind:action.identifier,value:readIdentity(action.identifier,input[action.identifier])!} : undefined;
  const prior = identity ? await readItem(api,config,action,identity) : undefined;
  let retainedSourceHash: string | undefined;
  if (action.operation === 'update' && action.resource === 'language_translations' && action.fields['source']?.readonly && action.fields['source'].disabled) {
    if (typeof prior?.fields['source'] !== 'string') throw new Error('Cannot independently read the immutable translation source.');
    retainedSourceHash = digest(prior.fields['source']);
    // The native controller backfills omitted columns. Explicit null lets the native
    // disabled form field be discarded, preserving the already-bound original.
    request = {...request,body:{...request.body,source:null}};
  }
  let generatedGuid: string | undefined;
  if (action.operation === 'create') {
    itemAction(action,'id');
    const guid = action.fields['guid'];
    if (guid?.required && guid.serverGenerated === false && !guid.default && !guid.showon && !action.dynamicRequired && request.body?.['guid'] === undefined) {
      generatedGuid = randomUUID();
      request = {...request,body:{...request.body,guid:generatedGuid}};
      fields.push('guid');
    }
    if (!action.dynamicRequired) {
      for (const [name, field] of Object.entries(action.fields)) {
        if (field.required && !field.default && !field.showon && !field.disabled && !field.readonly &&
          !field.requestOnly && !field.serverGenerated && !Object.hasOwn(request.body ?? {},name)) {
          throw new Error(`The JCB form requires ${name} for creation.`);
        }
      }
    }
  }
  if (prior?.etag) request = {...request,etag:prior.etag};
  return {
    action:action.id,request,
    ...(identity ? {identity} : {}),
    ...(retainedSourceHash ? {retainedSourceHash} : {}),
    ...(prior && action.operation === 'delete' ? {alreadyTrashed:String(prior.fields['published'] ?? prior.fields['state']) === '-2'} : {}),
    preview:{action:action.id,method:request.method,path:request.path,fields,
      ...(identity ? {identifier:identity.value} : {}),
      ...(generatedGuid ? {generatedGuid} : {}),
      ...(prior ? {preconditionFingerprint:digest(prior.fields)} : {})},
  };
}

function equivalent(field: JcbField | undefined, expected: unknown, actual: unknown): boolean {
  if (sortedJson(expected) === sortedJson(actual)) return true;
  if (!field) return false;
  // Comparison is field-specific; numeric-looking source/text values must remain exact.
  if (/^(?:int|integer|intval|uint)$/i.test(field.filter ?? '') || /^(?:integer|number|radio)$/i.test(field.type)) {
    return ['string','number'].includes(typeof expected) && ['string','number'].includes(typeof actual) && String(expected) === String(actual);
  }
  if (field.type.toLowerCase() === 'subform' && typeof actual === 'string') {
    try { return sortedJson(expected) === sortedJson(JSON.parse(actual)); } catch { return false; }
  }
  return false;
}

function locationId(config: ApiConfig, action: JcbApiAction, location?: string): string | undefined {
  if (!location) return undefined;
  try {
    const base = new URL(config.baseUrl);
    const url = new URL(location,base);
    const id = readIdentity('id',url.pathname.split('/').at(-1));
    if (!id || url.origin !== base.origin || url.username || url.password || url.search || url.hash) return undefined;
    const getPath = itemPath(itemAction(action,'id'),id);
    const root = base.pathname.replace(/\/$/,'') + '/api/index.php/';
    return url.pathname === root + getPath ? id : undefined;
  } catch { return undefined; }
}

function uncertain(status: number | undefined, reason: string, id?: string): JcbApiWriteResult {
  return {mutation:status === undefined ? null : {status}, verification:{status:'uncertain', reason, ...(id ? {id} : {})}};
}

export async function applyJcbApiWrite(api: JoomlaApiTransport, config: ApiConfig, action: JcbApiAction, plan: JcbApiPlan, idempotencyKey: string): Promise<JcbApiWriteResult> {
  if (action.method === 'GET' || plan.action !== action.id || plan.request.method !== action.method ||
    plan.request.path !== (action.identifier ? itemPath(action,plan.identity?.value) : action.path)) throw new Error('The JCB plan does not match the action.');
  if (plan.identity) {
    const current = await readItem(api,config,action,plan.identity);
    if (digest(current.fields) !== plan.preview.preconditionFingerprint || (plan.request.etag && current.etag !== plan.request.etag)) {
      throw new Error('The JCB record changed after planning. Review a new plan.');
    }
  }
  let status: number | undefined;
  let identity = plan.identity;
  try {
    const mutation = await api.request(config,{...plan.request,idempotencyKey});
    status = mutation.status;
    if (status < 200 || status >= 300) return uncertain(status,'Joomla did not acknowledge the JCB mutation.');
    if (!identity) {
      // Response links do not select hosts or paths. Only an ID in the accepted
      // mutation can be bound to a separately registered, same-site item read.
      const item = isRecord(mutation.data) && isRecord(mutation.data['data']) ? mutation.data['data'] : undefined;
      const responseId = readIdentity('id',item?.['id']);
      const attributes = isRecord(item?.['attributes']) ? item['attributes'] : undefined;
      const attributeId = readIdentity('id',attributes?.['id']);
      if (responseId && attributeId && responseId !== attributeId) return uncertain(status,'Joomla returned conflicting identifiers for the created item.');
      const id = responseId ?? attributeId ?? locationId(config,action,mutation.headers['location']);
      if (!id) return uncertain(status,'Created item identity was absent from the native response.');
      identity = {kind:'id',value:id};
    }
    if (action.operation === 'delete') {
      try {
        const existing = await readItem(api,config,action,identity);
        if (!plan.alreadyTrashed && String(existing.fields['published'] ?? existing.fields['state']) === '-2') {
          return {mutation:{status},verification:{status:'verified',id:identity.value,fields:['trashed']}};
        }
        return uncertain(status,'The JCB record is still present after deletion.',identity.value);
      } catch (error) {
        if (!(error instanceof JoomlaApiError) || error.httpStatus !== 404) throw error;
        if (!(await probeJcbApiResource(api,config,action))) return uncertain(status,'The item disappeared but the collection could not be independently read.',identity.value);
      }
    } else {
      const current = await readItem(api,config,action,identity);
      if (plan.retainedSourceHash && digest(current.fields['source']) !== plan.retainedSourceHash) {
        return uncertain(status,'The immutable translation source could not be verified.',identity.value);
      }
      for (const field of plan.preview.fields) {
        if (!Object.hasOwn(current.fields,field) || !equivalent(action.fields[field],plan.request.body?.[field],current.fields[field])) {
          return uncertain(status,`Read-back did not verify the approved field ${field}.`,identity.value);
        }
      }
    }
    return {mutation:{status},verification:{status:'verified',id:identity.value,fields:plan.preview.fields}};
  } catch (error) {
    return uncertain(status ?? (error instanceof JoomlaApiError ? error.httpStatus : undefined),
      'The JCB request was dispatched but its effects could not be verified. Inspect the record before retrying.',identity?.value);
  }
}
