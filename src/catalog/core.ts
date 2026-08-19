import type { Toolset } from '../config/schema.js';
import { joomlaActions, joomlaReadActions, joomlaWriteActions } from './action-catalog.js';
import { companionActions, companionReadActions, companionWriteActions } from './companion-actions.js';
import { joomlaCliCommandTargets } from './cli-command-targets.js';
import { sourceOnlyActionGates } from './action-gates.js';
import { getActionCatalogOverlay } from './spec/overlay.js';
import { specCatalogProvenance } from './spec/index.js';

export const supportedJoomlaBranches = {
  baseline: '6.1-dev',
  compatibility: '6.2-dev',
  canary: '7.0-dev',
} as const;

export const cliCommands: readonly string[] = Object.freeze(
  joomlaCliCommandTargets.map((target) => target.command),
);

export const apiCrudBases = [
  'v1/content/articles',
  'v1/content/categories',
  'v1/banners',
  'v1/banners/clients',
  'v1/banners/categories',
  'v1/contacts',
  'v1/contacts/categories',
  'v1/menus/site',
  'v1/menus/administrator',
  'v1/menus/site/items',
  'v1/menus/administrator/items',
  'v1/modules/site',
  'v1/modules/administrator',
  'v1/users',
  'v1/users/groups',
  'v1/users/levels',
  'v1/tags',
  'v1/templates/styles/site',
  'v1/templates/styles/administrator',
  'v1/languages/content',
  'v1/messages',
  'v1/newsfeeds/feeds',
  'v1/newsfeeds/categories',
  'v1/redirects',
  'v1/fields/content/articles',
  'v1/fields/content/categories',
  'v1/fields/groups/content/articles',
  'v1/fields/groups/content/categories',
  'v1/fields/contacts/contact',
  'v1/fields/contacts/mail',
  'v1/fields/contacts/categories',
  'v1/fields/groups/contacts/contact',
  'v1/fields/groups/contacts/mail',
  'v1/fields/groups/contacts/categories',
  'v1/fields/users',
  'v1/fields/groups/users',
] as const;

export interface ImplementedAction {
  readonly tool: string;
  readonly driver: 'api' | 'cli_process' | 'api_or_cli';
  readonly toolset: Toolset;
  readonly risk: 'read' | 'write' | 'destructive';
}

export const implementedActions: readonly ImplementedAction[] = [
  { tool: 'joomla_sites_list', driver: 'api', toolset: 'discovery', risk: 'read' },
  { tool: 'joomla_capabilities', driver: 'api', toolset: 'discovery', risk: 'read' },
  { tool: 'joomla_actions_search', driver: 'api', toolset: 'discovery', risk: 'read' },
  { tool: 'joomla_action_describe', driver: 'api_or_cli', toolset: 'discovery', risk: 'read' },
  { tool: 'joomla_action_read', driver: 'api_or_cli', toolset: 'discovery', risk: 'write' },
  { tool: 'joomla_action_write_plan', driver: 'api_or_cli', toolset: 'discovery', risk: 'write' },
  { tool: 'joomla_content_articles_list', driver: 'api', toolset: 'content.read', risk: 'read' },
  { tool: 'joomla_content_article_get', driver: 'api', toolset: 'content.read', risk: 'read' },
  { tool: 'joomla_extensions_list', driver: 'api', toolset: 'extensions.read', risk: 'read' },
  { tool: 'joomla_application_config_get_safe', driver: 'api', toolset: 'configuration.read', risk: 'read' },
  { tool: 'joomla_cli_commands_list', driver: 'cli_process', toolset: 'cli.discovery', risk: 'read' },
  { tool: 'joomla_cli_command_help', driver: 'cli_process', toolset: 'cli.discovery', risk: 'read' },
  { tool: 'joomla_cli_targets', driver: 'cli_process', toolset: 'cli.discovery', risk: 'read' },
  { tool: 'joomla_cli_inventory', driver: 'cli_process', toolset: 'cli.discovery', risk: 'read' },
  { tool: 'joomla_companion_capabilities', driver: 'cli_process', toolset: 'cli.discovery', risk: 'read' },
  { tool: 'joomla_companion_action_read', driver: 'cli_process', toolset: 'discovery', risk: 'read' },
  { tool: 'joomla_content_article_create_plan', driver: 'api', toolset: 'content.write', risk: 'write' },
  { tool: 'joomla_content_article_update_plan', driver: 'api', toolset: 'content.write', risk: 'write' },
  { tool: 'joomla_content_article_delete_plan', driver: 'api', toolset: 'content.write', risk: 'destructive' },
  { tool: 'joomla_write_apply', driver: 'api_or_cli', toolset: 'content.write', risk: 'destructive' },
];

export function publicCatalog(): Record<string, unknown> {
  const overlay = getActionCatalogOverlay();
  const reads = overlay?.readActions ?? joomlaReadActions;
  const writes = overlay?.writeActions ?? joomlaWriteActions;
  const actions = overlay?.actions ?? joomlaActions;
  const gates = overlay?.sourceOnlyGates ?? sourceOnlyActionGates;

  return {
    joomla: supportedJoomlaBranches,
    spec: specCatalogProvenance(),
    api: {
      crudCollections: apiCrudBases.length,
      crudRoutes: apiCrudBases.length * 5,
      bases: apiCrudBases,
      semanticReadActions: reads.length,
      semanticWriteActions: writes.length,
      semanticActions: actions.length,
      sourceRouteTemplates: 236,
      cataloguedRouteTemplates: actions.length,
      sourceOnlyBlockedActions: gates,
      readActions: reads,
      writeActions: writes,
      mutationContracts: {
        crudFieldAllowlisted: 108,
        specialExactBodyOrNoBody: 22,
        specialRuntimeDynamicBody: 1,
        specialSourceGatedGenericBody: 4,
      },
      selfDescribing: overlay?.provenance.consumed === true,
    },
    cli: {
      installedSiteCommands: cliCommands.length,
      commands: cliCommands,
      targets: joomlaCliCommandTargets,
      targetStatus: {
        implemented: joomlaCliCommandTargets.filter((target) => target.status === 'implemented').length,
        partial: joomlaCliCommandTargets.filter((target) => target.status === 'partial').length,
        gated: joomlaCliCommandTargets.filter((target) => target.status === 'gated').length,
      },
      structuredOutput: false,
      companion: {
        semanticReadActions: companionReadActions.length,
        semanticWriteActions: companionWriteActions.length,
        semanticActions: companionActions.length,
        actions: companionActions,
        nativeAdapterOnly: true,
      },
    },
    implementedActions,
  };
}
