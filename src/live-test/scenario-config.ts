import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  crudFixtureDefinitions,
  crudFixtureOrder,
  type LiveFixtureRecord,
} from './fixtures.js';

export const LIVE_SCENARIO_SCHEMA = 'joomengine.joomla-mcp.live-scenario/v1' as const;

const referenceName = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const recordKey = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const templateReference = /\{\{([a-z0-9][a-z0-9._-]{0,127})\.([a-zA-Z0-9_-]+)\}\}/gu;
const runTemplate = /\{\{(seed|lane|token)\}\}/gu;

const selectionSchema = z.object({
  profile: z.enum(['read', 'crud', 'full']).default('full'),
  joomlaPaths: z.array(z.enum(['api', 'cli'])).min(1).default(['api', 'cli']),
  mcpTransports: z.array(z.enum(['stdio', 'http'])).min(1).default(['stdio', 'http']),
  families: z.array(z.string().min(1)).default([]),
}).strict().default({
  profile: 'full',
  joomlaPaths: ['api', 'cli'],
  mcpTransports: ['stdio', 'http'],
  families: [],
});

const safetySchema = z.object({
  confirmMutations: z.boolean().default(false),
  disposable: z.boolean().default(false),
  cleanup: z.enum(['always', 'never']).default('always'),
}).strict();

const progressSchema = z.object({
  enabled: z.boolean().default(true),
  heartbeatSeconds: z.number().int().min(5).max(300).default(30),
}).strict().default({ enabled: true, heartbeatSeconds: 30 });

const updateSchema = z.object({
  name: z.string().min(1).max(120),
  data: z.record(z.string(), z.unknown()),
}).strict();

const recordSchema = z.object({
  key: z.string().regex(recordKey),
  generate: z.boolean().default(false),
  data: z.record(z.string(), z.unknown()).optional(),
  updates: z.array(updateSchema).default([]),
  verify: z.record(z.string(), z.unknown()).optional(),
  deleteAfterVerify: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (!value.generate && value.data === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A scenario record must set generate=true or provide data.',
      path: ['data'],
    });
  }
});

const resourceSchema = z.object({
  records: z.array(recordSchema).min(1),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (keys.has(record.key)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate scenario record key ${record.key}.`,
        path: ['records', index, 'key'],
      });
    }
    keys.add(record.key);
  }
});

const specialActionsSchema = z.object({
  include: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
}).strict();

const rawScenarioSchema = z.object({
  schema: z.literal(LIVE_SCENARIO_SCHEMA),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).optional(),
  target: z.object({
    configurationFile: z.string().min(1).default('config/sites.json'),
    site: z.string().min(1).optional(),
    actorUsernames: z.object({
      api: z.string().min(1).max(150).optional(),
      cli: z.string().min(1).max(150).optional(),
    }).strict().optional(),
  }).strict().default({ configurationFile: 'config/sites.json' }),
  selection: selectionSchema,
  safety: safetySchema,
  progress: progressSchema,
  resources: z.record(z.string(), resourceSchema).default({}),
  specialActions: specialActionsSchema.optional(),
}).strict();

export interface LiveScenarioReference {
  readonly $ref: string;
  readonly field?: string;
}

export interface LiveScenarioReferences {
  readonly $refs: readonly string[];
  readonly field?: string;
}

export interface LiveScenarioTemplate {
  readonly $template: string;
}

export interface LiveScenarioUpdate {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LiveScenarioRecord {
  readonly key: string;
  readonly generate: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly updates: readonly LiveScenarioUpdate[];
  readonly verify?: Readonly<Record<string, unknown>>;
  readonly deleteAfterVerify: boolean;
}

export interface LiveScenarioResource {
  readonly records: readonly LiveScenarioRecord[];
}

export interface LiveScenarioConfiguration {
  readonly schema: typeof LIVE_SCENARIO_SCHEMA;
  readonly name: string;
  readonly description?: string;
  readonly target: {
    readonly configurationFile: string;
    readonly site?: string;
    readonly actorUsernames?: {
      readonly api?: string;
      readonly cli?: string;
    };
  };
  readonly selection: {
    readonly profile: 'read' | 'crud' | 'full';
    readonly joomlaPaths: readonly ('api' | 'cli')[];
    readonly mcpTransports: readonly ('stdio' | 'http')[];
    readonly families: readonly string[];
  };
  readonly safety: {
    readonly confirmMutations: boolean;
    readonly disposable: boolean;
    readonly cleanup: 'always' | 'never';
  };
  readonly progress: {
    readonly enabled: boolean;
    readonly heartbeatSeconds: number;
  };
  readonly resources: Readonly<Record<string, LiveScenarioResource>>;
  readonly specialActions?: {
    readonly include: readonly string[];
    readonly exclude: readonly string[];
  };
}

export interface OrderedLiveScenarioRecord {
  readonly baseId: string;
  readonly reference: string;
  readonly definition: LiveScenarioRecord;
  readonly dependencyReferences: readonly string[];
}

export type LiveScenarioRecordRegistry = ReadonlyMap<string, LiveFixtureRecord>;

export interface LiveScenarioExpansionContext {
  readonly scenario: string;
  readonly seed: string;
  readonly lane: string;
}

export function defaultLiveScenarioFile(): string {
  return fileURLToPath(new URL('../../config/live-test.default.json', import.meta.url));
}

export async function loadLiveScenarioConfiguration(
  file = defaultLiveScenarioFile(),
): Promise<LiveScenarioConfiguration> {
  const absoluteFile = resolve(file);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absoluteFile, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read live scenario configuration ${absoluteFile}: ${reason}`, {
      cause: error,
    });
  }
  const parsed = rawScenarioSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid live scenario configuration ${absoluteFile}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const scenario = deepFreeze(parsed.data) as LiveScenarioConfiguration;
  validateScenarioConfiguration(scenario);
  return scenario;
}

