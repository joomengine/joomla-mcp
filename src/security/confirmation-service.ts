import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Toolset } from '../config/schema.js';

export interface PlannedOperation {
  readonly site: string;
  readonly action: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly etag?: string;
  readonly idempotencyKey: string;
  readonly summary: string;
  /** Omitted only for confirmation tokens created by the original article API tools. */
  readonly transport?: 'api' | 'cli';
  /** Resolved from the immutable action catalogue when the operation is planned. */
  readonly toolset?: Toolset;
  /** Validated semantic input retained for companion execution; never included in the public confirmation token. */
  readonly actionInput?: Readonly<Record<string, unknown>>;
  /** Redacted Joomla-native dry-run result bound into the plan fingerprint. */
  readonly preflight?: Readonly<Record<string, unknown>>;
  /** Principal-bound operator grant revalidated and, when applicable, consumed immediately before apply. */
  readonly permissionGrantId?: string;
}

export interface ConfirmationPlan {
  readonly confirmationToken: string;
  readonly expiresAt: string;
  readonly operation: {
    readonly site: string;
    readonly action: string;
    readonly method: PlannedOperation['method'];
    readonly summary: string;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly preflight?: Readonly<Record<string, unknown>>;
  };
}

interface StoredPlan {
  readonly operation: PlannedOperation;
  readonly fingerprint: string;
  readonly principalFingerprint: string;
  readonly expiresAt: number;
  used: boolean;
}

interface TokenPayload {
  readonly id: string;
  readonly site: string;
  readonly action: string;
  readonly exp: number;
  readonly fingerprint: string;
  readonly principalFingerprint: string;
}

export class ConfirmationService {
  private readonly plans = new Map<string, StoredPlan>();

  public constructor(
    private readonly secret: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error('The write approval secret must contain at least 32 bytes.');
    }
  }

  public create(operation: PlannedOperation, principal = 'local-stdio'): ConfirmationPlan {
    this.sweep();

    if (this.plans.size >= 1_000) {
      throw new Error('The pending write confirmation limit has been reached.');
    }

    const id = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    const fingerprint = operationFingerprint(operation);
    const principalFingerprint = identityFingerprint(principal);
    const payload: TokenPayload = {
      id,
      site: operation.site,
      action: operation.action,
      exp: expiresAt,
      fingerprint,
      principalFingerprint,
    };
    const encoded = encode(JSON.stringify(payload));
    const signature = this.sign(encoded);

    this.plans.set(id, { operation, fingerprint, principalFingerprint, expiresAt, used: false });

    return {
      confirmationToken: `${encoded}.${signature}`,
      expiresAt: new Date(expiresAt).toISOString(),
      operation: {
        site: operation.site,
        action: operation.action,
        method: operation.method,
        summary: operation.summary,
        idempotencyKey: operation.idempotencyKey,
        fingerprint,
        ...(operation.preflight === undefined ? {} : { preflight: operation.preflight }),
      },
    };
  }

  public consume(
    token: string,
    principal = 'local-stdio',
    authorize?: (operation: PlannedOperation) => void,
  ): PlannedOperation {
    const [encoded, receivedSignature, extra] = token.split('.');

    if (encoded === undefined || receivedSignature === undefined || extra !== undefined) {
      throw new Error('Invalid write confirmation token.');
    }

    const expectedSignature = this.sign(encoded);
    const actual = Buffer.from(receivedSignature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid write confirmation token signature.');
    }

    const payload = parsePayload(Buffer.from(encoded, 'base64url').toString('utf8'));
    const stored = this.plans.get(payload.id);

    if (stored === undefined || stored.used) {
      throw new Error('Write confirmation token is unknown or has already been used.');
    }

    if (payload.exp !== stored.expiresAt || payload.exp <= this.now()) {
      this.plans.delete(payload.id);
      throw new Error('Write confirmation token has expired.');
    }

    if (
      payload.site !== stored.operation.site ||
      payload.action !== stored.operation.action ||
      payload.fingerprint !== stored.fingerprint ||
      payload.principalFingerprint !== stored.principalFingerprint ||
      identityFingerprint(principal) !== stored.principalFingerprint ||
      operationFingerprint(stored.operation) !== stored.fingerprint
    ) {
      throw new Error('Write confirmation token does not match its planned operation.');
    }

    authorize?.(stored.operation);
    stored.used = true;
    return stored.operation;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private sweep(): void {
    const now = this.now();

    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= now || plan.used) {
        this.plans.delete(id);
      }
    }
  }
}

export class SiteWriteLock {
  private readonly locked = new Set<string>();

  public async run<T>(site: string, operation: () => Promise<T>): Promise<T> {
    if (this.locked.has(site)) {
      throw new Error(`Another write is already in progress for Joomla site ${site}.`);
    }

    this.locked.add(site);

    try {
      return await operation();
    } finally {
      this.locked.delete(site);
    }
  }
}

export function operationFingerprint(operation: PlannedOperation): string {
  return createHash('sha256').update(stableJson(operation)).digest('base64url');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function parsePayload(raw: string): TokenPayload {
  let value: unknown;

  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid write confirmation token payload.');
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>)['id'] !== 'string' ||
    typeof (value as Record<string, unknown>)['site'] !== 'string' ||
    typeof (value as Record<string, unknown>)['action'] !== 'string' ||
    typeof (value as Record<string, unknown>)['exp'] !== 'number' ||
    typeof (value as Record<string, unknown>)['fingerprint'] !== 'string' ||
    typeof (value as Record<string, unknown>)['principalFingerprint'] !== 'string'
  ) {
    throw new Error('Invalid write confirmation token payload.');
  }

  return value as TokenPayload;
}

function identityFingerprint(principal: string): string {
  if (principal.length < 1 || principal.length > 2_048 || principal.includes('\0')) {
    throw new Error('Invalid write approval principal.');
  }

  return createHash('sha256').update(principal, 'utf8').digest('base64url');
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
