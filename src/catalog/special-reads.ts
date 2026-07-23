import type { Toolset } from '../config/schema.js';
import type {
  JsonSchema,
  JoomlaAclMetadata,
  JoomlaApiDriverMetadata,
  ReadActionDescriptor,
  RouteParameterDescriptor,
} from '../contracts/action-catalog.js';
import { boundedListQueryProperties } from '../contracts/bounded-query.js';
import { acl, apiDriver, joomla6xVersions, source } from './source-metadata.js';

interface SpecialReadSeed {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly operation: ReadActionDescriptor['operation'];
  readonly routeTemplate: `v1/${string}`;
  readonly routeParameters?: readonly RouteParameterDescriptor[];
  readonly paginated?: boolean;
  readonly toolset: Toolset;
  readonly risk?: ReadActionDescriptor['risk'];
  readonly component: `com_${string}`;
  readonly plugin: string;
  readonly className: string;
  readonly authentication?: JoomlaApiDriverMetadata['authentication'];
  readonly responseShape?: JoomlaApiDriverMetadata['responseShape'];
  readonly aclOverride?: JoomlaAclMetadata;
  readonly sideEffect?: boolean;
}

const numericId = (name = 'id'): RouteParameterDescriptor => Object.freeze({
  name,
  kind: 'positive-integer',
  required: true,
  maximumLength: 16,
});

const languageCode: RouteParameterDescriptor = Object.freeze({
  name: 'language',
  kind: 'language-code',
  required: true,
  maximumLength: 6,
});

const overrideConstant: RouteParameterDescriptor = Object.freeze({
  name: 'constant',
  kind: 'override-constant',
  required: true,
  maximumLength: 255,
});

function read(seed: SpecialReadSeed): ReadActionDescriptor {
  const parameters = Object.freeze([...(seed.routeParameters ?? [])]);
  const driver = apiDriver(
    `webservices/${seed.plugin}`,
    seed.authentication ?? 'joomla-api-token',
    seed.responseShape ?? 'json-api',
  );

  return Object.freeze({
    id: seed.id,
    title: seed.title,
    description: seed.description,
    domain: seed.domain,
    operation: seed.operation,
    method: 'GET',
    routeTemplate: seed.routeTemplate,
    routeParameters: parameters,
    paginated: seed.paginated ?? false,
    inputSchema: inputSchema(parameters, seed.paginated ?? false),
    toolset: seed.toolset,
    risk: seed.risk ?? 'read',
    sideEffect: seed.sideEffect ?? false,
    acl: seed.aclOverride ?? acl(seed.component),
    driver: Object.freeze({ ...driver, mutationBody: 'not-applicable' }),
    versions: joomla6xVersions,
    source: source(seed.plugin, seed.className, 'Route'),
  });
}

function inputSchema(parameters: readonly RouteParameterDescriptor[], paginated: boolean): JsonSchema {
  const properties: Record<string, Readonly<Record<string, unknown>>> = paginated
    ? { ...boundedListQueryProperties }
    : {};

  for (const parameter of parameters) {
    properties[parameter.name] = routeParameterSchema(parameter);
  }

  const required = parameters.map((parameter) => parameter.name);

  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    ...(required.length === 0 ? {} : { required: Object.freeze(required) }),
    additionalProperties: false,
  });
}

