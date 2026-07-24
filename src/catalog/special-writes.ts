import type { Toolset } from '../config/schema.js';
import type {
  JoomlaAclMetadata,
  JoomlaApiDriverMetadata,
  JsonSchema,
  MutationBodyPolicy,
  RouteParameterDescriptor,
  WriteActionDescriptor,
} from '../contracts/action-catalog.js';
import { acl, apiDriver, joomla6xVersions, source } from './source-metadata.js';
import { joomlaUpdateAcl } from './special-reads.js';

interface SpecialWriteSeed {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly domain: string;
  readonly operation: WriteActionDescriptor['operation'];
  readonly method: WriteActionDescriptor['method'];
  readonly routeTemplate: `v1/${string}`;
  readonly routeParameters?: readonly RouteParameterDescriptor[];
  readonly toolset: Toolset;
  readonly component: `com_${string}`;
  readonly plugin: string;
  readonly className: string;
  readonly bodyPolicy?: MutationBodyPolicy;
  readonly dataSchema?: Readonly<Record<string, unknown>>;
  readonly authentication?: JoomlaApiDriverMetadata['authentication'];
  readonly responseShape?: JoomlaApiDriverMetadata['responseShape'];
  readonly aclOverride?: JoomlaAclMetadata;
}

const numericId = (): RouteParameterDescriptor => Object.freeze({
  name: 'id', kind: 'positive-integer', required: true, maximumLength: 16,
});
const languageCode: RouteParameterDescriptor = Object.freeze({
  name: 'language', kind: 'language-code', required: true, maximumLength: 6,
});
const overrideConstant: RouteParameterDescriptor = Object.freeze({
  name: 'constant', kind: 'override-constant', required: true, maximumLength: 255,
});
const mediaPath: RouteParameterDescriptor = Object.freeze({
  name: 'path', kind: 'media-path', required: true, maximumLength: 1_024,
});
const componentName: RouteParameterDescriptor = Object.freeze({
  name: 'component', kind: 'component-name', required: true, maximumLength: 64,
});

const booleanLike = Object.freeze({ enum: Object.freeze([false, true, 0, 1]) });
const boundedString = (maximum = 65_535): Readonly<Record<string, unknown>> =>
  Object.freeze({ type: 'string', maxLength: maximum });
const exactObject = (
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> => Object.freeze({
  type: 'object',
  properties: Object.freeze(properties),
  ...(required.length === 0 ? {} : { required: Object.freeze(required) }),
  additionalProperties: false,
});

const mediaCreateSchema = exactObject({
  path: { type: 'string', minLength: 1, maxLength: 1_024 },
  content: { type: 'string', minLength: 1, maxLength: 1_048_576, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
  override: booleanLike,
}, ['path']);

const mediaUpdateSchema = exactObject({
  path: { type: 'string', minLength: 1, maxLength: 1_024 },
  content: { type: 'string', minLength: 1, maxLength: 1_048_576, pattern: '^[A-Za-z0-9+/]+={0,2}$' },
  override: booleanLike,
});

const pluginUpdateSchema = exactObject({
  enabled: { type: 'integer', enum: Object.freeze([0, 1]) },
  access: { type: 'integer', minimum: 1 },
  ordering: { type: 'integer' },
});

const privacyRequestSchema = exactObject({
  email: {
    type: 'string',
    minLength: 3,
    maxLength: 320,
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
  },
  request_type: { type: 'string', enum: Object.freeze(['export', 'remove']), default: 'export' },
}, ['email']);

const languageOverrideSchema = exactObject({
  id: { type: 'string', maxLength: 255 },
  key: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z][A-Za-z0-9_.-]*$' },
  override: { type: 'string', maxLength: 65_535 },
  both: booleanLike,
}, ['key']);

const languageSearchSchema = exactObject({
  searchstring: { type: 'string', minLength: 1, maxLength: 1_024 },
  searchtype: { type: 'string', enum: Object.freeze(['constant', 'value']) },
}, ['searchstring', 'searchtype']);

const contactFormSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    contact_name: boundedString(255),
    contact_email: {
      type: 'string',
      minLength: 3,
      maxLength: 320,
      pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    },
    contact_subject: boundedString(998),
    contact_message: boundedString(1_000_000),
    contact_email_copy: booleanLike,
    captcha: {},
  }),
  required: Object.freeze(['contact_name', 'contact_email', 'contact_subject', 'contact_message']),
  additionalProperties: true,
  description: 'Core contact fields plus runtime captcha/custom fields validated by Joomla contact plugins.',
});

