import type { SiteConfig } from '../config/schema.js';
import type { JsonSchema } from '../contracts/action-catalog.js';
import type { JoomlaCliTransport } from '../infrastructure/cli/joomla-cli-client.js';
import { operationFingerprint } from '../security/confirmation-service.js';
import { jcbJobDirectory, safeArtifactName, redispatchJcbJob, submitJcbJob, type JcbJobPayload, type JcbArtifact, type JcbOutcome } from './jobs.js';

type Fields = Readonly<Record<string, unknown>>;

export interface JcbCommandDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly toolset: 'jcb.execute';
  readonly risk: 'high';
}

export function isJcbCommandId(id: string): boolean {
  return id === 'jcb.compile.component' || /^jcb\.(get|init|pull|push|reset)\.[a-z][a-z0-9_]{0,95}$/.test(id);
}

function object(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function listJcbCommands(description: unknown): readonly JcbCommandDescriptor[] {
  if (!object(description) || !Array.isArray(description['actions'])) return [];
  const result: JcbCommandDescriptor[] = [];
  for (const entry of description['actions']) {
    if (!object(entry) || typeof entry['name'] !== 'string' || !isJcbCommandId(entry['name']) || entry['risk'] !== 'high'
        || !object(entry['effective']) || entry['effective']['allowed'] !== true) continue;
    const schema = entry['inputSchema'];
    if (!object(schema) || !object(schema['properties'])) continue;
    const options = schema['properties']['options'];
    if (!object(options) || options['type'] !== 'object' || options['additionalProperties'] !== false ||
        !object(options['properties'])) continue;
    const id = entry['name'];
    if (result.some((item) => item.id === id)) throw new Error('Duplicate installed JCB command identity.');
    result.push({
      id, title: id.replace(/^jcb\./, 'componentbuilder:').replaceAll('.', ':'),
      description: typeof entry['description'] === 'string' ? entry['description'] : id,
      toolset: 'jcb.execute', risk: 'high',
      // Native dry-run and confirmation controls are exclusively supplied by the edge.
      inputSchema: { type: 'object', properties: { options }, required: ['options'], additionalProperties: false },
    });
  }
  return result;
}

function normalizedInput(descriptor: JcbCommandDescriptor, raw: unknown): Fields {
  if (!object(raw) || Object.keys(raw).length !== 1 || !object(raw['options'])) {
    throw new Error('Expected a JCB command input containing only its installed options object.');
  }
  const properties = descriptor.inputSchema.properties['options']?.['properties'];
  if (!object(properties)) throw new Error('Invalid installed JCB option definitions.');
  const options = raw['options'];
  for (const [name, value] of Object.entries(options)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || ['constructor', 'prototype'].includes(name) || !Object.hasOwn(properties, name)) {
      throw new Error('Unknown or unreviewed JCB command option.');
    }
    // PHP validates the exact installed option types, selectors and semantic restrictions.
    // Refuse caller-owned prototype chains and non-JSON values before crossing the boundary.
    if (typeof value !== 'string' && typeof value !== 'boolean' && !Number.isSafeInteger(value)) {
      throw new Error('JCB command options must be scalar native values.');
    }
  }
  if (Buffer.byteLength(JSON.stringify(options)) > 131072) throw new Error('JCB command input exceeds its size limit.');
  return { options: structuredClone(options) };
}

function dispatchResult(data: unknown): Fields {
  if (!object(data) || !object(data['result'])) throw new Error('Missing JCB companion result.');
  return data['result'];
}

export async function prepareJcbCommand(cli: JoomlaCliTransport, site: SiteConfig, action: string, raw: unknown) {
  if (!site.cli || !isJcbCommandId(action)) throw new Error('JCB command requires a reviewed local companion action.');
  await jcbJobDirectory(site);
  const descriptor = listJcbCommands((await cli.describe(site.cli)).data).find((entry) => entry.id === action);
  if (!descriptor) throw new Error('JCB command is unavailable for the installed plugin or configured actor.');
  const actionInput = normalizedInput(descriptor, raw);
  const native = dispatchResult((await cli.dispatch(site.cli, action, { ...actionInput, dryRun: true })).data);
  const state = native['preState'];
  const contract = object(state) ? state['contractFingerprint'] : undefined;
  if (native['applied'] !== false || native['dryRun'] !== true || typeof contract !== 'string' || !/^[a-f0-9]{64}$/.test(contract)) {
    throw new Error('The installed JCB companion did not return a non-mutating, fingerprinted command preflight.');
  }
  const requested = native['requestedState'];
  if (!object(requested) || requested['command'] !== descriptor.title) {
    throw new Error('The companion preview does not identify the requested JCB command.');
  }
  const requestedState = normalizedInput(descriptor, { options: requested['options'] });
  return {
    title: descriptor.title, actionInput,
    preflight: {
      dryRun: true, applied: false, command: descriptor.title, preState: { contractFingerprint: contract },
      requestedState,
    },
  };
}

