import { createHash } from 'node:crypto';

import { z } from 'zod/v4';

import type { AuditSink } from '../audit/audit-sink.js';
import { getJoomlaWriteAction, joomlaCrudWriteActions, resolveJoomlaWriteRequest } from '../catalog/action-catalog.js';
import { sourceOnlyGateReason } from '../catalog/action-gates.js';
import {
  getCompanionWriteAction,
  normalizeCompanionWriteInput,
  supportsCompanionWriteAction,
  type CompanionActionDescriptor,
} from '../catalog/companion-actions.js';
import type { Configuration } from '../config/schema.js';
import {
  JoomlaApiClient,
  type JoomlaApiResponse,
  type JoomlaApiTransport,
} from '../infrastructure/api/joomla-api-client.js';
import {
  JoomlaCliClient,
  type CompanionEnvelope,
  type JoomlaCliTransport,
} from '../infrastructure/cli/joomla-cli-client.js';
import {
  ConfirmationService,
  SiteWriteLock,
  operationFingerprint,
  type ConfirmationPlan,
  type PlannedOperation,
} from '../security/confirmation-service.js';
import {
  PermissionGrantService,
  permissionPrincipalFingerprint,
  writePermissionToolsets,
  type PermissionGrant,
  type PermissionGrantDuration,
  type WritePermissionToolset,
} from '../security/permission-grant-service.js';
import { SiteRegistry } from './site-registry.js';

const idempotencyKeySchema = z.uuid();
const crudWriteActionIds = new Set(joomlaCrudWriteActions.map((action) => action.id));

const articleFields = {
  title: z.string().trim().min(1).max(255),
  alias: z.string().trim().max(400).optional(),
  catid: z.int().positive(),
  articletext: z.string().max(5_000_000).optional(),
  introtext: z.string().max(2_000_000).optional(),
  fulltext: z.string().max(3_000_000).optional(),
  state: z.int().min(-2).max(1).optional(),
  access: z.int().positive().optional(),
  featured: z.union([z.boolean(), z.int().min(0).max(1)]).optional(),
  language: z.string().max(50).optional(),
  metadesc: z.string().max(1_000).optional(),
  metakey: z.string().max(1_000).optional(),
  publish_up: z.iso.datetime({ local: true }).nullable().optional(),
  publish_down: z.iso.datetime({ local: true }).nullable().optional(),
} as const;

export const ArticleCreateSchema = z.object(articleFields).strict();
export const ArticleUpdateSchema = z.object(articleFields).partial().strict().refine((value) => Object.keys(value).length > 0, {
  message: 'An article update must contain at least one field.',
});

export type ArticleWritePlanInput =
  | {
      readonly site?: string | undefined;
      readonly operation: 'create';
      readonly data: unknown;
      readonly idempotencyKey: string;
    }
  | {
      readonly site?: string | undefined;
      readonly operation: 'update';
      readonly id: number;
      readonly data: unknown;
      readonly etag?: string | undefined;
      readonly idempotencyKey: string;
    }
  | {
      readonly site?: string | undefined;
      readonly operation: 'delete';
      readonly id: number;
      readonly etag?: string | undefined;
      readonly idempotencyKey: string;
    };

export interface JoomlaActionWritePlanInput {
  readonly site?: string | undefined;
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly transport?: 'auto' | 'api' | 'cli' | undefined;
  readonly idempotencyKey: string;
  readonly dryRun?: boolean | undefined;
}

export interface WritePreview {
  readonly dryRun: true;
  readonly confirmationRequired: true;
  readonly operation: ConfirmationPlan['operation'] & {
    readonly transport: 'api' | 'cli';
  };
}

export interface PermissionGrantRequestInput {
  readonly site?: string | undefined;
  readonly toolsets: readonly WritePermissionToolset[];
  readonly duration: PermissionGrantDuration;
  readonly reason: string;
}

interface CachedResult {
  readonly fingerprint: string;
  readonly value: Record<string, unknown>;
  readonly completedAt: number;
}

export class JoomlaWriteService {
  private readonly confirmation?: ConfirmationService;
  private readonly permissions?: PermissionGrantService;
  private readonly locks = new SiteWriteLock();
  private readonly completed = new Map<string, CachedResult>();

