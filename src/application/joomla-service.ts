import type { CliEnvelope, CompanionEnvelope } from '../infrastructure/cli/joomla-cli-client.js';
import type { AuditSink } from '../audit/audit-sink.js';
import { publicCatalog } from '../catalog/core.js';
import {
  findJoomlaActions,
  findJoomlaReadActions,
  getJoomlaAction,
  getJoomlaReadAction,
  getJoomlaWriteAction,
  joomlaCrudReadActions,
  joomlaCrudWriteActions,
  resolveJoomlaReadRequest,
} from '../catalog/action-catalog.js';
import {
  companionActions,
  companionReadActions,
  getCompanionReadAction,
  getCompanionWriteAction,
  normalizeCompanionReadInput,
  supportsCompanionReadAction,
  supportsCompanionWriteAction,
  type CompanionActionDescriptor,
} from '../catalog/companion-actions.js';
import type { JoomlaActionDescriptor } from '../contracts/action-catalog.js';
import type { Toolset } from '../config/schema.js';
import { getJoomlaCliCommandTarget, joomlaCliCommandTargets } from '../catalog/cli-command-targets.js';
import { sourceOnlyGateReason } from '../catalog/action-gates.js';
import {
  JoomlaApiClient,
  type JoomlaApiResponse,
  type JoomlaApiTransport,
} from '../infrastructure/api/joomla-api-client.js';
import { JoomlaCliClient, type JoomlaCliTransport } from '../infrastructure/cli/joomla-cli-client.js';
import { SiteRegistry } from './site-registry.js';

export interface ArticleListInput {
  readonly site?: string | undefined;
  readonly offset: number;
  readonly limit: number;
  readonly search?: string | undefined;
  readonly state?: number | undefined;
  readonly featured?: boolean | undefined;
  readonly category?: number | undefined;
  readonly tag?: number | undefined;
  readonly language?: string | undefined;
  readonly ordering?: string | undefined;
  readonly direction?: 'ASC' | 'DESC' | undefined;
}

export const companionReadToolsets: Readonly<Record<string, Toolset>> = Object.freeze(
  Object.fromEntries(companionReadActions.map((action) => [action.id, action.toolset])),
);
const crudReadActionIds = new Set(joomlaCrudReadActions.map((action) => action.id));
const crudWriteActionIds = new Set(joomlaCrudWriteActions.map((action) => action.id));

export class JoomlaService {
  public constructor(
    private readonly sites: SiteRegistry,
    private readonly api: JoomlaApiTransport = new JoomlaApiClient(),
    private readonly cli: JoomlaCliTransport = new JoomlaCliClient(),
    private readonly audit?: AuditSink,
  ) {}

  public siteSummary(): Record<string, unknown> {
    return this.sites.summary();
  }

  public capabilities(siteId?: string): Record<string, unknown> {
    const site = this.site(siteId, 'discovery');

    return {
      site: {
        id: site.id,
        api: site.api !== undefined,
        cli: site.cli !== undefined,
        toolsets: [...site.toolsets],
      },
      catalog: publicCatalog(),
      notes: [
        'Joomla core does not expose OpenAPI or route discovery.',
        'API responses are JSON:API, but POST and PATCH bodies are flat Joomla form JSON.',
        'Stock CLI list output is human-oriented; the companion also exposes a bounded structured command inventory.',
      ],
    };
  }

  public async listArticles(input: ArticleListInput): Promise<JoomlaApiResponse> {
    const site = this.site(input.site, 'content.read');
    const api = this.requireApi(site.id);
    const limit = Math.min(input.limit, api.maxPageSize);
    const query: Record<string, string | number | boolean> = {
      'page[offset]': input.offset,
      'page[limit]': limit,
    };

    add(query, 'filter[search]', input.search);
    add(query, 'filter[state]', input.state);
    add(query, 'filter[featured]', input.featured);
    add(query, 'filter[category]', input.category);
    add(query, 'filter[tag]', input.tag);
    add(query, 'filter[language]', input.language);
    add(query, 'list[ordering]', input.ordering);
    add(query, 'list[direction]', input.direction);

    return this.api.get(api, 'v1/content/articles', query);
  }