const configurationBooleanFields = [
  'cache_platformprefix', 'memcached_persist', 'memcached_compress', 'redis_persist',
  'dbsslverifyservercert', 'debug', 'debug_lang', 'debug_lang_const', 'cors',
  'behind_loadbalancer', 'proxy_enable', 'mailonline', 'massmailoff', 'smtpauth',
  'MetaAuthor', 'MetaVersion', 'sef', 'sef_rewrite', 'sef_suffix', 'unicodeslugs',
  'gzip', 'session_redis_persist', 'shared_session', 'session_metadata',
  'session_metadata_for_guest', 'offline', 'log_everything', 'log_deprecated',
  'log_category_mode',
] as const;
const configurationStringFields = [
  'cache_path', 'memcached_server_host', 'redis_server_host', 'redis_server_auth',
  'host', 'user', 'password', 'db', 'dbprefix', 'dbsslkey', 'dbsslcert', 'dbsslca',
  'dbsslcipher', 'cors_allow_origin', 'cors_allow_headers', 'cors_allow_methods',
  'proxy_host', 'proxy_user', 'proxy_pass', 'mailfrom', 'fromname', 'replyto',
  'replytoname', 'sendmail', 'smtphost', 'smtpuser', 'smtppass', 'MetaDesc',
  'MetaRights', 'tmp_path', 'session_filesystem_path', 'session_memcached_server_host',
  'session_redis_server_host', 'session_redis_server_auth', 'sitename', 'offline_message',
  'offline_image', 'log_path', 'log_categories', 'cookie_domain', 'cookie_path',
] as const;
const configurationSensitiveFields = new Set([
  'redis_server_auth', 'password', 'dbsslkey', 'proxy_pass', 'smtpuser', 'smtppass',
  'session_redis_server_auth',
]);
const applicationConfigurationProperties: Record<string, Readonly<Record<string, unknown>>> = {};
for (const field of configurationBooleanFields) applicationConfigurationProperties[field] = booleanLike;
for (const field of configurationStringFields) {
  applicationConfigurationProperties[field] = Object.freeze({
    type: 'string',
    maxLength: 65_535,
    ...(configurationSensitiveFields.has(field) ? { writeOnly: true } : {}),
  });
}
Object.assign(applicationConfigurationProperties, {
  cachetime: { type: 'integer', minimum: 1 },
  lifetime: { type: 'integer', minimum: 1, maximum: 16_383 },
  memcached_server_port: { type: 'integer', minimum: 1, maximum: 65_535 },
  redis_server_port: { type: 'integer', minimum: 1, maximum: 65_535 },
  proxy_port: { type: 'integer', minimum: 1, maximum: 65_535 },
  smtpport: { type: 'integer', minimum: 1, maximum: 65_535 },
  session_memcached_server_port: { type: 'integer', minimum: 1, maximum: 65_535 },
  session_redis_server_port: { type: 'integer', minimum: 1, maximum: 65_535 },
  redis_server_db: { type: 'integer' },
  session_redis_server_db: { type: 'integer' },
  caching: { type: 'integer', enum: [0, 1, 2] },
  dbencryption: { type: 'integer', enum: [0, 1, 2] },
  mailer: { type: 'string', enum: ['mail', 'sendmail', 'smtp'] },
  smtpsecure: { type: 'string', enum: ['none', 'ssl', 'tls'] },
  robots: { type: 'string', enum: ['', 'noindex, follow', 'index, nofollow', 'noindex, nofollow'] },
  sitename_pagetitles: { type: 'integer', enum: [0, 1, 2] },
  error_reporting: { type: 'string', enum: ['default', 'none', 'simple', 'maximum'] },
  force_ssl: { type: 'integer', enum: [0, 1, 2] },
  display_offline_message: { type: 'integer', enum: [0, 1, 2] },
  frontediting: { type: 'integer', enum: [0, 1, 2] },
  list_limit: { type: 'integer', enum: [5, 10, 15, 20, 25, 30, 50, 100, 200, 500] },
  feed_limit: { type: 'integer', enum: [5, 10, 15, 20, 25, 30, 50, 100] },
  feed_email: { type: 'string', enum: ['author', 'site', 'none'] },
  log_priorities: {
    type: 'array',
    items: {
      type: 'string',
      enum: ['all', 'emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'],
    },
  },
  cache_handler: boundedString(128),
  dbtype: boundedString(128),
  offset: boundedString(128),
  session_handler: boundedString(128),
  editor: boundedString(128),
  captcha: boundedString(128),
  access: { type: 'integer', minimum: 1 },
  rules: { type: 'object' },
  filters: { type: 'object' },
});
const applicationConfigurationSchema = exactObject(applicationConfigurationProperties);