function routeParameterSchema(parameter: RouteParameterDescriptor): Readonly<Record<string, unknown>> {
  switch (parameter.kind) {
    case 'positive-integer':
      return Object.freeze({ type: 'integer', minimum: 1 });
    case 'component-name':
      return Object.freeze({ type: 'string', pattern: '^com_[A-Za-z0-9_]+$', maxLength: parameter.maximumLength ?? 64 });
    case 'language-code':
      return Object.freeze({ type: 'string', pattern: '^[a-z]{2,3}-[A-Z]{2}$', maxLength: parameter.maximumLength ?? 6 });
    case 'override-constant':
      return Object.freeze({ type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', maxLength: parameter.maximumLength ?? 255 });
    case 'adapter-id':
      return Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', maxLength: parameter.maximumLength ?? 128 });
    case 'media-path':
      return Object.freeze({ type: 'string', minLength: 1, maxLength: parameter.maximumLength ?? 1_024 });
  }
}

export const joomlaUpdateAcl: JoomlaAclMetadata = Object.freeze({
  apiLogin: 'not-used',
  component: 'com_joomlaupdate',
  actionHints: Object.freeze({
    read: Object.freeze(['separate X-JUpdate-Token validation']),
    list: Object.freeze(['not-applicable']),
    get: Object.freeze(['separate X-JUpdate-Token validation']),
    create: Object.freeze(['not-catalogued']),
    update: Object.freeze(['not-catalogued']),
    delete: Object.freeze(['not-catalogued']),
  }),
  enforcement: 'joomla-controller',
  resourceScoped: false,
});

export const joomlaSpecialReadActions: readonly ReadActionDescriptor[] = Object.freeze([
  read({
    id: 'menus.site-item-types.list', title: 'List site menu item types', description: 'Lists available menu item types for the site client.',
    domain: 'menus', operation: 'list', routeTemplate: 'v1/menus/site/items/types', toolset: 'structure.read',
    component: 'com_menus', plugin: 'menus', className: 'Menus',
  }),
  read({
    id: 'menus.administrator-item-types.list', title: 'List administrator menu item types', description: 'Lists available menu item types for the administrator client.',
    domain: 'menus', operation: 'list', routeTemplate: 'v1/menus/administrator/items/types', toolset: 'structure.read',
    component: 'com_menus', plugin: 'menus', className: 'Menus',
  }),
  read({
    id: 'modules.site-types.list', title: 'List site module types', description: 'Lists available module types for the site client.',
    domain: 'modules', operation: 'list', routeTemplate: 'v1/modules/types/site', toolset: 'structure.read',
    component: 'com_modules', plugin: 'modules', className: 'Modules',
  }),
  read({
    id: 'modules.administrator-types.list', title: 'List administrator module types', description: 'Lists available module types for the administrator client.',
    domain: 'modules', operation: 'list', routeTemplate: 'v1/modules/types/administrator', toolset: 'structure.read',
    component: 'com_modules', plugin: 'modules', className: 'Modules',
  }),
  read({
    id: 'content.article-history.list', title: 'List article history', description: 'Lists saved content-history versions for an article.',
    domain: 'content-history', operation: 'list', routeTemplate: 'v1/content/articles/:id/contenthistory', routeParameters: [numericId()],
    paginated: true, toolset: 'content.read', component: 'com_contenthistory', plugin: 'content', className: 'Content',
  }),
  read({
    id: 'contacts.contact-history.list', title: 'List contact history', description: 'Lists saved content-history versions for a contact.',
    domain: 'content-history', operation: 'list', routeTemplate: 'v1/contacts/:id/contenthistory', routeParameters: [numericId()],
    paginated: true, toolset: 'content.read', component: 'com_contenthistory', plugin: 'contact', className: 'Contact',
  }),
  read({
    id: 'banners.banner-history.list', title: 'List banner history', description: 'Lists saved content-history versions for a banner.',
    domain: 'content-history', operation: 'list', routeTemplate: 'v1/banners/:id/contenthistory', routeParameters: [numericId()],
    paginated: true, toolset: 'content.read', component: 'com_contenthistory', plugin: 'banners', className: 'Banners',
  }),
  read({
    id: 'media.adapters.list', title: 'List media adapters', description: 'Lists configured Joomla media adapters.',
    domain: 'media', operation: 'list', routeTemplate: 'v1/media/adapters', paginated: true, toolset: 'media.read',
    component: 'com_media', plugin: 'media', className: 'Media',
  }),
  read({
    id: 'media.adapters.get', title: 'Get media adapter', description: 'Gets one configured media adapter by identifier.',
    domain: 'media', operation: 'get', routeTemplate: 'v1/media/adapters/:adapter',
    routeParameters: [{ name: 'adapter', kind: 'adapter-id', required: true, maximumLength: 128 }], toolset: 'media.read',
    component: 'com_media', plugin: 'media', className: 'Media',
  }),
  read({
    id: 'media.files.list', title: 'List root media files', description: 'Lists files and directories at the media root.',
    domain: 'media', operation: 'list', routeTemplate: 'v1/media/files', paginated: true, toolset: 'media.read',
    component: 'com_media', plugin: 'media', className: 'Media',
  }),
  read({
    id: 'media.directory.list', title: 'List media directory', description: 'Lists files in a bounded relative media directory path.',
    domain: 'media', operation: 'list', routeTemplate: 'v1/media/files/:path/',
    routeParameters: [{ name: 'path', kind: 'media-path', required: true, maximumLength: 1_024 }], paginated: true, toolset: 'media.read',
    component: 'com_media', plugin: 'media', className: 'Media',
  }),
  read({
    id: 'media.files.get', title: 'Get media file', description: 'Gets metadata or content for a bounded relative media path.',
    domain: 'media', operation: 'get', routeTemplate: 'v1/media/files/:path',
    routeParameters: [{ name: 'path', kind: 'media-path', required: true, maximumLength: 1_024 }], toolset: 'media.read',
    component: 'com_media', plugin: 'media', className: 'Media',
  }),
  read({
    id: 'configuration.application.get', title: 'Read application configuration', description: 'Reads Joomla global configuration; callers must apply a strict output allowlist.',
    domain: 'configuration', operation: 'get', routeTemplate: 'v1/config/application', toolset: 'configuration.read', risk: 'sensitive-read',
    component: 'com_config', plugin: 'config', className: 'Config',
  }),
  read({
    id: 'configuration.component.get', title: 'Read component configuration', description: 'Reads configuration for a named Joomla component.',
    domain: 'configuration', operation: 'get', routeTemplate: 'v1/config/:component',
    routeParameters: [{ name: 'component', kind: 'component-name', required: true, maximumLength: 64 }],
    toolset: 'configuration.read', risk: 'sensitive-read', component: 'com_config', plugin: 'config', className: 'Config',
  }),
  read({
    id: 'extensions.installed.list', title: 'List installed extensions', description: 'Lists installed extensions; this route does not perform extension lifecycle operations.',
    domain: 'extensions', operation: 'list', routeTemplate: 'v1/extensions', paginated: true, toolset: 'extensions.read',
    component: 'com_installer', plugin: 'installer', className: 'Installer',
  }),
  read({
    id: 'plugins.plugins.list', title: 'List plugins', description: 'Lists installed Joomla plugins.',
    domain: 'plugins', operation: 'list', routeTemplate: 'v1/plugins', paginated: true, toolset: 'extensions.read',
    component: 'com_plugins', plugin: 'plugins', className: 'Plugins',
  }),
  read({
    id: 'plugins.plugins.get', title: 'Get plugin', description: 'Gets one Joomla plugin by numeric identifier.',
    domain: 'plugins', operation: 'get', routeTemplate: 'v1/plugins/:id', routeParameters: [numericId()], toolset: 'extensions.read',
    component: 'com_plugins', plugin: 'plugins', className: 'Plugins',
  }),
  read({
    id: 'privacy.requests.list', title: 'List privacy requests', description: 'Lists privacy information requests.',
    domain: 'privacy', operation: 'list', routeTemplate: 'v1/privacy/requests', paginated: true, toolset: 'users.read', risk: 'sensitive-read',
    component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  read({
    id: 'privacy.requests.get', title: 'Get privacy request', description: 'Gets one privacy information request.',
    domain: 'privacy', operation: 'get', routeTemplate: 'v1/privacy/requests/:id', routeParameters: [numericId()], toolset: 'users.read', risk: 'sensitive-read',
    component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  read({
    id: 'privacy.requests.export', title: 'Export privacy request', description: 'Exports the personal data associated with one privacy request.',
    domain: 'privacy', operation: 'export', routeTemplate: 'v1/privacy/requests/export/:id', routeParameters: [numericId()],
    toolset: 'users.read', risk: 'sensitive-read', component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  read({
    id: 'privacy.consents.list', title: 'List privacy consents', description: 'Lists recorded privacy consents.',
    domain: 'privacy', operation: 'list', routeTemplate: 'v1/privacy/consents', paginated: true, toolset: 'users.read', risk: 'sensitive-read',
    component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  read({
    id: 'privacy.consents.get', title: 'Get privacy consent', description: 'Gets one recorded privacy consent.',
    domain: 'privacy', operation: 'get', routeTemplate: 'v1/privacy/consents/:id', routeParameters: [numericId()],
    toolset: 'users.read', risk: 'sensitive-read', component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  read({
    id: 'languages.packages.list', title: 'List language packages', description: 'Lists Joomla language packages available for installation.',
    domain: 'languages', operation: 'list', routeTemplate: 'v1/languages', paginated: true, toolset: 'extensions.read',
    component: 'com_installer', plugin: 'languages', className: 'Languages',
  }),
  read({
    id: 'languages.overrides.site.list', title: 'List site language overrides', description: 'Lists site overrides for one installed content language.',
    domain: 'languages', operation: 'list', routeTemplate: 'v1/languages/overrides/site/:language', routeParameters: [languageCode],
    paginated: true, toolset: 'structure.read', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  read({
    id: 'languages.overrides.site.get', title: 'Get site language override', description: 'Gets one site override by language constant.',
    domain: 'languages', operation: 'get', routeTemplate: 'v1/languages/overrides/site/:language/:constant',
    routeParameters: [languageCode, overrideConstant], toolset: 'structure.read', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  read({
    id: 'languages.overrides.administrator.list', title: 'List administrator language overrides', description: 'Lists administrator overrides for one installed content language.',
    domain: 'languages', operation: 'list', routeTemplate: 'v1/languages/overrides/administrator/:language', routeParameters: [languageCode],
    paginated: true, toolset: 'structure.read', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  read({
    id: 'languages.overrides.administrator.get', title: 'Get administrator language override', description: 'Gets one administrator override by language constant.',
    domain: 'languages', operation: 'get', routeTemplate: 'v1/languages/overrides/administrator/:language/:constant',
    routeParameters: [languageCode, overrideConstant], toolset: 'structure.read', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  read({
    id: 'joomla-update.healthcheck', title: 'Check Joomla Update health',
    description: 'Checks whether the separately authenticated Joomla Update API is ready and records Joomla’s last successful health-check time.',
    domain: 'joomla-update', operation: 'healthcheck', routeTemplate: 'v1/joomlaupdate/healthcheck', toolset: 'core-update', risk: 'sensitive-read',
    component: 'com_joomlaupdate', plugin: 'joomlaupdate', className: 'Joomlaupdate', authentication: 'joomla-update-token',
    responseShape: 'joomla-json', aclOverride: joomlaUpdateAcl, sideEffect: true,
  }),
  read({
    id: 'joomla-update.status', title: 'Get Joomla update status', description: 'Gets available core update information using the separate Joomla Update token.',
    domain: 'joomla-update', operation: 'status', routeTemplate: 'v1/joomlaupdate/getUpdate', toolset: 'core-update', risk: 'sensitive-read',
    component: 'com_joomlaupdate', plugin: 'joomlaupdate', className: 'Joomlaupdate', authentication: 'joomla-update-token',
    responseShape: 'joomla-json', aclOverride: joomlaUpdateAcl,
  }),
]);
