import type { JsonSchema } from '../contracts/action-catalog.js';
import type { Toolset } from '../config/schema.js';
import { joomlaCrudBases } from './crud-bases.js';

export type CompanionActionRisk = 'read' | 'write' | 'high';

export interface JoomlaNativeCapability {
  readonly kind: 'joomla-runtime' | 'administrator-model' | 'console-command';
  readonly component?: `com_${string}`;
  readonly model?: string;
  readonly method: string;
}

export interface CompanionActionDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly risk: CompanionActionRisk;
  readonly toolset: Toolset;
  readonly inputSchema: JsonSchema;
  readonly native: JoomlaNativeCapability;
}

const emptyInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  additionalProperties: false,
});

const boundedListInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    offset: Object.freeze({ type: 'integer', minimum: 0, maximum: 1_000_000, default: 0 }),
    limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 }),
    search: Object.freeze({ type: 'string', maxLength: 200 }),
  }),
  additionalProperties: false,
});

const articleListInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    offset: Object.freeze({ type: 'integer', minimum: 0, maximum: 1_000_000, default: 0 }),
    limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 }),
    search: Object.freeze({ type: 'string', maxLength: 200 }),
    state: Object.freeze({ type: 'integer', minimum: -2, maximum: 2 }),
    category: Object.freeze({ type: 'integer', minimum: 1 }),
    language: Object.freeze({ type: 'string', maxLength: 50 }),
  }),
  additionalProperties: false,
});

const articleGetInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    id: Object.freeze({ type: 'integer', minimum: 1 }),
  }),
  required: Object.freeze(['id']),
  additionalProperties: false,
});

const cacheCleanInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    groups: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: Object.freeze({ type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' }),
    }),
  }),
  required: Object.freeze(['groups']),
  additionalProperties: false,
});

const stateInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    id: Object.freeze({ type: 'integer', minimum: 1 }),
    state: Object.freeze({ type: 'integer', enum: Object.freeze([-2, 0, 1, 2]) }),
  }),
  required: Object.freeze(['id', 'state']),
  additionalProperties: false,
});

const idEnabledInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    id: Object.freeze({ type: 'integer', minimum: 1 }),
    enabled: Object.freeze({ type: 'boolean' }),
  }),
  required: Object.freeze(['id', 'enabled']),
  additionalProperties: false,
});

const schedulerStateInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    id: Object.freeze({ type: 'integer', minimum: 1 }),
    state: Object.freeze({ type: 'integer', enum: Object.freeze([-2, 0, 1]) }),
  }),
  required: Object.freeze(['id', 'state']),
  additionalProperties: false,
});

const idInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({ id: Object.freeze({ type: 'integer', minimum: 1 }) }),
  required: Object.freeze(['id']),
  additionalProperties: false,
});

const siteStateInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({ offline: Object.freeze({ type: 'boolean' }) }),
  required: Object.freeze(['offline']),
  additionalProperties: false,
});

const sessionGcInputSchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    application: Object.freeze({ type: 'string', enum: Object.freeze(['site', 'administrator']), default: 'site' }),
  }),
  additionalProperties: false,
});