export function validateScenarioConfiguration(
  scenario: LiveScenarioConfiguration,
): void {
  const resourceEntries = Object.entries(scenario.resources);
  if (resourceEntries.length === 0 && scenario.specialActions === undefined) {
    throw new Error('A live scenario must configure at least one resource family or special action.');
  }
  if (scenario.resources['messages.messages'] !== undefined) {
    for (const path of scenario.selection.joomlaPaths) {
      if (scenario.target.actorUsernames?.[path] === undefined) {
        throw new Error(
          `Live scenarios that test private messages must set target.actorUsernames.${path} ` +
          'to the account authenticated on that Joomla path.',
        );
      }
    }
  }

  const knownBases = new Set(crudFixtureDefinitions.keys());
  const references = new Set<string>();
  for (const [baseId, resource] of resourceEntries) {
    if (!knownBases.has(baseId)) {
      throw new Error(`Live scenario resource ${baseId} is not a catalogued CRUD base.`);
    }
    for (const record of resource.records) {
      const reference = `${baseId}.${record.key}`;
      if (references.has(reference)) {
        throw new Error(`Duplicate live scenario reference ${reference}.`);
      }
      references.add(reference);
      validateHumanReferences(baseId, record);
    }
  }

  for (const [baseId, resource] of resourceEntries) {
    for (const record of resource.records) {
      for (const dependency of recordReferences(record)) {
        if (!references.has(dependency)) {
          throw new Error(
            `Live scenario ${baseId}.${record.key} references missing record ${dependency}.`,
          );
        }
      }
    }
  }

  orderedLiveScenarioRecords(scenario);
}

export function orderedLiveScenarioRecords(
  scenario: LiveScenarioConfiguration,
): readonly OrderedLiveScenarioRecord[] {
  const declared = new Map<string, OrderedLiveScenarioRecord>();
  const firstReferenceByBase = new Map<string, string>();
  for (const baseId of crudFixtureOrder) {
    const resource = scenario.resources[baseId];
    if (resource === undefined) continue;
    for (const record of resource.records) {
      const reference = `${baseId}.${record.key}`;
      firstReferenceByBase.set(baseId, firstReferenceByBase.get(baseId) ?? reference);
      declared.set(reference, {
        baseId,
        reference,
        definition: record,
        dependencyReferences: [],
      });
    }
  }

  for (const [reference, entry] of declared) {
    const dependencies = new Set(recordReferences(entry.definition));
    if (entry.definition.generate) {
      for (const dependencyBase of crudFixtureDefinitions.get(entry.baseId)?.dependencies ?? []) {
        const dependency = firstReferenceByBase.get(dependencyBase);
        if (dependency === undefined) {
          throw new Error(
            `Generated live scenario ${reference} requires configured resource ${dependencyBase}.`,
          );
        }
        dependencies.add(dependency);
      }
    }
    declared.set(reference, {
      ...entry,
      dependencyReferences: Object.freeze([...dependencies]),
    });
  }

  const output: OrderedLiveScenarioRecord[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (reference: string): void => {
    if (visited.has(reference)) return;
    if (visiting.has(reference)) {
      throw new Error(`Live scenario reference dependency cycle at ${reference}.`);
    }
    const entry = declared.get(reference);
    if (entry === undefined) {
      throw new Error(`Live scenario dependency ${reference} is not declared.`);
    }
    visiting.add(reference);
    for (const dependency of entry.dependencyReferences) visit(dependency);
    visiting.delete(reference);
    visited.add(reference);
    output.push(entry);
  };
  for (const reference of declared.keys()) visit(reference);
  return Object.freeze(output);
}

export function scenarioActionSelected(
  actionId: string,
  configuration: LiveScenarioConfiguration,
): boolean {
  if (
    actionId === 'users.users.list' &&
    configuration.resources['messages.messages'] !== undefined
  ) {
    return true;
  }
  const crudMatch = /^(.*)\.(list|get|create|update|delete)$/u.exec(actionId);
  if (crudMatch !== null) return configuration.resources[crudMatch[1]!] !== undefined;
  const actions = configuration.specialActions;
  if (actions === undefined || actions.exclude.includes(actionId)) return false;
  return actions.include.includes('*') || actions.include.some((entry) =>
    actionId === entry || actionId.startsWith(`${entry}.`));
}

export function resolveLiveScenarioValue(
  value: unknown,
  registry: LiveScenarioRecordRegistry,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveLiveScenarioValue(entry, registry));
  }
  if (!isPlainObject(value)) return value;
  if ('$ref' in value) {
    const reference = parseReference(value);
    return referenceField(registry, reference.$ref, reference.field);
  }
  if ('$refs' in value) {
    const references = parseReferences(value);
    return references.$refs.map((reference) =>
      referenceField(registry, reference, references.field));
  }
  if ('$template' in value) {
    const template = parseTemplate(value).$template;
    return template.replace(templateReference, (_match, reference: string, field: string) =>
      String(referenceField(registry, reference, field)));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveLiveScenarioValue(entry, registry),
    ]),
  );
}

