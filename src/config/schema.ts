import { z } from 'zod/v4';

export const ToolsetSchema = z.enum([
  'discovery',
  'content.read',
  'content.write',
  'structure.read',
  'structure.write',
  'media.read',
  'media.write',
  'users.read',
  'users.admin',
  'extensions.read',
  'extensions.admin',
  'configuration.read',
  'configuration.write',
  'maintenance.read',
  'maintenance.admin',
  'core-update',
  'cli.discovery',
]);

export type Toolset = z.infer<typeof ToolsetSchema>;

const ApiConfigSchema = z
  .object({
    baseUrl: z.url(),
    tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    updateTokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    timeoutMs: z.int().min(1_000).max(300_000).default(30_000),
    maxResponseBytes: z.int().min(1_024).max(52_428_800).default(5_242_880),
    maxPageSize: z.int().min(1).max(500).default(100),
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.baseUrl);

    if (url.protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Joomla API origins must use HTTPS.',
      });
    }

    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'baseUrl may not contain credentials, a query, or a fragment.',
      });
    }
  });

const CliConfigSchema = z
  .object({
    root: z.string().min(1),
    phpBinary: z.string().min(1),
    timeoutMs: z.int().min(1_000).max(3_600_000).default(120_000),
    maxOutputBytes: z.int().min(1_024).max(52_428_800).default(2_097_152),
  })
  .strict();

const SiteSchema = z
  .object({
    toolsets: z.array(ToolsetSchema).min(1),
    api: ApiConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
  })
  .strict()
  .refine((site) => site.api !== undefined || site.cli !== undefined, {
    message: 'Each site must configure the API, CLI, or both.',
  });

const ApprovalConfigSchema = z
  .object({
    secretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    ttlMs: z.int().min(30_000).max(900_000).default(300_000),
    requestTtlMs: z.int().min(60_000).max(900_000).default(300_000),
    grantStorePath: z.string().min(1).optional(),
    allowIndefinite: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !value.allowIndefinite || value.grantStorePath !== undefined, {
    path: ['grantStorePath'],
    message: 'grantStorePath is required when indefinite permission grants are enabled.',
  });

const HttpLimitsSchema = z
  .object({
    maxBodyBytes: z.int().min(1_024).max(10_485_760).default(1_048_576),
    maxSessions: z.int().min(1).max(100_000).default(1_000),
    sessionIdleTtlMs: z.int().min(10_000).max(86_400_000).default(900_000),
    sessionMaxLifetimeMs: z.int().min(10_000).max(604_800_000).default(28_800_000),
    bodyTimeoutMs: z.int().min(1_000).max(120_000).default(15_000),
    maxConcurrentRequests: z.int().min(1).max(100_000).default(100),
    maxConcurrentRequestsPerPrincipal: z.int().min(1).max(10_000).default(8),
    requestsPerMinutePerPrincipal: z.int().min(1).max(1_000_000).default(120),
    burstPerPrincipal: z.int().min(1).max(100_000).default(20),
    maxTrackedPrincipals: z.int().min(1).max(1_000_000).default(10_000),
  })
  .strict()
  .refine((value) => value.sessionMaxLifetimeMs >= value.sessionIdleTtlMs, {
    message: 'sessionMaxLifetimeMs may not be shorter than sessionIdleTtlMs.',
  });

const HttpConfigSchema = z
  .object({
    listenHost: z.string().regex(/^[A-Za-z0-9:._-]+$/).default('127.0.0.1'),
    port: z.int().min(1).max(65_535).default(3_000),
    mcpPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/mcp'),
    healthPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/healthz'),
    readinessPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/readyz'),
    shutdownGraceMs: z.int().min(1_000).max(120_000).default(30_000),
    allowedHosts: z.array(z.string().min(1).max(255)).min(1),
    allowedOrigins: z.array(z.url()).default([]),
    requireOrigin: z.boolean().default(false),
    issuer: z.url(),
    audience: z.url(),
    requiredScopes: z.array(z.string().regex(/^[^\s]{1,128}$/)).min(1).default(['joomla:mcp']),
    jwksUrl: z.url(),
    resourceMetadataUrl: z.url().optional(),
    enableJsonResponse: z.boolean().default(false),
    limits: HttpLimitsSchema.default({
      maxBodyBytes: 1_048_576,
      maxSessions: 1_000,
      sessionIdleTtlMs: 900_000,
      sessionMaxLifetimeMs: 28_800_000,
      bodyTimeoutMs: 15_000,
      maxConcurrentRequests: 100,
      maxConcurrentRequestsPerPrincipal: 8,
      requestsPerMinutePerPrincipal: 120,
      burstPerPrincipal: 20,
      maxTrackedPrincipals: 10_000,
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set([value.mcpPath, value.healthPath, value.readinessPath]).size !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['readinessPath'],
        message: 'mcpPath, healthPath, and readinessPath must differ.',
      });
    }
    for (const [name, candidate] of [
      ['issuer', value.issuer],
      ['audience', value.audience],
      ['jwksUrl', value.jwksUrl],
      ...(value.resourceMetadataUrl === undefined
        ? []
        : ([['resourceMetadataUrl', value.resourceMetadataUrl]] as const)),
    ] as const) {
      if (new URL(candidate).protocol !== 'https:') {
        context.addIssue({ code: 'custom', path: [name], message: `${name} must use HTTPS.` });
      }
    }
  });

export const RawConfigurationSchema = z
  .object({
    defaultSite: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    approval: ApprovalConfigSchema.optional(),
    http: HttpConfigSchema.optional(),
    sites: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), SiteSchema),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.sites[configuration.defaultSite] === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['defaultSite'],
        message: 'defaultSite must name a configured site.',
      });
    }
  });

export type RawConfiguration = z.infer<typeof RawConfigurationSchema>;

export type ApiConfig = z.infer<typeof ApiConfigSchema> & {
  readonly token: string;
  readonly updateToken?: string;
};

export type CliConfig = z.infer<typeof CliConfigSchema>;

export interface SiteConfig {
  readonly id: string;
  readonly toolsets: ReadonlySet<Toolset>;
  readonly api?: ApiConfig;
  readonly cli?: CliConfig;
}

export interface Configuration {
  readonly defaultSite: string;
  readonly sites: ReadonlyMap<string, SiteConfig>;
  readonly approval?: {
    readonly secret: string;
    readonly ttlMs: number;
    readonly requestTtlMs?: number;
    readonly grantStorePath?: string;
    readonly allowIndefinite?: boolean;
  };
  readonly http?: z.infer<typeof HttpConfigSchema>;
}