function write(seed: SpecialWriteSeed): WriteActionDescriptor {
  const parameters = Object.freeze([...(seed.routeParameters ?? [])]);
  const bodyPolicy = seed.bodyPolicy ?? (seed.operation === 'delete' ? 'none' : 'required');
  const properties: Record<string, Readonly<Record<string, unknown>>> = {};

  for (const parameter of parameters) properties[parameter.name] = routeParameterSchema(parameter);
  if (bodyPolicy !== 'none') {
    properties['data'] = Object.freeze(seed.dataSchema ?? {
      type: 'object', minProperties: 1, maxProperties: 512,
      description: 'Bounded Joomla form JSON. The Joomla controller performs resource-specific validation.',
    });
  }
  if (seed.method === 'PATCH' || seed.method === 'DELETE') {
    properties['etag'] = Object.freeze({ type: 'string', maxLength: 512 });
  }

  const required = [
    ...parameters.map((parameter) => parameter.name),
    ...(bodyPolicy === 'required' ? ['data'] : []),
  ];
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
    method: seed.method,
    routeTemplate: seed.routeTemplate,
    routeParameters: parameters,
    bodyPolicy,
    inputSchema: Object.freeze({
      type: 'object', properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false,
    }) satisfies JsonSchema,
    toolset: seed.toolset,
    risk: seed.operation === 'delete' ? 'destructive' : 'write',
    acl: seed.aclOverride ?? acl(seed.component),
    driver,
    versions: joomla6xVersions,
    source: source(seed.plugin, seed.className, 'Route'),
  });
}