export function expandLiveScenarioValue(
  value: unknown,
  context: LiveScenarioExpansionContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => expandLiveScenarioValue(entry, context));
  }
  if (typeof value === 'string') {
    const token = createHash('sha256')
      .update(`${context.scenario}\0${context.seed}\0${context.lane}`)
      .digest('hex')
      .slice(0, 12);
    const replacements: Readonly<Record<string, string>> = {
      seed: context.seed,
      lane: context.lane,
      token,
    };
    return value.replace(runTemplate, (_match, name: string) => replacements[name]!);
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      expandLiveScenarioValue(entry, context),
    ]),
  );
}

export function recordReferences(record: LiveScenarioRecord): readonly string[] {
  const references = new Set<string>();
  collectReferences(record.data, references);
  for (const update of record.updates) collectReferences(update.data, references);
  collectReferences(record.verify, references);
  return Object.freeze([...references]);
}

function collectReferences(value: unknown, references: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, references);
    return;
  }
  if (!isPlainObject(value)) return;
  if ('$ref' in value) {
    references.add(parseReference(value).$ref);
    return;
  }
  if ('$refs' in value) {
    for (const reference of parseReferences(value).$refs) references.add(reference);
    return;
  }
  if ('$template' in value) {
    for (const match of parseTemplate(value).$template.matchAll(templateReference)) {
      references.add(match[1]!);
    }
    return;
  }
  for (const entry of Object.values(value)) collectReferences(entry, references);
}

function referenceField(
  registry: LiveScenarioRecordRegistry,
  reference: string,
  field = 'id',
): unknown {
  const record = registry.get(reference);
  if (record === undefined) {
    throw new Error(`Live scenario reference ${reference} has not been created successfully.`);
  }
  if (field === 'id') return record.id;
  const value = record.attributes[field];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Live scenario reference ${reference} has no usable ${field} field.`);
  }
  return value;
}

function parseReference(value: Record<string, unknown>): LiveScenarioReference {
  const keys = Object.keys(value);
  const reference = value['$ref'];
  const field = value['field'];
  if (
    keys.some((key) => key !== '$ref' && key !== 'field') ||
    typeof reference !== 'string' ||
    !referenceName.test(reference) ||
    (field !== undefined && typeof field !== 'string')
  ) {
    throw new Error(`Invalid live scenario $ref object: ${JSON.stringify(value)}.`);
  }
  return { $ref: reference, ...(field === undefined ? {} : { field }) };
}

function parseReferences(value: Record<string, unknown>): LiveScenarioReferences {
  const keys = Object.keys(value);
  const references = value['$refs'];
  const field = value['field'];
  if (
    keys.some((key) => key !== '$refs' && key !== 'field') ||
    !Array.isArray(references) ||
    references.length === 0 ||
    references.some((entry) => typeof entry !== 'string' || !referenceName.test(entry)) ||
    (field !== undefined && typeof field !== 'string')
  ) {
    throw new Error(`Invalid live scenario $refs object: ${JSON.stringify(value)}.`);
  }
  return {
    $refs: references as string[],
    ...(field === undefined ? {} : { field }),
  };
}

function parseTemplate(value: Record<string, unknown>): LiveScenarioTemplate {
  const template = value['$template'];
  if (Object.keys(value).length !== 1 || typeof template !== 'string') {
    throw new Error(`Invalid live scenario $template object: ${JSON.stringify(value)}.`);
  }
  return { $template: template };
}

function validateHumanReferences(baseId: string, record: LiveScenarioRecord): void {
  if (record.data === undefined) return;
  const requiredReferenceFields: Readonly<Record<string, readonly string[]>> = {
    'content.articles': ['catid'],
    'banners.banners': ['catid', 'cid'],
    'users.users': ['groups'],
    'menus.site-items': ['menutype'],
    'modules.site': ['assigned'],
  };
  for (const field of requiredReferenceFields[baseId] ?? []) {
    const value = record.data[field];
    const multiple = field === 'groups' || field === 'assigned';
    const valid = multiple
      ? isPlainObject(value) && '$refs' in value
      : isPlainObject(value) && '$ref' in value;
    if (!valid) {
      throw new Error(
        `Live scenario ${baseId}.${record.key} must express ${field} with a named ` +
        `${multiple ? '$refs' : '$ref'} object, not a Joomla numeric ID or literal key.`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}
