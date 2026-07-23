import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { Toolset } from '../config/schema.js';

export const writePermissionToolsets = [
  'content.write',
  'structure.write',
  'media.write',
  'users.admin',
  'extensions.admin',
  'configuration.write',
  'maintenance.admin',
  'core-update',
] as const satisfies readonly Toolset[];

export type WritePermissionToolset = (typeof writePermissionToolsets)[number];
export type PermissionGrantDuration = 'once' | '30-minutes' | 'indefinite';

export interface PermissionRequestInput {
  readonly site: string;
  readonly toolsets: readonly WritePermissionToolset[];
  readonly duration: PermissionGrantDuration;
  readonly reason: string;
}

export interface PermissionRequest {
  readonly requestId: string;
  readonly acknowledgement: string;
  readonly expiresAt: string;
  readonly requested: {
    readonly site: string;
    readonly toolsets: readonly WritePermissionToolset[];
    readonly duration: PermissionGrantDuration;
    readonly reason: string;
  };
  readonly instructions: string;
}

export interface PermissionGrant {
  readonly id: string;
  readonly site: string;
  readonly toolsets: readonly WritePermissionToolset[];
  readonly duration: PermissionGrantDuration;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly remainingUses: number | null;
}

interface PendingRequest {
  readonly id: string;
  readonly principalFingerprint: string;
  readonly site: string;
  readonly toolsets: readonly WritePermissionToolset[];
  readonly duration: PermissionGrantDuration;
  readonly reason: string;
  readonly acknowledgement: string;
  readonly expiresAt: number;
}

interface StoredGrant {
  readonly id: string;
  readonly principalFingerprint: string;
  readonly site: string;
  readonly toolsets: readonly WritePermissionToolset[];
  readonly duration: PermissionGrantDuration;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  remainingUses: number | null;
}

interface SignedStoredGrant extends StoredGrant {
  readonly signature: string;
}

interface GrantStoreDocument {
  readonly version: 1;
  readonly grants: readonly SignedStoredGrant[];
}

export interface PermissionGrantServiceOptions {
  readonly secret: string;
  readonly requestTtlMs: number;
  readonly storePath?: string;
  readonly allowIndefinite: boolean;
}

export class PermissionGrantService {
  private readonly requests = new Map<string, PendingRequest>();
  private readonly grants = new Map<string, StoredGrant>();

  public constructor(
    private readonly options: PermissionGrantServiceOptions,
    private readonly now: () => number = Date.now,
  ) {
    if (Buffer.byteLength(options.secret, 'utf8') < 32) {
      throw new Error('The write approval secret must contain at least 32 bytes.');
    }

    this.load();
  }

  public request(input: PermissionRequestInput, principal: string): PermissionRequest {
    this.sweep();

    if (this.requests.size >= 1_000) {
      throw new Error('The pending permission request limit has been reached.');
    }
    if (input.duration === 'indefinite' && !this.options.allowIndefinite) {
      throw new Error('Indefinite permission grants are disabled by server configuration.');
    }

    const toolsets = normalizeToolsets(input.toolsets);
    const reason = normalizeReason(input.reason);
    const requestId = randomUUID();
    const expiresAt = this.now() + this.options.requestTtlMs;
    const acknowledgement = acknowledgementPhrase(input.site, toolsets, input.duration);
    const pending: PendingRequest = {
      id: requestId,
      principalFingerprint: permissionPrincipalFingerprint(principal),
      site: input.site,
      toolsets,
      duration: input.duration,
      reason,
      acknowledgement,
      expiresAt,
    };

    this.requests.set(requestId, pending);

    return {
      requestId,
      acknowledgement,
      expiresAt: new Date(expiresAt).toISOString(),
      requested: {
        site: input.site,
        toolsets,
        duration: input.duration,
        reason,
      },
      instructions:
        'Show the complete request to the operator. Permission is not granted until the operator supplies the exact acknowledgement phrase and it is submitted to joomla_permission_approve.',
    };
  }