  public constructor(
    configuration: Configuration,
    private readonly sites: SiteRegistry,
    private readonly api: JoomlaApiTransport = new JoomlaApiClient(),
    private readonly audit?: AuditSink,
    private readonly cli: JoomlaCliTransport = new JoomlaCliClient(),
  ) {
    if (configuration.approval !== undefined) {
      this.confirmation = new ConfirmationService(configuration.approval.secret, configuration.approval.ttlMs);
      this.permissions = new PermissionGrantService({
        secret: configuration.approval.secret,
        requestTtlMs: configuration.approval.requestTtlMs ?? 300_000,
        ...(configuration.approval.grantStorePath === undefined
          ? {}
          : { storePath: configuration.approval.grantStorePath }),
        allowIndefinite: configuration.approval.allowIndefinite ?? false,
      });
    }
  }

  public async requestPermission(
    input: PermissionGrantRequestInput,
    principal = 'local-stdio',
  ): Promise<ReturnType<PermissionGrantService['request']>> {
    const site = this.sites.get(input.site);

    for (const toolset of input.toolsets) {
      this.sites.requireToolset(site, toolset);
    }

    const request = this.requirePermissions().request({
      site: site.id,
      toolsets: input.toolsets,
      duration: input.duration,
      reason: input.reason,
    }, principal);
    await this.audit?.write({
      timestamp: new Date().toISOString(),
      event: 'permission.requested',
      site: site.id,
      action: 'authorization.permission.request',
      principalFingerprint: permissionPrincipalFingerprint(principal),
      permissionRequestId: request.requestId,
      duration: input.duration,
      toolsets: request.requested.toolsets,
      outcome: 'requested',
    });
    return request;
  }

  public async approvePermission(
    requestId: string,
    acknowledgement: string,
    principal = 'local-stdio',
    authorize?: (site: string, toolsets: readonly WritePermissionToolset[]) => void,
  ): Promise<PermissionGrant> {
    const grant = this.requirePermissions().approve(requestId, acknowledgement, principal, authorize);
    await this.audit?.write({
      timestamp: new Date().toISOString(),
      event: 'permission.approved',
      site: grant.site,
      action: 'authorization.permission.approve',
      principalFingerprint: permissionPrincipalFingerprint(principal),
      permissionRequestId: requestId,
      grantId: grant.id,
      duration: grant.duration,
      toolsets: grant.toolsets,
      outcome: 'approved',
    });
    return grant;
  }

  public listPermissions(principal = 'local-stdio'): readonly PermissionGrant[] {
    return this.requirePermissions().list(principal);
  }

  public async revokePermission(grantId: string, principal = 'local-stdio'): Promise<PermissionGrant> {
    const grant = this.requirePermissions().revoke(grantId, principal);
    await this.audit?.write({
      timestamp: new Date().toISOString(),
      event: 'permission.revoked',
      site: grant.site,
      action: 'authorization.permission.revoke',
      principalFingerprint: permissionPrincipalFingerprint(principal),
      grantId: grant.id,
      duration: grant.duration,
      toolsets: grant.toolsets,
      outcome: 'revoked',
    });
    return grant;
  }

  public async planArticle(input: ArticleWritePlanInput, principal = 'local-stdio'): Promise<ConfirmationPlan> {
    const confirmation = this.requireConfirmation();
    const site = this.sites.get(input.site);
    this.sites.requireToolset(site, 'content.write');
    idempotencyKeySchema.parse(input.idempotencyKey);

    if (site.api === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the API adapter.`);
    }

    let operation: PlannedOperation;

    if (input.operation === 'create') {
      const body = ArticleCreateSchema.parse(input.data);
      operation = {
        site: site.id,
        action: 'content.articles.create',
        method: 'POST',
        path: 'v1/content/articles',
        body,
        idempotencyKey: input.idempotencyKey,
        summary: `Create article “${body.title}” in category ${body.catid}.`,
      };
    } else if (input.operation === 'update') {
      const body = ArticleUpdateSchema.parse(input.data);
      operation = {
        site: site.id,
        action: 'content.articles.update',
        method: 'PATCH',
        path: `v1/content/articles/${positiveId(input.id)}`,
        body,
        ...(input.etag === undefined ? {} : { etag: safeEtag(input.etag) }),
        idempotencyKey: input.idempotencyKey,
        summary: `Update article ${input.id}; fields: ${Object.keys(body).sort().join(', ')}.`,
      };
    } else {
      operation = {
        site: site.id,
        action: 'content.articles.delete',
        method: 'DELETE',
        path: `v1/content/articles/${positiveId(input.id)}`,
        ...(input.etag === undefined ? {} : { etag: safeEtag(input.etag) }),
        idempotencyKey: input.idempotencyKey,
        summary: `Delete article ${input.id}. Joomla applies the resource model's delete lifecycle.`,
      };
    }