function routeParameterSchema(parameter: RouteParameterDescriptor): Readonly<Record<string, unknown>> {
  switch (parameter.kind) {
    case 'positive-integer': return Object.freeze({ type: 'integer', minimum: 1 });
    case 'component-name': return Object.freeze({ type: 'string', pattern: '^com_[A-Za-z0-9_]+$', maxLength: 64 });
    case 'language-code': return Object.freeze({ type: 'string', pattern: '^[a-z]{2,3}-[A-Z]{2}$', maxLength: 6 });
    case 'override-constant': return Object.freeze({ type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', maxLength: 255 });
    case 'adapter-id': return Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', maxLength: 128 });
    case 'media-path': return Object.freeze({ type: 'string', minLength: 1, maxLength: 1_024 });
  }
}

const historyWrites = (
  prefix: 'content/articles' | 'contacts' | 'banners',
  idPrefix: 'content.article-history' | 'contacts.contact-history' | 'banners.banner-history',
  label: string,
  plugin: 'content' | 'contact' | 'banners',
  className: 'Content' | 'Contact' | 'Banners',
): readonly WriteActionDescriptor[] => Object.freeze([
  write({
    id: `${idPrefix}.keep`, title: `Keep ${label} history version`,
    description: `Changes the keep state of one saved ${label} content-history version.`, domain: 'content-history',
    operation: 'update', method: 'PATCH', routeTemplate: `v1/${prefix}/:id/contenthistory/keep`,
    routeParameters: [numericId()], bodyPolicy: 'none',
    toolset: 'content.write', component: 'com_contenthistory', plugin, className,
  }),
  write({
    id: `${idPrefix}.delete`, title: `Delete ${label} history version`,
    description: `Permanently deletes one saved ${label} content-history version.`, domain: 'content-history',
    operation: 'delete', method: 'DELETE', routeTemplate: `v1/${prefix}/:id/contenthistory`,
    routeParameters: [numericId()], toolset: 'content.write', component: 'com_contenthistory', plugin, className,
  }),
]);

/**
 * Explicit non-CRUD writes registered by Joomla 6.1 webservices plugins.
 * Joomla Update mutations retain their separate X-JUpdate-Token contract and
 * exact multi-step request schemas.
 */
export const joomlaSpecialWriteActions: readonly WriteActionDescriptor[] = Object.freeze([
  ...historyWrites('content/articles', 'content.article-history', 'article', 'content', 'Content'),
  ...historyWrites('contacts', 'contacts.contact-history', 'contact', 'contact', 'Contact'),
  ...historyWrites('banners', 'banners.banner-history', 'banner', 'banners', 'Banners'),
  write({
    id: 'contacts.form.submit', title: 'Submit contact form', description: 'Submits a form to one published Joomla contact.',
    domain: 'contacts', operation: 'create', method: 'POST', routeTemplate: 'v1/contacts/form/:id',
    routeParameters: [numericId()], dataSchema: contactFormSchema,
    toolset: 'content.write', component: 'com_contact', plugin: 'contact', className: 'Contact',
  }),
  write({
    id: 'media.files.create', title: 'Create media file', description: 'Creates a file or directory through Joomla Media.',
    domain: 'media', operation: 'create', method: 'POST', routeTemplate: 'v1/media/files',
    dataSchema: mediaCreateSchema,
    toolset: 'media.write', component: 'com_media', plugin: 'media', className: 'Media',
  }),
  write({
    id: 'media.files.update', title: 'Update media file', description: 'Updates or moves one bounded relative media path.',
    domain: 'media', operation: 'update', method: 'PATCH', routeTemplate: 'v1/media/files/:path', routeParameters: [mediaPath],
    dataSchema: mediaUpdateSchema,
    toolset: 'media.write', component: 'com_media', plugin: 'media', className: 'Media',
  }),
  write({
    id: 'media.files.delete', title: 'Delete media file', description: 'Deletes one bounded relative media path.',
    domain: 'media', operation: 'delete', method: 'DELETE', routeTemplate: 'v1/media/files/:path', routeParameters: [mediaPath],
    toolset: 'media.write', component: 'com_media', plugin: 'media', className: 'Media',
  }),
  write({
    id: 'configuration.application.update', title: 'Update application configuration', description: 'Updates Joomla global configuration.',
    domain: 'configuration', operation: 'update', method: 'PATCH', routeTemplate: 'v1/config/application',
    dataSchema: applicationConfigurationSchema,
    toolset: 'configuration.write', component: 'com_config', plugin: 'config', className: 'Config',
  }),
  write({
    id: 'configuration.component.update', title: 'Update component configuration', description: 'Updates one named Joomla component configuration.',
    domain: 'configuration', operation: 'update', method: 'PATCH', routeTemplate: 'v1/config/:component', routeParameters: [componentName],
    toolset: 'configuration.write', component: 'com_config', plugin: 'config', className: 'Config',
  }),
  write({
    id: 'plugins.plugins.update', title: 'Update plugin state', description: 'Updates only enabled, access, or ordering state for one installed Joomla plugin.',
    domain: 'plugins', operation: 'update', method: 'PATCH', routeTemplate: 'v1/plugins/:id', routeParameters: [numericId()],
    dataSchema: pluginUpdateSchema,
    toolset: 'extensions.admin', component: 'com_plugins', plugin: 'plugins', className: 'Plugins',
  }),
  write({
    id: 'privacy.requests.create', title: 'Create privacy request', description: 'Creates one Joomla privacy information request.',
    domain: 'privacy', operation: 'create', method: 'POST', routeTemplate: 'v1/privacy/requests',
    dataSchema: privacyRequestSchema,
    toolset: 'users.admin', component: 'com_privacy', plugin: 'privacy', className: 'Privacy',
  }),
  write({
    id: 'languages.packages.install', title: 'Install language package', description: 'Installs one Joomla language package.',
    domain: 'languages', operation: 'create', method: 'POST', routeTemplate: 'v1/languages',
    toolset: 'extensions.admin', component: 'com_installer', plugin: 'languages', className: 'Languages',
  }),
  ...(['site', 'administrator'] as const).flatMap((client) => [
    write({
      id: `languages.overrides.${client}.create`, title: `Create ${client} language override`,
      description: `Creates one ${client} language override.`, domain: 'languages', operation: 'create', method: 'POST',
      routeTemplate: `v1/languages/overrides/${client}/:language`, routeParameters: [languageCode],
      dataSchema: languageOverrideSchema,
      toolset: 'structure.write', component: 'com_languages', plugin: 'languages', className: 'Languages',
    }),
    write({
      id: `languages.overrides.${client}.update`, title: `Update ${client} language override`,
      description: `Updates one ${client} language override.`, domain: 'languages', operation: 'update', method: 'PATCH',
      routeTemplate: `v1/languages/overrides/${client}/:language/:constant`, routeParameters: [languageCode, overrideConstant],
      toolset: 'structure.write', component: 'com_languages', plugin: 'languages', className: 'Languages',
    }),
    write({
      id: `languages.overrides.${client}.delete`, title: `Delete ${client} language override`,
      description: `Deletes one ${client} language override.`, domain: 'languages', operation: 'delete', method: 'DELETE',
      routeTemplate: `v1/languages/overrides/${client}/:language/:constant`, routeParameters: [languageCode, overrideConstant],
      toolset: 'structure.write', component: 'com_languages', plugin: 'languages', className: 'Languages',
    }),
  ]),
  write({
    id: 'languages.overrides.search', title: 'Search language strings', description: 'Searches installed Joomla language strings.',
    domain: 'languages', operation: 'create', method: 'POST', routeTemplate: 'v1/languages/overrides/search',
    dataSchema: languageSearchSchema,
    toolset: 'structure.write', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  write({
    id: 'languages.overrides.refresh', title: 'Refresh language string cache', description: 'Refreshes Joomla language override search caches.',
    domain: 'languages', operation: 'create', method: 'POST', routeTemplate: 'v1/languages/overrides/search/cache/refresh',
    bodyPolicy: 'none', toolset: 'structure.write', component: 'com_languages', plugin: 'languages', className: 'Languages',
  }),
  write({
    id: 'joomla-update.prepare', title: 'Prepare Joomla core update',
    description: 'Downloads and prepares the exact core update version currently advertised by Joomla Update.',
    domain: 'joomla-update', operation: 'create', method: 'POST', routeTemplate: 'v1/joomlaupdate/prepareUpdate',
    toolset: 'core-update', component: 'com_joomlaupdate', plugin: 'joomlaupdate', className: 'Joomlaupdate',
    authentication: 'joomla-update-token', responseShape: 'joomla-json', aclOverride: joomlaUpdateAcl,
    dataSchema: {
      type: 'object',
      properties: {
        targetVersion: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' },
      },
      required: ['targetVersion'],
      additionalProperties: false,
    },
  }),
  write({
    id: 'joomla-update.finalize', title: 'Finalize Joomla core update',
    description: 'Finalizes a prepared Joomla core update using the previous version and a basename-only update package name.',
    domain: 'joomla-update', operation: 'create', method: 'POST', routeTemplate: 'v1/joomlaupdate/finalizeUpdate',
    toolset: 'core-update', component: 'com_joomlaupdate', plugin: 'joomlaupdate', className: 'Joomlaupdate',
    authentication: 'joomla-update-token', responseShape: 'joomla-json', aclOverride: joomlaUpdateAcl,
    dataSchema: {
      type: 'object',
      properties: {
        fromVersion: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' },
        updateFileName: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
          description: 'Package basename only; directory separators are prohibited.',
        },
      },
      required: ['fromVersion', 'updateFileName'],
      additionalProperties: false,
    },
  }),
  ...(['success', 'failed'] as const).map((outcome) => write({
    id: `joomla-update.notification.${outcome}`,
    title: `Send Joomla update ${outcome} notification`,
    description: `Asks Joomla to send its configured ${outcome} core-update notification.`,
    domain: 'joomla-update', operation: 'create', method: 'POST',
    routeTemplate: outcome === 'success'
      ? 'v1/joomlaupdate/notificationSuccess'
      : 'v1/joomlaupdate/notificationFailed',
    toolset: 'core-update', component: 'com_joomlaupdate', plugin: 'joomlaupdate', className: 'Joomlaupdate',
    authentication: 'joomla-update-token', responseShape: 'joomla-json', aclOverride: joomlaUpdateAcl,
    dataSchema: {
      type: 'object',
      properties: {
        fromVersion: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' },
        toVersion: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' },
      },
      required: ['fromVersion', 'toVersion'],
      additionalProperties: false,
    },
  })),
]);