const fixedReadActions: readonly CompanionActionDescriptor[] = Object.freeze([
  read('system.info', 'System information', 'Return non-secret Joomla and PHP runtime versions.', 'system', 'discovery', emptyInputSchema, {
    kind: 'joomla-runtime', method: 'JVERSION and PHP_VERSION',
  }),
  read('configuration.get_safe', 'Safe application configuration', 'Return only the companion safe configuration allowlist.', 'configuration', 'configuration.read', emptyInputSchema, {
    kind: 'joomla-runtime', method: 'ConsoleApplication::get',
  }),
  read('content.articles.list', 'List articles locally', 'List articles through Joomla’s administrator Articles model.', 'content', 'content.read', articleListInputSchema, {
    kind: 'administrator-model', component: 'com_content', model: 'Articles', method: 'getItems',
  }),
  read('content.articles.get', 'Get an article locally', 'Get one article through Joomla’s administrator Article model.', 'content', 'content.read', articleGetInputSchema, {
    kind: 'administrator-model', component: 'com_content', model: 'Article', method: 'getItem',
  }),
  read('extensions.list', 'List installed extensions locally', 'List installed extensions through Joomla’s Installer Manage model.', 'extensions', 'extensions.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Manage', method: 'getItems',
  }),
  read('cache.groups.list', 'List cache groups', 'List bounded cache-group metadata through Joomla’s Cache model.', 'maintenance', 'maintenance.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_cache', model: 'Cache', method: 'getData',
  }),
  read('extensions.updates.list', 'List cached extension updates', 'List Joomla’s cached extension-update records without refreshing or installing.', 'extensions', 'extensions.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Update', method: 'getItems',
  }),
  read('extensions.discovered.list', 'List discovered extensions', 'List already-discovered Joomla extensions without scanning or installing.', 'extensions', 'extensions.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Discover', method: 'getItems',
  }),
  read('scheduler.tasks.list', 'List scheduled tasks', 'List bounded Joomla scheduled-task status without running tasks.', 'scheduler', 'maintenance.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_scheduler', model: 'Tasks', method: 'getItems',
  }),
  read('core.update.status', 'Read core update status', 'Read cached Joomla core-update status without downloading or installing an update.', 'joomla-update', 'maintenance.read', emptyInputSchema, {
    kind: 'administrator-model', component: 'com_joomlaupdate', model: 'Update', method: 'getUpdateInformation',
  }),
  read('extensions.update-sites.list', 'List extension update sites', 'List bounded non-secret Joomla extension update-site state.', 'extensions', 'extensions.read', boundedListInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Updatesites', method: 'getItems',
  }),
  read('site.state.get', 'Read site availability state', 'Read Joomla’s native offline state without exposing configuration secrets.', 'maintenance', 'maintenance.read', emptyInputSchema, {
    kind: 'joomla-runtime', method: 'JConfig::offline',
  }),
]);

const stateUnsupported = new Set([
  'menus.site',
  'menus.administrator',
  'users.users',
  'users.groups',
  'users.levels',
  'templates.site-styles',
  'templates.administrator-styles',
  'messages.messages',
]);

export const companionStateActions: readonly CompanionActionDescriptor[] = Object.freeze(
  joomlaCrudBases
    .filter((base) => !stateUnsupported.has(base.id))
    .map((base) => Object.freeze({
      id: `${base.id}.state`,
      title: `Change ${base.itemName} state`,
      description: `Change one ${base.itemName.toLocaleLowerCase('en')} state through Joomla’s fixed administrator model publish method.`,
      domain: base.domain,
      risk: 'write' as const,
      toolset: writeToolsetFor(base.toolset),
      inputSchema: stateInputSchema,
      native: Object.freeze({
        kind: 'administrator-model' as const,
        component: base.acl.component,
        method: 'publish',
      }),
    })),
);

export const companionReadActions: readonly CompanionActionDescriptor[] = fixedReadActions;

export const companionWriteActions: readonly CompanionActionDescriptor[] = Object.freeze([
  Object.freeze({
    id: 'cache.clean',
    title: 'Clean cache groups',
    description: 'Clean an explicit bounded list of cache groups through Joomla’s Cache model.',
    domain: 'maintenance',
    risk: 'write' as const,
    toolset: 'maintenance.admin' as const,
    inputSchema: cacheCleanInputSchema,
    native: Object.freeze({
      kind: 'administrator-model' as const,
      component: 'com_cache' as const,
      model: 'Cache',
      method: 'cleanlist',
    }),
  }),
  operation('cache.expired.purge', 'Purge expired cache entries', 'Garbage-collect expired entries through Joomla’s Cache model.', 'maintenance', 'maintenance.admin', 'write', emptyInputSchema, {
    kind: 'administrator-model', component: 'com_cache', model: 'Cache', method: 'purge',
  }),
  operation('extensions.discovered.refresh', 'Refresh extension discovery', 'Refresh discovered-extension metadata through Joomla’s Installer Discover model.', 'extensions', 'extensions.admin', 'write', emptyInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Discover', method: 'discover',
  }),
  operation('extensions.updates.refresh', 'Refresh extension update metadata', 'Refresh stable extension-update metadata through Joomla’s Installer Update model.', 'extensions', 'extensions.admin', 'write', emptyInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Update', method: 'purge + findUpdates',
  }),
  operation('extensions.state.set', 'Set installed extension state', 'Enable or disable one installed extension through Joomla’s Installer Manage model.', 'extensions', 'extensions.admin', 'high', idEnabledInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Manage', method: 'publish',
  }),
  operation('extensions.update-sites.state.set', 'Set extension update-site state', 'Enable or disable one Joomla extension update site through Joomla’s Updatesites model.', 'extensions', 'extensions.admin', 'high', idEnabledInputSchema, {
    kind: 'administrator-model', component: 'com_installer', model: 'Updatesites', method: 'publish',
  }),
  operation('scheduler.tasks.state.set', 'Set scheduled task state', 'Enable, disable, or trash one task through Joomla’s native scheduler:state command.', 'scheduler', 'maintenance.admin', 'high', schedulerStateInputSchema, {
    kind: 'console-command', component: 'com_scheduler', model: 'Task', method: 'scheduler:state',
  }),
  operation('scheduler.tasks.run', 'Run one scheduled task', 'Run one explicit task through Joomla’s native scheduler:run command.', 'scheduler', 'maintenance.admin', 'high', idInputSchema, {
    kind: 'console-command', component: 'com_scheduler', model: 'Task', method: 'scheduler:run --id',
  }),
  operation('site.state.set', 'Set site availability state', 'Set and verify Joomla offline state through the native site:down or site:up command.', 'maintenance', 'maintenance.admin', 'high', siteStateInputSchema, {
    kind: 'console-command', component: 'com_config', method: 'site:down or site:up',
  }),
  operation('sessions.data.gc', 'Garbage-collect session data', 'Run Joomla’s native session:gc for the site or administrator application.', 'maintenance', 'maintenance.admin', 'high', sessionGcInputSchema, {
    kind: 'console-command', component: 'com_config', method: 'session:gc',
  }),
  operation('sessions.metadata.gc', 'Garbage-collect session metadata', 'Run Joomla’s native session:metadata:gc command.', 'maintenance', 'maintenance.admin', 'high', emptyInputSchema, {
    kind: 'console-command', component: 'com_config', method: 'session:metadata:gc',
  }),
  ...companionStateActions,
]);