  public async getArticle(id: number, siteId?: string): Promise<JoomlaApiResponse> {
    const site = this.site(siteId, 'content.read');
    return this.api.get(this.requireApi(site.id), `v1/content/articles/${id}`);
  }

  public async listExtensions(
    input: {
      readonly site?: string | undefined;
      readonly offset: number;
      readonly limit: number;
      readonly core?: boolean | undefined;
      readonly status?: string | undefined;
      readonly type?: string | undefined;
    },
  ): Promise<JoomlaApiResponse> {
    const site = this.site(input.site, 'extensions.read');
    const api = this.requireApi(site.id);
    const query: Record<string, string | number | boolean> = {
      'page[offset]': input.offset,
      'page[limit]': Math.min(input.limit, api.maxPageSize),
    };
    add(query, 'filter[core]', input.core);
    add(query, 'filter[status]', input.status);
    add(query, 'filter[type]', input.type);

    return this.api.get(api, 'v1/extensions', query);
  }

  public async safeApplicationConfig(siteId?: string): Promise<Record<string, unknown>> {
    const site = this.site(siteId, 'configuration.read');
    const response = await this.api.get(this.requireApi(site.id), 'v1/config/application');

    return {
      status: response.status,
      headers: response.headers,
      data: selectSafeConfiguration(response.data),
    };
  }

  public async listCliCommands(siteId?: string): Promise<CliEnvelope> {
    const site = this.site(siteId, 'cli.discovery');

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    return this.cli.list(site.cli);
  }

  public async cliCommandHelp(command: string, siteId?: string): Promise<CliEnvelope> {
    const site = this.site(siteId, 'cli.discovery');

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    return this.cli.help(site.cli, command);
  }

  public async cliTargets(command: string | undefined, siteId?: string): Promise<Record<string, unknown>> {
    const site = this.site(siteId, 'cli.discovery');

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    if (command !== undefined && getJoomlaCliCommandTarget(command) === undefined) {
      throw new Error(`Unknown stock Joomla CLI command: ${command}.`);
    }

    const inventory = await this.cli.inventory(site.cli);
    const payload = asRecord(inventory.data);
    const installedEntries = Array.isArray(payload['commands']) ? payload['commands'].map(asRecord) : [];
    const installedByName = new Map(
      installedEntries
        .filter((entry) => typeof entry['name'] === 'string')
        .map((entry) => [entry['name'] as string, entry]),
    );
    const selected = command === undefined
      ? joomlaCliCommandTargets
      : [getJoomlaCliCommandTarget(command)!];

    return {
      site: site.id,
      installedCommandCount: payload['commandCount'],
      count: selected.length,
      targets: selected.map((target) => ({
        ...target,
        installed: installedByName.has(target.command),
        installedContract: installedByName.get(target.command) ?? null,
      })),
    };
  }

  public async companionCapabilities(siteId?: string): Promise<CompanionEnvelope> {
    const site = this.site(siteId, 'cli.discovery');

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    return this.cli.describe(site.cli);
  }

  public async cliInventory(siteId?: string): Promise<CompanionEnvelope> {
    const site = this.site(siteId, 'cli.discovery');

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    return this.cli.inventory(site.cli);
  }

