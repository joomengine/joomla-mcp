export type JoomlaCliTargetStatus = 'implemented' | 'partial' | 'gated';
export type JoomlaCliTargetRisk = 'discovery' | 'read' | 'write' | 'high' | 'destructive';

export interface JoomlaCliCommandTarget {
  readonly command: string;
  readonly owner: 'joomla-core';
  readonly risk: JoomlaCliTargetRisk;
  readonly status: JoomlaCliTargetStatus;
  readonly semanticActions: readonly string[];
  readonly note: string;
}

const target = (
  command: string,
  risk: JoomlaCliTargetRisk,
  status: JoomlaCliTargetStatus,
  semanticActions: readonly string[],
  note: string,
): JoomlaCliCommandTarget => Object.freeze({
  command,
  owner: 'joomla-core' as const,
  risk,
  status,
  semanticActions: Object.freeze([...semanticActions]),
  note,
});

/**
 * Reviewed mapping for the 38 commands installed by stock Joomla 6.1.
 *
 * `implemented` means a fixed semantic action reaches the native behavior.
 * `partial` means only a deliberately bounded subset is exposed. `gated`
 * commands remain non-executable until their recovery contract is certified.
 */
export const joomlaCliCommandTargets: readonly JoomlaCliCommandTarget[] = Object.freeze([
  target('help', 'discovery', 'implemented', ['joomla_cli_command_help'], 'Fixed native help; the selected command is not executed.'),
  target('list', 'discovery', 'implemented', ['joomla_cli_commands_list', 'joomla_cli_inventory'], 'Bounded human and structured command discovery.'),
  target('cache:clean', 'write', 'implemented', ['cache.clean', 'cache.expired.purge'], 'Explicit cache groups or expired entries only.'),
  target('config:get', 'read', 'partial', ['configuration.get_safe', 'configuration.application.get'], 'Only the non-secret configuration allowlist is returned.'),
  target('config:set', 'high', 'partial', ['site.state.set'], 'Only the verified online/offline state transition is exposed.'),
  target('core:autoupdate:register', 'high', 'gated', [], 'External registration and credential lifecycle are not yet certified.'),
  target('core:autoupdate:unregister', 'high', 'gated', [], 'External registration recovery is not yet certified.'),
  target('core:update', 'destructive', 'gated', [], 'Core update execution requires snapshot, rollback, and interruption certification.'),
  target('core:update:channel', 'high', 'gated', [], 'Channel and custom URL rollback are not yet certified.'),
  target('core:update:check', 'write', 'partial', ['core.update.status'], 'Cached status is available; active network refresh is not yet certified.'),
  target('database:export', 'high', 'gated', [], 'Artifact destination, credentials, size, and retention need a fixed contract.'),
  target('database:import', 'destructive', 'gated', [], 'Restore source, atomicity, and rollback need a fixed contract.'),
  target('extension:disable', 'high', 'implemented', ['extensions.state.set'], 'One numeric installed-extension ID with read-back.'),
  target('extension:discover', 'write', 'implemented', ['extensions.discovered.refresh'], 'Joomla Discover model with bounded result verification.'),
  target('extension:discover:install', 'high', 'gated', [], 'Install rollback and package provenance are not yet certified.'),
  target('extension:discover:list', 'read', 'implemented', ['extensions.discovered.list'], 'Bounded discovered-extension metadata.'),
  target('extension:enable', 'high', 'implemented', ['extensions.state.set'], 'One numeric installed-extension ID with read-back.'),
  target('extension:install', 'destructive', 'gated', [], 'Only operator-approved packages may be admitted after provenance and rollback gates.'),
  target('extension:list', 'read', 'implemented', ['extensions.list', 'extensions.installed.list'], 'Bounded installed-extension metadata.'),
  target('extension:remove', 'destructive', 'gated', [], 'Package, data, dependency, and rollback behavior are not yet certified.'),
  target('finder:index', 'high', 'gated', [], 'Index rebuild load, timeout, interruption, and recovery are not yet certified.'),
  target('maintenance:database', 'destructive', 'gated', [], 'Schema repair requires backup, dry-run, and recovery certification.'),
  target('scheduler:list', 'read', 'implemented', ['scheduler.tasks.list'], 'Bounded scheduler task metadata.'),
  target('scheduler:run', 'high', 'implemented', ['scheduler.tasks.run'], 'One explicit positive task ID; run-all is prohibited.'),
  target('scheduler:state', 'high', 'implemented', ['scheduler.tasks.state.set'], 'One explicit task ID and fixed state with read-back.'),
  target('session:gc', 'high', 'implemented', ['sessions.data.gc'], 'Site or administrator expired-session collection only.'),
  target('session:metadata:gc', 'high', 'implemented', ['sessions.metadata.gc'], 'Expired session metadata only.'),
  target('site:create-public-folder', 'destructive', 'gated', [], 'Caller-selected filesystem paths are prohibited pending an operator-owned path contract.'),
  target('site:down', 'high', 'implemented', ['site.state.set'], 'Verified offline state with a recovery transition.'),
  target('site:up', 'high', 'implemented', ['site.state.set'], 'Verified online state with a recovery transition.'),
  target('update:extensions:check', 'write', 'implemented', ['extensions.updates.refresh'], 'Refreshes stable extension update metadata.'),
  target('update:joomla:remove-old-files', 'destructive', 'gated', [], 'Deletion remains gated; native dry-run certification is the next step.'),
  target('user:add', 'high', 'implemented', ['users.users.create'], 'Joomla User model create with explicit fields and ACL.'),
  target('user:addtogroup', 'high', 'partial', ['users.users.update'], 'Group-set updates exist; command-specific add-only semantics need live certification.'),
  target('user:delete', 'destructive', 'implemented', ['users.users.delete'], 'Permanent Joomla User model delete through guarded plan/apply.'),
  target('user:list', 'read', 'implemented', ['users.users.list'], 'Bounded Joomla user metadata subject to ACL.'),
  target('user:removefromgroup', 'high', 'partial', ['users.users.update'], 'Group-set updates exist; command-specific remove-only semantics need live certification.'),
  target('user:reset-password', 'high', 'partial', ['users.users.update'], 'Write-only password fields exist; command-specific secret/recovery certification remains.'),
]);

const targetByCommand = new Map(joomlaCliCommandTargets.map((entry) => [entry.command, entry]));

export function getJoomlaCliCommandTarget(command: string): JoomlaCliCommandTarget | undefined {
  return targetByCommand.get(command);
}