export const companionActions: readonly CompanionActionDescriptor[] = Object.freeze([
  ...companionReadActions,
  ...companionWriteActions,
]);

const readById = new Map(companionReadActions.map((action) => [action.id, action]));
const writeById = new Map(companionWriteActions.map((action) => [action.id, action]));
const crudReadIds = new Set(
  joomlaCrudBases.flatMap((base) => [`${base.id}.list`, `${base.id}.get`]),
);
const crudWriteIds = new Set(
  joomlaCrudBases.flatMap((base) => [`${base.id}.create`, `${base.id}.update`, `${base.id}.delete`]),
);

export function getCompanionReadAction(id: string): CompanionActionDescriptor | undefined {
  return readById.get(id);
}

export function getCompanionWriteAction(id: string): CompanionActionDescriptor | undefined {
  return writeById.get(id);
}

export function supportsCompanionReadAction(id: string): boolean {
  return readById.has(id) || crudReadIds.has(id);
}

export function supportsCompanionWriteAction(id: string): boolean {
  return writeById.has(id) || crudWriteIds.has(id);
}

export function normalizeCompanionReadInput(actionId: string, value: unknown): Readonly<Record<string, unknown>> {
  const action = getCompanionReadAction(actionId);
  if (action === undefined) throw new Error(`Unknown Joomla companion read action: ${actionId}.`);
  const input = plainObject(value);

  if (action.inputSchema === emptyInputSchema) {
    rejectUnknown(input, []);
    return Object.freeze({});
  }
  if (actionId === 'content.articles.get') {
    rejectUnknown(input, ['id']);
    return Object.freeze({ id: boundedInteger(input['id'], 'id', 1, 2_147_483_647) });
  }

  const allowed = actionId === 'content.articles.list'
    ? ['offset', 'limit', 'search', 'state', 'category', 'language']
    : ['offset', 'limit', 'search'];
  rejectUnknown(input, allowed);
  const normalized: Record<string, unknown> = {
    offset: optionalInteger(input['offset'], 'offset', 0, 1_000_000, 0),
    limit: optionalInteger(input['limit'], 'limit', 1, 100, 20),
  };

  if (input['search'] !== undefined) normalized['search'] = boundedText(input['search'], 'search', 200);
  if (input['state'] !== undefined) normalized['state'] = boundedInteger(input['state'], 'state', -2, 2);
  if (input['category'] !== undefined) normalized['category'] = boundedInteger(input['category'], 'category', 1, 2_147_483_647);
  if (input['language'] !== undefined) normalized['language'] = boundedText(input['language'], 'language', 50);
  return Object.freeze(normalized);
}