  public async dispatchCompanionRead(input: {
    readonly site?: string | undefined;
    readonly action: string;
    readonly input?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<CompanionEnvelope> {
    const action = getCompanionReadAction(input.action);

    if (action === undefined) {
      throw new Error(`Unknown Joomla companion read action: ${input.action}.`);
    }

    const site = this.site(input.site, action.toolset);

    if (site.cli === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
    }

    await this.requireCompanionAction(site.cli, action.id);
    return this.cli.dispatch(site.cli, action.id, normalizeCompanionReadInput(action.id, input.input ?? {}));
  }

  public async searchReadActions(input: {
    readonly site?: string | undefined;
    readonly text?: string | undefined;
    readonly domain?: string | undefined;
    readonly includeSensitive?: boolean | undefined;
    readonly includeWrites?: boolean | undefined;
  }): Promise<Record<string, unknown>> {
    const site = this.site(input.site, 'discovery');
    const companionCapability = await this.effectiveCompanionActions(site);
    const apiActions = input.includeWrites === true ? findJoomlaActions({
      toolsets: site.toolsets,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.includeSensitive === undefined ? {} : { includeSensitive: input.includeSensitive }),
      includeWrites: true,
    }) : findJoomlaReadActions({
      toolsets: site.toolsets,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.includeSensitive === undefined ? {} : { includeSensitive: input.includeSensitive }),
    });

    const needle = input.text?.trim().toLocaleLowerCase('en');
    const companionCandidates = (input.includeWrites === true ? companionActions : companionReadActions)
      .filter((action) => companionCapability.allowed.has(action.id))
      .filter((action) => site.toolsets.has(action.toolset))
      .filter((action) => input.domain === undefined || action.domain === input.domain)
      .filter((action) => needle === undefined || needle.length === 0 ||
        `${action.id} ${action.title} ${action.description} ${action.domain}`.toLocaleLowerCase('en').includes(needle));
    const actions: (JoomlaActionDescriptor | CompanionActionDescriptor)[] = apiActions.filter(
      (action) => this.availableTransports(
        site,
        action.id,
        action.risk === 'read' || action.risk === 'sensitive-read',
        companionCapability.allowed,
      ).length > 0,
    );
    const known = new Set(actions.map((action) => action.id));

    for (const action of companionCandidates) {
      if (!known.has(action.id)) {
        actions.push(action);
        known.add(action.id);
      }
    }

    return {
      site: site.id,
      count: actions.length,
      actions: actions.map((action) => ({
        id: action.id,
        title: action.title,
        description: action.description,
        domain: action.domain,
        operation: 'operation' in action ? action.operation : (action.risk === 'read' ? 'read' : 'execute'),
        toolset: action.toolset,
        risk: action.risk,
        inputSchema: action.inputSchema,
        availableTransports: this.availableTransports(
          site,
          action.id,
          'operation' in action ? action.risk === 'read' || action.risk === 'sensitive-read' : action.risk === 'read',
          companionCapability.allowed,
        ),
        ...('versions' in action ? { versions: action.versions } : { native: action.native }),
      })),
      companionCapability: companionCapability.status,
    };
  }

  public async describeAction(actionId: string, siteId?: string): Promise<Record<string, unknown>> {
    const apiAction = getJoomlaAction(actionId);
    const companionAction = getCompanionReadAction(actionId) ?? getCompanionWriteAction(actionId);

    if (apiAction === undefined && companionAction === undefined) {
      throw new Error(`Unknown Joomla action: ${actionId}.`);
    }

    const action = apiAction ?? companionAction!;
    const site = this.site(siteId, action.toolset);
    const companionCapability = await this.effectiveCompanionActions(site);
    const read = apiAction !== undefined
      ? apiAction.risk === 'read' || apiAction.risk === 'sensitive-read'
      : companionAction!.risk === 'read';
    const availableTransports = this.availableTransports(site, actionId, read, companionCapability.allowed);
    const blockedReason = sourceOnlyGateReason(actionId)
      ?? (
        availableTransports.length === 0
          ? 'The selected site does not configure a transport that implements this action.'
          : null
      );

    return {
      site: site.id,
      action: {
        ...(apiAction ?? {}),
        ...(companionAction === undefined ? {} : { companionNative: companionAction.native }),
      },
      availability: {
        executable: availableTransports.length > 0,
        transports: availableTransports,
        blockedReason,
        companionCapability: companionCapability.status,
      },
      coverage: actionCoverage(actionId),
    };
  }