  public approve(
    requestId: string,
    acknowledgement: string,
    principal: string,
    authorize?: (site: string, toolsets: readonly WritePermissionToolset[]) => void,
  ): PermissionGrant {
    this.sweep();
    const pending = this.requests.get(requestId);

    if (pending === undefined) {
      throw new Error('Permission request is unknown or has expired.');
    }
    if (pending.principalFingerprint !== permissionPrincipalFingerprint(principal)) {
      throw new Error('Permission request belongs to another authenticated principal.');
    }
    if (!safeTextEqual(pending.acknowledgement, acknowledgement)) {
      throw new Error('Permission acknowledgement does not exactly match the requested phrase.');
    }

    authorize?.(pending.site, pending.toolsets);
    const createdAt = this.now();
    const stored: StoredGrant = {
      id: randomUUID(),
      principalFingerprint: pending.principalFingerprint,
      site: pending.site,
      toolsets: pending.toolsets,
      duration: pending.duration,
      createdAt,
      expiresAt: pending.duration === '30-minutes' ? createdAt + 1_800_000 : null,
      remainingUses: pending.duration === 'once' ? 1 : null,
    };

    this.requests.delete(requestId);
    this.grants.set(stored.id, stored);
    this.persist();
    return publicGrant(stored);
  }

  public list(principal: string): readonly PermissionGrant[] {
    this.sweep();
    const fingerprint = permissionPrincipalFingerprint(principal);

    return [...this.grants.values()]
      .filter((grant) => grant.principalFingerprint === fingerprint)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(publicGrant);
  }

  public revoke(grantId: string, principal: string): PermissionGrant {
    this.sweep();
    const grant = this.grants.get(grantId);

    if (grant === undefined || grant.principalFingerprint !== permissionPrincipalFingerprint(principal)) {
      throw new Error('Permission grant is unknown or belongs to another authenticated principal.');
    }

    this.grants.delete(grantId);
    this.persist();
    return publicGrant(grant);
  }

  public authorize(
    principal: string,
    site: string,
    toolset: WritePermissionToolset,
  ): PermissionGrant {
    this.sweep();
    const fingerprint = permissionPrincipalFingerprint(principal);
    const candidates = [...this.grants.values()]
      .filter((grant) =>
        grant.principalFingerprint === fingerprint
        && grant.site === site
        && grant.toolsets.includes(toolset)
        && (grant.remainingUses === null || grant.remainingUses > 0),
      )
      .sort((left, right) => durationRank(left.duration) - durationRank(right.duration));
    const grant = candidates[0];

    if (grant === undefined) {
      throw new Error(
        `No active operator permission grant allows ${toolset} on Joomla site ${site}. `
        + 'Call joomla_permission_request, show its exact acknowledgement phrase to the operator, '
        + 'then call joomla_permission_approve with the operator-provided phrase.',
      );
    }

    return publicGrant(grant);
  }

  public consume(
    grantId: string,
    principal: string,
    site: string,
    toolset: WritePermissionToolset,
  ): PermissionGrant {
    this.sweep();
    const grant = this.grants.get(grantId);

    if (
      grant === undefined
      || grant.principalFingerprint !== permissionPrincipalFingerprint(principal)
      || grant.site !== site
      || !grant.toolsets.includes(toolset)
    ) {
      throw new Error('The operator permission grant no longer authorizes this planned operation.');
    }

    if (grant.remainingUses !== null) {
      if (grant.remainingUses < 1) {
        throw new Error('The one-operation permission grant has already been used.');
      }
      grant.remainingUses -= 1;
      if (grant.remainingUses === 0) {
        this.grants.delete(grant.id);
      }
      this.persist();
    }

    return publicGrant(grant);
  }

