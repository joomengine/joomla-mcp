import { realpath, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { RawConfigurationSchema, type Configuration, type SiteConfig } from './schema.js';

export type ConfigurationSecretPurpose = 'approval-secret' | 'api-token' | 'api-update-token';

export interface ConfigurationSecretRequest {
  readonly name: string;
  readonly purpose: ConfigurationSecretPurpose;
  readonly site?: string;
}

export type ConfigurationSecretResolver = (
  request: ConfigurationSecretRequest,
) => string | undefined | Promise<string | undefined>;

export interface ResolveConfigurationOptions {
  /**
   * Resolve secret references without placing secret values in configuration
   * documents. Defaults to the current process environment.
   */
  readonly resolveSecret?: ConfigurationSecretResolver;
  /** Human-readable source used in validation errors. */
  readonly source?: string;
}

export async function loadConfiguration(
  file: string,
  options: Omit<ResolveConfigurationOptions, 'source'> = {},
): Promise<Configuration> {
  const absoluteFile = resolve(file);
  let raw: unknown;

  try {
    raw = JSON.parse(await readFile(absoluteFile, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read configuration ${absoluteFile}: ${errorMessage(error)}`);
  }

  return resolveConfiguration(raw, { ...options, source: absoluteFile });
}

export async function resolveConfiguration(
  raw: unknown,
  options: ResolveConfigurationOptions = {},
): Promise<Configuration> {
  const source = options.source ?? 'programmatic configuration';
  const parsed = RawConfigurationSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`Invalid configuration ${source}: ${parsed.error.message}`);
  }

  const sites = new Map<string, SiteConfig>();
  const resolveSecret = options.resolveSecret ?? environmentSecretResolver;

  const approvalSecret =
    parsed.data.approval === undefined
      ? undefined
      : await resolveSecret({
          name: parsed.data.approval.secretEnv,
          purpose: 'approval-secret',
        });

  if (parsed.data.approval !== undefined && (approvalSecret === undefined || approvalSecret.length < 32)) {
    throw new Error(
      `Secret ${parsed.data.approval.secretEnv} must contain at least 32 characters for write approvals.`,
    );
  }

  const grantStorePath = parsed.data.approval?.grantStorePath === undefined
    ? undefined
    : await validateGrantStorePath(parsed.data.approval.grantStorePath);

  for (const [id, source] of Object.entries(parsed.data.sites)) {
    const token = source.api === undefined
      ? undefined
      : await resolveSecret({
          name: source.api.tokenEnv,
          purpose: 'api-token',
          site: id,
        });
    const updateToken =
      source.api?.updateTokenEnv === undefined
        ? undefined
        : await resolveSecret({
            name: source.api.updateTokenEnv,
            purpose: 'api-update-token',
            site: id,
          });

    if (source.api !== undefined && (token === undefined || token === '')) {
      throw new Error(`Secret ${source.api.tokenEnv} for site ${id} is not set.`);
    }

    if (source.api?.updateTokenEnv !== undefined && (updateToken === undefined || updateToken === '')) {
      throw new Error(`Secret ${source.api.updateTokenEnv} for site ${id} is not set.`);
    }

    const cli =
      source.cli === undefined
        ? undefined
        : {
            ...source.cli,
            root: await validateDirectory(source.cli.root, `Joomla root for site ${id}`),
            phpBinary: await validateExecutable(source.cli.phpBinary, `PHP binary for site ${id}`),
          };

    if (cli !== undefined) {
      await validateReadableFile(resolve(cli.root, 'cli/joomla.php'), `Joomla CLI launcher for site ${id}`);
    }

    const site: SiteConfig = {
      id,
      toolsets: new Set(source.toolsets),
      ...(source.api === undefined
        ? {}
        : { api: { ...source.api, token: token as string, ...(updateToken === undefined ? {} : { updateToken }) } }),
      ...(cli === undefined ? {} : { cli }),
    };
    sites.set(id, site);
  }

  return {
    defaultSite: parsed.data.defaultSite,
    sites,
    ...(parsed.data.approval === undefined
      ? {}
      : {
          approval: {
            secret: approvalSecret as string,
            ttlMs: parsed.data.approval.ttlMs,
            requestTtlMs: parsed.data.approval.requestTtlMs,
            allowIndefinite: parsed.data.approval.allowIndefinite,
            ...(grantStorePath === undefined ? {} : { grantStorePath }),
          },
        }),
    ...(parsed.data.http === undefined ? {} : { http: parsed.data.http }),
  };
}

function environmentSecretResolver(request: ConfigurationSecretRequest): string | undefined {
  return process.env[request.name];
}

async function validateGrantStorePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const parent = await canonical(dirname(absolutePath), 'Permission grant store directory');
  await access(parent, constants.W_OK | constants.X_OK);

  try {
    const metadata = await stat(absolutePath);

    if (!metadata.isFile()) {
      throw new Error(`Permission grant store is not a file: ${absolutePath}`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`Permission grant store must not be accessible by group or other users: ${absolutePath}`);
    }
    await access(absolutePath, constants.R_OK | constants.W_OK);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  return resolve(parent, basename(absolutePath));
}

async function validateDirectory(path: string, label: string): Promise<string> {
  const canonicalPath = await canonical(path, label);

  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new Error(`${label} is not a directory: ${canonicalPath}`);
  }

  return canonicalPath;
}

async function validateExecutable(path: string, label: string): Promise<string> {
  const canonicalPath = await canonical(path, label);
  await access(canonicalPath, constants.X_OK);

  if (!(await stat(canonicalPath)).isFile()) {
    throw new Error(`${label} is not a file: ${canonicalPath}`);
  }

  return canonicalPath;
}

async function validateReadableFile(path: string, label: string): Promise<string> {
  const canonicalPath = await canonical(path, label);
  await access(canonicalPath, constants.R_OK);

  if (!(await stat(canonicalPath)).isFile()) {
    throw new Error(`${label} is not a file: ${canonicalPath}`);
  }

  return canonicalPath;
}

async function canonical(path: string, label: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    throw new Error(`${label} is invalid: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