  public async executeReadAction(input: {
    readonly site?: string | undefined;
    readonly action: string;
    readonly input?: Readonly<Record<string, unknown>> | undefined;
    readonly transport?: 'auto' | 'api' | 'cli' | undefined;
  }): Promise<JoomlaApiResponse | CompanionEnvelope | Record<string, unknown>> {
    const action = getJoomlaReadAction(input.action);
    const companionAction = getCompanionReadAction(input.action);

    if (action === undefined && companionAction === undefined) {
      throw new Error(`Unknown Joomla read action: ${input.action}.`);
    }

    const site = this.sites.get(input.site);
    this.sites.requireToolset(site, action?.toolset ?? companionAction!.toolset);
    const gateReason = sourceOnlyGateReason(input.action);
    if (gateReason !== undefined) {
      throw new Error(`Joomla action ${input.action} is source-catalogued but not executable: ${gateReason}`);
    }

    if (action === undefined) {
      if (input.transport === 'api') {
        throw new Error(`Joomla action ${companionAction!.id} is available only through the local companion transport.`);
      }
      if (site.cli === undefined) {
        throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
      }
      const normalized = normalizeCompanionReadInput(companionAction!.id, input.input ?? {});
      await this.requireCompanionAction(site.cli, companionAction!.id);

      try {
        const response = await this.cli.dispatch(site.cli, companionAction!.id, normalized);
        await this.audit?.write({
          timestamp: new Date().toISOString(), event: 'action.read', site: site.id,
          action: companionAction!.id, transport: 'cli', outcome: 'success',
        });
        return response;
      } catch (error) {
        await this.audit?.write({
          timestamp: new Date().toISOString(), event: 'action.read_failed', site: site.id,
          action: companionAction!.id, transport: 'cli', outcome: 'failure',
          detail: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
        });
        throw error;
      }
    }

    const transport = this.selectTransport(site, input.transport ?? 'auto');

    try {
      if (transport === 'cli') {
        if (!supportsCompanionReadAction(action.id)) {
          throw new Error(`Joomla action ${action.id} has no fixed companion implementation.`);
        }
        if (site.cli === undefined) {
          throw new Error(`Joomla site ${site.id} does not configure the CLI adapter.`);
        }

        await this.requireCompanionAction(site.cli, action.id);
        const response = await this.cli.dispatch(site.cli, action.id, input.input ?? {});
        await this.audit?.write({
          timestamp: new Date().toISOString(), event: 'action.read', site: site.id, action: action.id,
          transport, outcome: 'success',
        });
        return response;
      }

      const api = this.requireApi(site.id);
      const request = resolveJoomlaReadRequest(action.id, input.input ?? {}, api.maxPageSize);
      const response = await this.api.request(api, {
        ...request,
        authentication: action.driver.authentication,
      });

      await this.audit?.write({
        timestamp: new Date().toISOString(), event: 'action.read', site: site.id, action: action.id,
        transport, outcome: 'success',
      });

      if (action.id === 'configuration.application.get') {
        return {
          status: response.status,
          headers: response.headers,
          data: selectSafeConfiguration(response.data),
        };
      }

      return response;
    } catch (error) {
      await this.audit?.write({
        timestamp: new Date().toISOString(), event: 'action.read_failed', site: site.id, action: action.id,
        transport, outcome: 'failure', detail: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
      });
      throw error;
    }
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

  private availableTransports(
    site: ReturnType<SiteRegistry['get']>,
    actionId: string,
    read: boolean,
    companionAllowed?: ReadonlySet<string>,
  ): readonly ('api' | 'cli')[] {
    if (sourceOnlyGateReason(actionId) !== undefined) {
      return Object.freeze([]);
    }

    const transports: ('api' | 'cli')[] = [];
    if (site.api !== undefined && getJoomlaAction(actionId) !== undefined) {
      transports.push('api');
    }
    const companionSupported = read
      ? supportsCompanionReadAction(actionId)
      : supportsCompanionWriteAction(actionId);
    if (site.cli !== undefined && companionSupported && (companionAllowed === undefined || companionAllowed.has(actionId))) {
      transports.push('cli');
    }
    return Object.freeze(transports);
  }

  private async effectiveCompanionActions(
    site: ReturnType<SiteRegistry['get']>,
  ): Promise<{ readonly allowed: ReadonlySet<string>; readonly status: 'not-configured' | 'available' | 'unavailable' }> {
    if (site.cli === undefined) {
      return { allowed: new Set(), status: 'not-configured' };
    }

    try {
      const capability = await this.cli.describe(site.cli);
      const data = asRecord(capability.data);
      const actions = Array.isArray(data['actions']) ? data['actions'].map(asRecord) : [];
      const allowed = new Set(
        actions
          .filter((action) => typeof action['name'] === 'string' && asRecord(action['effective'])['allowed'] === true)
          .map((action) => action['name'] as string),
      );
      return { allowed, status: 'available' };
    } catch {
      return { allowed: new Set(), status: 'unavailable' };
    }
  }

  private async requireCompanionAction(
    cli: NonNullable<ReturnType<SiteRegistry['get']>['cli']>,
    actionId: string,
  ): Promise<void> {
    const capability = await this.cli.describe(cli);
    const data = asRecord(capability.data);
    const actions = Array.isArray(data['actions']) ? data['actions'] : [];
    const descriptor = actions
      .map(asRecord)
      .find((candidate) => candidate['name'] === actionId);

    if (descriptor === undefined) {
      throw new Error(`Joomla companion does not advertise action ${actionId}.`);
    }

    if (asRecord(descriptor['effective'])['allowed'] !== true) {
      throw new Error(`Joomla companion denies action ${actionId} for its configured actor.`);
    }
  }

  private site(id: string | undefined, toolset: Toolset) {
    const site = this.sites.get(id);
    this.sites.requireToolset(site, toolset);
    return site;
  }

  private requireApi(siteId: string) {
    const site = this.sites.get(siteId);

    if (site.api === undefined) {
      throw new Error(`Joomla site ${site.id} does not configure the API adapter.`);
    }

    return site.api;
  }
}

function actionCoverage(actionId: string): Record<string, unknown> {
  const read = getJoomlaReadAction(actionId);
  const write = getJoomlaWriteAction(actionId);
  let inputContract: string;

  if (read !== undefined) {
    inputContract = crudReadActionIds.has(actionId) && read.operation === 'list'
      ? 'route-typed; bounded pagination; resource filters incomplete'
      : 'route-typed';
  } else if (write !== undefined && crudWriteActionIds.has(actionId)) {
    inputContract = 'reviewed field allowlist; value validation delegated to Joomla form/model';
  } else if (
    write !== undefined &&
    (
      write.bodyPolicy === 'none' ||
      (
        typeof write.inputSchema.properties['data']?.['properties'] === 'object' &&
        write.inputSchema.properties['data']?.['additionalProperties'] === false
      )
    )
  ) {
    inputContract = 'exact';
  } else if (
    write !== undefined &&
    typeof write.inputSchema.properties['data']?.['properties'] === 'object'
  ) {
    inputContract = 'typed core fields plus runtime Joomla form/plugin fields';
  } else if (write !== undefined) {
    inputContract = 'bounded generic body; exact special-route schema pending';
  } else {
    inputContract = 'companion schema';
  }

  const postcondition = write === undefined
    ? 'not-applicable'
    : crudWriteActionIds.has(actionId) && write.operation !== 'delete'
      ? 'resource readback; requested-field comparison pending'
      : 'action-specific verification pending';

  return {
    sourceBacked: true,
    catalogued: true,
    inputContract,
    postcondition,
    liveSuccessVerified: false,
    leastPrivilegeDenialVerified: false,
    recoveryVerified: false,
  };
}

function add(
  query: Record<string, string | number | boolean>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) {
    query[key] = value;
  }
}

const safeConfigurationKeys = new Set([
  'sitename',
  'offline',
  'offline_message',
  'display_offline_message',
  'debug',
  'error_reporting',
  'force_ssl',
  'sef',
  'sef_rewrite',
  'sef_suffix',
  'unicodeslugs',
  'feed_limit',
  'feed_email',
  'lifetime',
  'session_handler',
  'offset',
  'mailonline',
  'mailfrom',
  'fromname',
  'gzip',
  'list_limit',
]);

export function selectSafeConfiguration(data: unknown): Record<string, unknown> {
  const record = asRecord(data);
  const candidate = asRecord(record.attributes ?? asRecord(record.data).attributes ?? record.data ?? record);
  const selected: Record<string, unknown> = {};

  for (const key of safeConfigurationKeys) {
    if (Object.hasOwn(candidate, key)) {
      selected[key] = candidate[key];
    }
  }

  return selected;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