function outcome(result: Fields, action: string): JcbOutcome {
  if (result['applied'] !== true || result['dryRun'] !== false || !object(result['verification'])) {
    throw new Error('Missing JCB execution evidence.');
  }
  const evidence = result['verification'];
  const status = evidence['status'];
  if (status !== 'verified' && status !== 'partial' && status !== 'unverified') throw new Error('Unknown JCB verification state.');
  const artifacts: JcbArtifact[] = [];
  if (action === 'jcb.compile.component') {
    const archives = result['artifacts'];
    if (!Array.isArray(archives) || archives.length === 0 || archives.length > 128) throw new Error('Missing or excessive compiled archives.');
    let totalBytes = 0;
    for (const archive of archives) {
      if (!object(archive) || !safeArtifactName(archive['name']) || typeof archive['size'] !== 'number' ||
          !Number.isSafeInteger(archive['size']) || archive['size'] < 1 || typeof archive['sha256'] !== 'string' ||
          !/^[a-f0-9]{64}$/.test(archive['sha256']) || artifacts.some((file) => file.name === archive['name'])) {
        throw new Error('Invalid compiled archive receipt.');
      }
      totalBytes += archive['size'];
      if (totalBytes > 1_073_741_824) throw new Error('Compiled archives exceed the collection limit.');
      artifacts.push({ name: archive['name'], size: archive['size'], sha256: archive['sha256'] });
    }
  }
  const counts = Object.fromEntries(Object.entries(evidence).filter((entry): entry is [string, number | boolean] => {
    const [key, value] = entry;
    return /^[a-z][A-Za-z0-9]{0,40}$/.test(key) && (typeof value === 'boolean' || Number.isSafeInteger(value));
  }));
  return { verification: status, counts, artifacts };
}

// Only the write service calls this function, after consuming the principal's signed plan and matching grant.
export async function applyJcbCommand(
  cli: JoomlaCliTransport, site: SiteConfig, action: string, input: unknown, preflight: Fields,
  principal: string, idempotencyKey: string,
) {
  if (!site.cli || !isJcbCommandId(action) || !object(input)) throw new Error('Invalid confirmed JCB operation.');
  const payload: JcbJobPayload = { action, idempotencyKey, input: structuredClone(input), preflight };
  const fingerprint = operationFingerprint(commandOperation(site, payload));
  return submitJcbJob(site, principal, payload, fingerprint, commandWorker(cli, site));
}

export function redispatchJcbCommand(cli: JoomlaCliTransport, site: SiteConfig, principal: string, jobId: string) {
  return redispatchJcbJob(site, principal, jobId, commandWorker(cli, site));
}

function commandOperation(site: SiteConfig, payload: JcbJobPayload) {
  const { action, input, idempotencyKey } = payload;
  return { site: site.id, action, method: 'POST' as const, path: 'companion:' + action, idempotencyKey, summary: action, actionInput: input };
}

function commandWorker(cli: JoomlaCliTransport, site: SiteConfig) {
  return async (payload: JcbJobPayload, work: string, markStarted: () => void) => {
    const { action, input, preflight } = payload;
    if (!site.cli || !isJcbCommandId(action)) throw new Error('The JCB command is unavailable.');
    const operation = commandOperation(site, payload);
    const fresh = await prepareJcbCommand(cli, site, action, input);
    if (operationFingerprint({ ...operation, preflight: fresh.preflight }) !== operationFingerprint({ ...operation, preflight })) {
      throw new Error('JCB command preconditions changed since planning.');
    }
    markStarted();
    const native = await cli.dispatch(site.cli, action, {
      ...fresh.actionInput, dryRun: false, _edgeConfirmed: true,
      _expectedContractFingerprint: fresh.preflight.preState.contractFingerprint,
    }, { jcbArtifactDirectory: work });
    return outcome(dispatchResult(native.data), action);
  };
}