export function normalizeCompanionWriteInput(actionId: string, value: unknown): Readonly<Record<string, unknown>> {
  const action = getCompanionWriteAction(actionId);
  if (action === undefined) throw new Error(`Unknown Joomla companion write action: ${actionId}.`);
  const input = plainObject(value);

  if (actionId === 'cache.clean') {
    rejectUnknown(input, ['groups']);
    if (!Array.isArray(input['groups']) || input['groups'].length < 1 || input['groups'].length > 50) {
      throw new Error('groups must be a list containing between 1 and 50 cache group names.');
    }
    const groups = input['groups'].map((group) => {
      if (typeof group !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(group)) {
        throw new Error('Every cache group must use 1-128 safe name characters.');
      }
      return group;
    });
    if (new Set(groups).size !== groups.length) throw new Error('Cache group names must be unique.');
    return Object.freeze({ groups: Object.freeze(groups) });
  }

  if ([
    'cache.expired.purge',
    'extensions.discovered.refresh',
    'extensions.updates.refresh',
    'sessions.metadata.gc',
  ].includes(actionId)) {
    rejectUnknown(input, []);
    return Object.freeze({});
  }

  if (actionId === 'extensions.state.set' || actionId === 'extensions.update-sites.state.set') {
    rejectUnknown(input, ['id', 'enabled']);
    if (typeof input['enabled'] !== 'boolean') throw new Error('enabled must be a boolean.');
    return Object.freeze({
      id: boundedInteger(input['id'], 'id', 1, 2_147_483_647),
      enabled: input['enabled'],
    });
  }

  if (actionId === 'scheduler.tasks.state.set') {
    rejectUnknown(input, ['id', 'state']);
    const state = boundedInteger(input['state'], 'state', -2, 1);
    if (![-2, 0, 1].includes(state)) throw new Error('state must be one of -2, 0, or 1.');
    return Object.freeze({ id: boundedInteger(input['id'], 'id', 1, 2_147_483_647), state });
  }

  if (actionId === 'scheduler.tasks.run') {
    rejectUnknown(input, ['id']);
    return Object.freeze({ id: boundedInteger(input['id'], 'id', 1, 2_147_483_647) });
  }

  if (actionId === 'site.state.set') {
    rejectUnknown(input, ['offline']);
    if (typeof input['offline'] !== 'boolean') throw new Error('offline must be a boolean.');
    return Object.freeze({ offline: input['offline'] });
  }

  if (actionId === 'sessions.data.gc') {
    rejectUnknown(input, ['application']);
    const application = input['application'] ?? 'site';
    if (application !== 'site' && application !== 'administrator') {
      throw new Error('application must be site or administrator.');
    }
    return Object.freeze({ application });
  }

  rejectUnknown(input, ['id', 'state']);
  const state = boundedInteger(input['state'], 'state', -2, 2);
  if (![-2, 0, 1, 2].includes(state)) throw new Error('state must be one of -2, 0, 1, or 2.');
  return Object.freeze({
    id: boundedInteger(input['id'], 'id', 1, 2_147_483_647),
    state,
  });
}

function read(
  id: string,
  title: string,
  description: string,
  domain: string,
  toolset: Toolset,
  inputSchema: JsonSchema,
  native: JoomlaNativeCapability,
): CompanionActionDescriptor {
  return Object.freeze({ id, title, description, domain, risk: 'read', toolset, inputSchema, native: Object.freeze(native) });
}

function operation(
  id: string,
  title: string,
  description: string,
  domain: string,
  toolset: Toolset,
  risk: 'write' | 'high',
  inputSchema: JsonSchema,
  native: JoomlaNativeCapability,
): CompanionActionDescriptor {
  return Object.freeze({ id, title, description, domain, risk, toolset, inputSchema, native: Object.freeze(native) });
}

function writeToolsetFor(toolset: Toolset): Toolset {
  switch (toolset) {
    case 'content.read': return 'content.write';
    case 'structure.read': return 'structure.write';
    case 'users.read': return 'users.admin';
    case 'maintenance.read': return 'maintenance.admin';
    default: throw new Error(`Toolset ${toolset} has no companion state-write mapping.`);
  }
}

function plainObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Companion action input must be an object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function rejectUnknown(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key)).sort();
  if (unknown.length > 0) throw new Error(`Unsupported companion action input properties: ${unknown.join(', ')}.`);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function optionalInteger(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  return value === undefined ? fallback : boundedInteger(value, name, minimum, maximum);
}

function boundedText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength || value.includes('\0')) {
    throw new Error(`${name} must be a string of at most ${maximumLength} characters.`);
  }
  return value;
}