    const grant = this.requirePermissions().authorize(principal, site.id, 'content.write');
    operation = { ...operation, permissionGrantId: grant.id };
    const plan = confirmation.create(operation, principal);
    await this.audit?.write({
      timestamp: new Date().toISOString(),
      event: 'write.planned',
      site: operation.site,
      action: operation.action,
      idempotencyKey: operation.idempotencyKey,
      principalFingerprint: principalFingerprint(principal),
      outcome: 'planned',
    });
    return plan;
  }

  public async planAction(
    input: JoomlaActionWritePlanInput,
    principal = 'local-stdio',
  ): Promise<ConfirmationPlan | WritePreview> {
    const gateReason = sourceOnlyGateReason(input.action);

    if (gateReason !== undefined) {
      throw new Error(`Joomla action ${input.action} is source-catalogued but not executable: ${gateReason}`);
    }

    const action = getJoomlaWriteAction(input.action);

    if (action === undefined) {
      const companionAction = getCompanionWriteAction(input.action);

      if (companionAction === undefined) {
        throw new Error(`Unknown Joomla write action: ${input.action}.`);
      }

      return this.planCompanionAction(input, companionAction, principal);
    }

    const site = this.sites.get(input.site);
    this.sites.requireToolset(site, action.toolset);
    idempotencyKeySchema.parse(input.idempotencyKey);
    const request = resolveJoomlaWriteRequest(action.id, input.input);
    const transport = this.selectTransport(site, input.transport ?? 'auto');

    if (transport === 'cli') {
      if (!supportsCompanionWriteAction(action.id)) {
        throw new Error(`Joomla action ${action.id} has no fixed companion implementation.`);
      }
      if (request.etag !== undefined) {
        throw new Error('ETag preconditions are only supported by the Joomla API transport.');
      }
      await this.requireCompanionAction(site.cli!, action.id);
    }
    const preflight = transport === 'cli'
      ? await this.preflightCompanionAction(site.cli!, action.id, input.input)
      : undefined;

    const subject = action.operation === 'create'
      ? action.id.slice(0, -'.create'.length)
      : `${action.id.slice(0, action.id.lastIndexOf('.'))} ${String(input.input['id'])}`;
    const operation: PlannedOperation = {
      site: site.id,
      action: action.id,
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.etag === undefined ? {} : { etag: request.etag }),
      idempotencyKey: input.idempotencyKey,
      summary: `${action.operation[0]!.toUpperCase()}${action.operation.slice(1)} ${subject} via Joomla ${transport.toUpperCase()}.`,
      transport,
      toolset: action.toolset,
      actionInput: input.input,
      ...(preflight === undefined ? {} : { preflight }),
    };

    if (input.dryRun === true) {
      const preview: WritePreview = {
        dryRun: true,
        confirmationRequired: true,
        operation: {
          site: operation.site,
          action: operation.action,
          method: operation.method,
          summary: operation.summary,
          idempotencyKey: operation.idempotencyKey,
          fingerprint: operationHash(operation),
          transport,
          ...(operation.preflight === undefined ? {} : { preflight: operation.preflight }),
        },
      };
      await this.audit?.write({
        timestamp: new Date().toISOString(), event: 'write.previewed', site: operation.site,
        action: operation.action, transport, idempotencyKey: operation.idempotencyKey, outcome: 'previewed',
        principalFingerprint: principalFingerprint(principal),
      });
      return preview;
    }

    const grant = this.requirePermissions().authorize(
      principal,
      site.id,
      asWritePermissionToolset(action.toolset),
    );
    const plan = this.requireConfirmation().create(
      { ...operation, permissionGrantId: grant.id },
      principal,
    );
    await this.audit?.write({
      timestamp: new Date().toISOString(), event: 'write.planned', site: operation.site,
      action: operation.action, transport, idempotencyKey: operation.idempotencyKey, outcome: 'planned',
      principalFingerprint: principalFingerprint(principal),
    });
    return plan;
  }

  private async planCompanionAction(
    input: JoomlaActionWritePlanInput,
    action: CompanionActionDescriptor,
    principal: string,
  ): Promise<ConfirmationPlan | WritePreview> {
    if (input.transport === 'api') {
      throw new Error(`Joomla action ${action.id} is available only through the local companion transport.`);
    }

    const site = this.sites.get(input.site);
    this.sites.requireToolset(site, action.toolset);
    idempotencyKeySchema.parse(input.idempotencyKey);

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    const actionInput = normalizeCompanionWriteInput(action.id, input.input);
    await this.requireCompanionAction(site.cli, action.id);
    const preflight = await this.preflightCompanionAction(site.cli, action.id, actionInput);
    const operation: PlannedOperation = {
      site: site.id,
      action: action.id,
      method: 'POST',
      path: `companion:${action.id}`,
      idempotencyKey: input.idempotencyKey,
      summary: `${action.title} through Joomla’s native companion adapter.`,
      transport: 'cli',
      toolset: action.toolset,
      actionInput,
      preflight,
    };

    if (input.dryRun === true) {
      const preview: WritePreview = {
        dryRun: true,
        confirmationRequired: true,
        operation: {
          site: operation.site,
          action: operation.action,
          method: operation.method,
          summary: operation.summary,
          idempotencyKey: operation.idempotencyKey,
          fingerprint: operationHash(operation),
          transport: 'cli',
          preflight,
        },
      };
      await this.audit?.write({
        timestamp: new Date().toISOString(), event: 'write.previewed', site: operation.site,
        action: operation.action, transport: 'cli', idempotencyKey: operation.idempotencyKey, outcome: 'previewed',
        principalFingerprint: principalFingerprint(principal),
      });
      return preview;
    }

    const grant = this.requirePermissions().authorize(
      principal,
      site.id,
      asWritePermissionToolset(action.toolset),
    );
    const plan = this.requireConfirmation().create(
      { ...operation, permissionGrantId: grant.id },
      principal,
    );
    await this.audit?.write({
      timestamp: new Date().toISOString(), event: 'write.planned', site: operation.site,
      action: operation.action, transport: 'cli', idempotencyKey: operation.idempotencyKey, outcome: 'planned',
      principalFingerprint: principalFingerprint(principal),
    });
    return plan;
  }

  public async apply(
    confirmationToken: string,
    principal = 'local-stdio',
    authorize?: (site: string, toolset: string) => void,
  ): Promise<Record<string, unknown>> {
    this.sweepCompleted();
    const operation = this.requireConfirmation().consume(confirmationToken, principal, (planned) => {
      const action = getJoomlaWriteAction(planned.action);
      const companionAction = getCompanionWriteAction(planned.action);
      const toolset = action?.toolset ?? companionAction?.toolset ?? planned.toolset ?? 'content.write';
      authorize?.(planned.site, toolset);
    });
    const action = getJoomlaWriteAction(operation.action);
    const companionAction = getCompanionWriteAction(operation.action);
    const toolset = asWritePermissionToolset(
      action?.toolset ?? companionAction?.toolset ?? operation.toolset ?? 'content.write',
    );
    if (operation.permissionGrantId === undefined) {
      throw new Error('The planned operation is not bound to an operator permission grant.');
    }
    const usedGrant = this.requirePermissions().consume(
      operation.permissionGrantId,
      principal,
      operation.site,
      toolset,
    );
    await this.audit?.write({
      timestamp: new Date().toISOString(),
      event: 'permission.used',
      site: operation.site,
      action: operation.action,
      idempotencyKey: operation.idempotencyKey,
      principalFingerprint: permissionPrincipalFingerprint(principal),
      grantId: usedGrant.id,
      duration: usedGrant.duration,
      toolsets: [toolset],
      outcome: 'success',
    });
    const cacheKey = completedCacheKey(principal, operation.idempotencyKey);
    const cached = this.completed.get(cacheKey);
    const fingerprint = operationHash(operation);

    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error('The idempotency key was already used for a different operation.');
      }

      return { ...cached.value, idempotentReplay: true };
    }

    return this.locks.run(operation.site, async () => {
      const site = this.sites.get(operation.site);
      const action = getJoomlaWriteAction(operation.action);
      const companionAction = getCompanionWriteAction(operation.action);
      if (action === undefined && companionAction === undefined) {
        throw new Error(`Planned Joomla action ${operation.action} is no longer allowlisted.`);
      }
      const toolset = action?.toolset ?? companionAction?.toolset ?? operation.toolset ?? 'content.write';
      this.sites.requireToolset(site, toolset);
      const transport = operation.transport ?? 'api';

      try {
        const mutation = transport === 'api'
          ? await this.applyApi(site, operation)
          : await this.applyCli(site, operation);
        const verification = transport === 'api'
          ? await this.verificationRead(site.api!, operation, mutation as JoomlaApiResponse)
          : { acknowledgedBy: 'joomla-companion' as const };
        const value = {
          site: operation.site,
          action: operation.action,
          idempotencyKey: operation.idempotencyKey,
          mutation,
          verification,
          idempotentReplay: false,
        };
        if (this.completed.size >= 10_000) {
          const oldest = this.completed.keys().next().value as string | undefined;
          if (oldest !== undefined) this.completed.delete(oldest);
        }
        this.completed.set(cacheKey, { fingerprint, value, completedAt: Date.now() });
        await this.audit?.write({
          timestamp: new Date().toISOString(),
          event: 'write.applied',
          site: operation.site,
          action: operation.action,
          idempotencyKey: operation.idempotencyKey,
          principalFingerprint: principalFingerprint(principal),
          transport,
          outcome: 'success',
        });
        return value;
      } catch (error) {
        await this.audit?.write({
          timestamp: new Date().toISOString(),
          event: 'write.failed',
          site: operation.site,
          action: operation.action,
          idempotencyKey: operation.idempotencyKey,
          principalFingerprint: principalFingerprint(principal),
          transport,
          outcome: 'failure',
          detail: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        });
        throw error;
      }
    });
  }

  private async applyApi(site: ReturnType<SiteRegistry['get']>, operation: PlannedOperation): Promise<JoomlaApiResponse> {
    if (site.api === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the API adapter.`);
    }

    const action = getJoomlaWriteAction(operation.action);

    if (action === undefined) {
      throw new Error(`Planned Joomla API action ${operation.action} is no longer allowlisted.`);
    }

    return this.api.request(site.api, {
      method: operation.method,
      path: operation.path,
      ...(operation.body === undefined ? {} : { body: operation.body }),
      ...(operation.etag === undefined ? {} : { etag: operation.etag }),
      idempotencyKey: operation.idempotencyKey,
      authentication: action.driver.authentication,
    });
  }

  private async applyCli(site: ReturnType<SiteRegistry['get']>, operation: PlannedOperation): Promise<CompanionEnvelope> {
    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    await this.requireCompanionAction(site.cli, operation.action);
    const input: Record<string, unknown> = operation.actionInput === undefined
      ? legacyCliInput(operation)
      : { ...operation.actionInput };
    delete input['etag'];
    const currentPreflight = await this.preflightCompanionAction(site.cli, operation.action, input);

    if (
      operation.preflight === undefined ||
      valueFingerprint(currentPreflight) !== valueFingerprint(operation.preflight)
    ) {
      throw new Error(`Joomla companion preconditions changed after action ${operation.action} was planned.`);
    }
    input['dryRun'] = false;
    input['_edgeConfirmed'] = true;
    const envelope = await this.cli.dispatch(site.cli, operation.action, input);
    const result = asRecord(asRecord(envelope.data)['result']);

    if (result['applied'] !== true || result['dryRun'] !== false) {
      throw new Error(`Joomla companion did not prove that action ${operation.action} was applied.`);
    }

    return envelope;
  }

  private selectTransport(
    site: ReturnType<SiteRegistry['get']>,
    requested: 'auto' | 'api' | 'cli',
  ): 'api' | 'cli' {
    if (requested === 'api') {
      if (site.api === undefined) throw new Error(`Joomla site ${site.id} does not configure the API adapter.`);
      return 'api';
    }
    if (requested === 'cli') {
      if (site.cli === undefined) throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
      return 'cli';
    }
    if (site.api !== undefined) return 'api';
    if (site.cli !== undefined) return 'cli';
    throw new Error(`Joomla site ${site.id} has no available transport.`);
  }

  private async requireCompanionAction(
    cli: NonNullable<ReturnType<SiteRegistry['get']>['cli']>,
    actionId: string,
  ): Promise<void> {
    const capability = await this.cli.describe(cli);
    const data = asRecord(capability.data);
    const actions = Array.isArray(data['actions']) ? data['actions'] : [];
    const descriptor = actions.map(asRecord).find((candidate) => candidate['name'] === actionId);

    if (descriptor === undefined) {
      throw new Error(`Joomla companion does not advertise action ${actionId}.`);
    }
    if (asRecord(descriptor['effective'])['allowed'] !== true) {
      throw new Error(`Joomla companion denies action ${actionId} for its configured actor.`);
    }
  }

  private async preflightCompanionAction(
    cli: NonNullable<ReturnType<SiteRegistry['get']>['cli']>,
    actionId: string,
    actionInput: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const input: Record<string, unknown> = { ...actionInput, dryRun: true };
    delete input['_edgeConfirmed'];
    const envelope = await this.cli.dispatch(cli, actionId, input);
    const result = asRecord(asRecord(envelope.data)['result']);

    if (result['dryRun'] !== true || result['applied'] !== false) {
      throw new Error(`Joomla companion did not return a non-mutating preflight for action ${actionId}.`);
    }

    return redactSensitivePreflight(result);
  }

  private async verificationRead(
    api: NonNullable<ReturnType<SiteRegistry['get']>['api']>,
    operation: PlannedOperation,
    mutation: JoomlaApiResponse,
  ): Promise<
    JoomlaApiResponse
    | { readonly acknowledgedBy: 'joomla-api'; readonly postcondition: 'not-verified'; readonly reason: string }
    | { readonly notPerformed: true; readonly reason: string }
  > {
    if (operation.method === 'DELETE') {
      return {
        acknowledgedBy: 'joomla-api',
        postcondition: 'not-verified',
        reason: 'Joomla accepted the delete request; resource-specific absence or trash-state verification is not yet defined.',
      };
    }

    if (!crudWriteActionIds.has(operation.action)) {
      return {
        notPerformed: true,
        reason: 'No safe generic postcondition read is defined for this special Joomla action.',
      };
    }

    const basePath = operation.method === 'PATCH' ? operation.path.split('/').slice(0, -1).join('/') : operation.path;
    const id = operation.method === 'PATCH' ? operation.path.split('/').at(-1) : responseId(mutation.data);
    return id === undefined ? mutation : this.api.get(api, `${basePath}/${positiveId(Number(id))}`);
  }

  private requireConfirmation(): ConfirmationService {
    if (this.confirmation === undefined) {
      throw new Error('Controlled writes are unavailable until the approval secret is configured.');
    }

    return this.confirmation;
  }

  private requirePermissions(): PermissionGrantService {
    if (this.permissions === undefined) {
      throw new Error('Operator permission grants are unavailable until the approval configuration is enabled.');
    }

    return this.permissions;
  }

  private sweepCompleted(): void {
    const threshold = Date.now() - 86_400_000;

    for (const [key, result] of this.completed) {
      if (result.completedAt <= threshold) {
        this.completed.delete(key);
      }
    }
  }
}

function asWritePermissionToolset(toolset: string): WritePermissionToolset {
  if (!writePermissionToolsets.includes(toolset as WritePermissionToolset)) {
    throw new Error(`Joomla toolset ${toolset} is not a bounded write or administration permission.`);
  }

  return toolset as WritePermissionToolset;
}

function positiveId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('A positive integer resource id is required.');
  }

  return id;
}

function safeEtag(etag: string): string {
  if (!/^(?:W\/)?"[\x21\x23-\x7E]+"$/.test(etag)) {
    throw new Error('Invalid ETag value.');
  }

  return etag;
}

function responseId(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const candidate = typeof record['data'] === 'object' && record['data'] !== null ? record['data'] : record;
  const id = (candidate as Record<string, unknown>)['id'];
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

function operationHash(operation: PlannedOperation): string {
  return operationFingerprint(operation);
}

function principalFingerprint(principal: string): string {
  return createHash('sha256').update(principal, 'utf8').digest('base64url');
}

function completedCacheKey(principal: string, idempotencyKey: string): string {
  return `${principalFingerprint(principal)}:${idempotencyKey}`;
}

function valueFingerprint(value: unknown): string {
  return operationFingerprint({
    site: 'preflight',
    action: 'preflight',
    method: 'POST',
    path: 'preflight',
    idempotencyKey: 'preflight',
    summary: 'preflight',
    preflight: asRecord(value),
  });
}

function redactSensitivePreflight(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(redactRecord(value, 0));
}

function redactRecord(value: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  if (depth > 12) {
    return {};
  }

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (/(?:password|token|secret|authorization|credential)/i.test(key)) {
      result[key] = '[REDACTED]';
    } else if (Array.isArray(entry)) {
      result[key] = entry.map((item) => isPlainObject(item) ? redactRecord(item, depth + 1) : item);
    } else if (isPlainObject(entry)) {
      result[key] = redactRecord(entry, depth + 1);
    } else {
      result[key] = entry;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function legacyCliInput(operation: PlannedOperation): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const id = operation.path.split('/').at(-1);

  if (operation.method !== 'POST' && id !== undefined) input['id'] = Number(id);
  if (operation.body !== undefined) input['data'] = operation.body;
  return input;
}