  private load(): void {
    const path = this.options.storePath;

    if (path === undefined || !existsSync(path)) {
      return;
    }

    const raw = readFileSync(path, 'utf8');
    let document: unknown;

    try {
      document = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Permission grant store ${path} is not valid JSON.`);
    }

    if (!isGrantStoreDocument(document)) {
      throw new Error(`Permission grant store ${path} has an unsupported structure.`);
    }

    for (const signed of document.grants) {
      const { signature, ...grant } = signed;

      if (!safeTextEqual(this.sign(grant), signature)) {
        throw new Error(`Permission grant store ${path} failed integrity validation.`);
      }
      if (grant.duration === 'indefinite' && !this.options.allowIndefinite) {
        continue;
      }
      this.grants.set(grant.id, { ...grant });
    }

    this.sweep();
  }

  private persist(): void {
    const path = this.options.storePath;

    if (path === undefined) {
      return;
    }

    const document: GrantStoreDocument = {
      version: 1,
      grants: [...this.grants.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((grant) => ({ ...grant, signature: this.sign(grant) })),
    };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } catch (error) {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
      throw new Error(
        `Unable to persist permission grants in ${dirname(path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private sweep(): void {
    const now = this.now();
    let changed = false;

    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) {
        this.requests.delete(id);
      }
    }
    for (const [id, grant] of this.grants) {
      if (
        (grant.expiresAt !== null && grant.expiresAt <= now)
        || (grant.remainingUses !== null && grant.remainingUses < 1)
      ) {
        this.grants.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private sign(grant: StoredGrant): string {
    return createHmac('sha256', this.options.secret)
      .update(stableGrantJson(grant), 'utf8')
      .digest('base64url');
  }
}

export function permissionPrincipalFingerprint(principal: string): string {
  if (principal.length < 1 || principal.length > 2_048 || principal.includes('\0')) {
    throw new Error('Invalid permission principal.');
  }

  return createHash('sha256').update(principal, 'utf8').digest('base64url');
}

function normalizeToolsets(toolsets: readonly WritePermissionToolset[]): readonly WritePermissionToolset[] {
  const allowed = new Set<string>(writePermissionToolsets);
  const unique = [...new Set(toolsets)];

  if (unique.length < 1 || unique.length > writePermissionToolsets.length) {
    throw new Error('At least one bounded write or administration toolset is required.');
  }
  if (unique.some((toolset) => !allowed.has(toolset))) {
    throw new Error('Permission requests may contain only bounded write or administration toolsets.');
  }

  return Object.freeze(unique.sort());
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim().replace(/\s+/g, ' ');

  if (normalized.length < 3 || normalized.length > 500 || normalized.includes('\0')) {
    throw new Error('Permission reason must contain between 3 and 500 safe characters.');
  }

  return normalized;
}

function acknowledgementPhrase(
  site: string,
  toolsets: readonly WritePermissionToolset[],
  duration: PermissionGrantDuration,
): string {
  const durationLabel = duration === 'once'
    ? 'ONE OPERATION'
    : duration === '30-minutes'
      ? '30 MINUTES'
      : 'INDEFINITELY UNTIL REVOKED';
  const code = randomBytes(9).toString('base64url').toUpperCase();
  return `I GRANT ${durationLabel} ON ${site} FOR ${toolsets.join(', ')} — ${code}`;
}

function durationRank(duration: PermissionGrantDuration): number {
  if (duration === 'once') return 0;
  if (duration === '30-minutes') return 1;
  return 2;
}

function publicGrant(grant: StoredGrant): PermissionGrant {
  return Object.freeze({
    id: grant.id,
    site: grant.site,
    toolsets: grant.toolsets,
    duration: grant.duration,
    createdAt: new Date(grant.createdAt).toISOString(),
    expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
    remainingUses: grant.remainingUses,
  });
}

function stableGrantJson(grant: StoredGrant): string {
  return JSON.stringify({
    id: grant.id,
    principalFingerprint: grant.principalFingerprint,
    site: grant.site,
    toolsets: [...grant.toolsets],
    duration: grant.duration,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    remainingUses: grant.remainingUses,
  });
}

function safeTextEqual(expectedText: string, actualText: string): boolean {
  const expected = Buffer.from(expectedText, 'utf8');
  const actual = Buffer.from(actualText, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isGrantStoreDocument(value: unknown): value is GrantStoreDocument {
  if (
    typeof value !== 'object'
    || value === null
    || (value as Record<string, unknown>)['version'] !== 1
    || !Array.isArray((value as Record<string, unknown>)['grants'])
  ) {
    return false;
  }

  return (value as { grants: unknown[] }).grants.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const grant = entry as Record<string, unknown>;
    return typeof grant['id'] === 'string'
      && typeof grant['principalFingerprint'] === 'string'
      && typeof grant['site'] === 'string'
      && Array.isArray(grant['toolsets'])
      && grant['toolsets'].every((toolset) => typeof toolset === 'string' && writePermissionToolsets.includes(toolset as WritePermissionToolset))
      && (grant['duration'] === 'once' || grant['duration'] === '30-minutes' || grant['duration'] === 'indefinite')
      && typeof grant['createdAt'] === 'number'
      && (grant['expiresAt'] === null || typeof grant['expiresAt'] === 'number')
      && (grant['remainingUses'] === null || typeof grant['remainingUses'] === 'number')
      && typeof grant['signature'] === 'string';
  });
}
