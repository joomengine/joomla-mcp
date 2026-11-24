import type { SiteConfig, Toolset } from '../config/schema.js';
import type { JoomlaApiTransport } from '../infrastructure/api/joomla-api-client.js';
import { describeJcbApiAction, getJcbApiAction, jcbApiActions, type JcbApiAction } from './catalog.js';
import { probeJcbApiResource } from './api.js';
import { isJcbCommandId, listJcbCommands } from './commands.js';

interface Search {
  readonly text?: string | undefined;
  readonly domain?: string | undefined;
  readonly includeWrites?: boolean | undefined;
}

export function jcbToolset(id: string): Toolset | undefined {
  return getJcbApiAction(id)?.toolset ?? (isJcbCommandId(id) ? 'jcb.execute' : undefined);
}

interface Probe {
  readonly result: Promise<boolean>;
  readonly expires: number;
}

/** Cache availability per configured downstream identity. Tool calls still use Joomla ACL on each request. */
export class JcbDiscovery {
  private readonly probes = new WeakMap<SiteConfig, Map<string, Probe>>();

  public constructor(private readonly api: JoomlaApiTransport) {}

  public async search(
    site: SiteConfig,
    input: Search,
    companion: unknown,
    permitted: (toolset: Toolset) => boolean,
  ): Promise<readonly Record<string, unknown>[]> {
    if (input.domain !== undefined && input.domain !== 'jcb') return [];
    const text = input.text?.trim().toLowerCase() ?? '';
    const visible = (toolset: Toolset) => site.toolsets.has(toolset) && permitted(toolset);
    const actions: Record<string, unknown>[] = [];
    if (site.api && visible('jcb.read')) {
      const candidates = jcbApiActions.filter(action =>
        !(action.operation === 'create' && action.sourceCreateDisabled) &&
        (action.toolset === 'jcb.read' || (input.includeWrites && visible('jcb.write'))) &&
        (action.id.includes(text) || action.path.includes(text)));
      const resources = [...new Map(candidates.map(action => [action.resource, action])).values()];
      const available = new Set<string>();
      // Avoid opening one connection per resource on a newly connected Joomla site.
      let next = 0;
      const probe = async () => {
        while (next < resources.length) {
          const action = resources[next++]!;
          if (await this.available(site, action)) available.add(action.resource);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, resources.length) }, probe));
      for (const action of candidates) {
        if (available.has(action.resource)) {
          actions.push({ id: action.id, domain: 'jcb', operation: action.operation,
            toolset: action.toolset, method: action.method, route: action.path, availableTransports: ['api'] });
        }
      }
    }
    if (input.includeWrites && site.cli?.jcbJobDirectory && visible('jcb.execute')) {
      for (const command of listJcbCommands(companion)) {
        if ((command.id + ' ' + command.title + ' ' + command.description).toLowerCase().includes(text)) {
          actions.push({ id: command.id, title: command.title, domain: 'jcb', operation: 'execute',
            toolset: command.toolset, risk: command.risk, availableTransports: ['cli'] });
        }
      }
    }
    return actions;
  }

  public async describe(site: SiteConfig, id: string, companion: unknown): Promise<Record<string, unknown>> {
    const action = getJcbApiAction(id);
    const command = !action && site.cli?.jcbJobDirectory
      ? listJcbCommands(companion).find(item => item.id === id)
      : undefined;
    if (!action && !command) throw new Error('The requested JCB command is unavailable on this site.');
    const createBlocked = action?.operation === 'create' && action.sourceCreateDisabled;
    const available = action
      ? !createBlocked && site.toolsets.has('jcb.read') && await this.available(site, action)
      : true;
    return {
      site: site.id,
      action: action ? describeJcbApiAction(action) : command,
      availability: {
        executable: available,
        transports: available ? [action ? 'api' : 'cli'] : [],
        blockedReason: available ? null : createBlocked
          ? 'The reviewed JCB translation form disables its required source on create.'
          : 'The configured Joomla identity could not read the JCB resource collection.',
        evidence: action
          ? 'Route and form from the supported JCB release. Collection access is checked with the site token. Joomla enforces the requested item and mutation ACL at execution.'
          : 'The installed JCB command and actor permissions were checked by the local companion.',
      },
    };
  }

  private available(site: SiteConfig, action: JcbApiAction): Promise<boolean> {
    if (!site.api) return Promise.resolve(false);
    let cache = this.probes.get(site);
    if (!cache) {
      cache = new Map();
      this.probes.set(site, cache);
    }
    const now = Date.now();
    const cached = cache.get(action.resource);
    if (cached && cached.expires > now) return cached.result;
    const result = probeJcbApiResource(this.api, site.api, action).catch(() => false);
    cache.set(action.resource, { result, expires: now + 60_000 });
    return result;
  }
}
