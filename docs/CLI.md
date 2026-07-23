# Joomla CLI integration

Joomla's installed console registry is authoritative for the commands available
on a particular site. Enabled console plugins can add commands, so a static list
alone is insufficient.

Use `joomla_cli_inventory` for bounded structured discovery. It invokes the
companion's `joomla:mcp:cli-inventory` command, which reads Joomla's native
`ConsoleApplication::getAllCommands()` registry and returns command names,
aliases, descriptions, arguments, and options. It does not execute discovered
commands. `joomla_cli_commands_list` remains available for bounded comparison
with Joomla's human-oriented `list` output.

Use `joomla_cli_command_help` to retrieve Joomla's native help for one installed
command. It always invokes the fixed `help` command and passes the validated
canonical command name as one process argument; it never executes the selected
command.

Use `joomla_cli_targets` to join that live metadata to the reviewed MCP target
map. It reports whether each of Joomla's 38 stock commands is implemented,
deliberately partial, or gated, and names the fixed semantic action to use. A
gated entry is documentation, not execution authority.

The fixture retains `cli-list.txt`, `cli-inventory.json`, and bounded native help
for all 153 commands currently installed by its pinned image: 38 Joomla core,
111 Joomla Component Builder, and four companion commands. Commands added by an
extension appear automatically without becoming executable MCP tools.

The reviewed core target map currently classifies 19 commands as implemented,
six as deliberately partial, and 13 as gated. `core:check-updates` is the stock
alias of `core:update:check`. The `database:export` and `database:import`
commands come from Joomla's bundled `joomla/database` console provider rather
than a Joomla CMS console class, but are part of the installed Joomla 6 command
surface and are tracked here.

## Core command mapping

This table covers every default Joomla 6.1 command currently registered by
core. “Implemented” means a typed semantic adapter exists; it does not by itself
mean the action has completed the live mutation and recovery certification
matrix.

| Joomla command | MCP semantic action/tool | Status |
|---|---|---|
| `help` | `joomla_cli_command_help`, `joomla_cli_inventory` | Discovery |
| `list` | `joomla_cli_inventory`, `joomla_cli_commands_list` | Discovery |
| `cache:clean` | `cache.groups.list`, `cache.clean`, `cache.expired.purge` | Implemented; mutation recovery testing pending |
| `config:get` | `configuration.get_safe` | Implemented safe subset; raw secrets prohibited |
| `config:set` | `site.state.set` for offline state | Partial; arbitrary configuration writes gated |
| `site:down` | `site.state.set` with `offline=true` | Implemented; recovery testing pending |
| `site:up` | `site.state.set` with `offline=false` | Implemented; recovery testing pending |
| `site:create-public-folder` | — | Gated; filesystem/recovery contract missing |
| `core:autoupdate:register` | `core.update.status` | Status only; registration gated |
| `core:autoupdate:unregister` | `core.update.status` | Status only; registration gated |
| `core:update` | `core.update.status` | Status only; update execution gated |
| `core:update:check` (`core:check-updates`) | `core.update.status` | Cached status only; native active network refresh gated |
| `core:update:channel` | — | Gated; channel rollback contract missing |
| `update:extensions:check` | `extensions.updates.refresh` | Implemented; recovery testing pending |
| `update:joomla:remove-old-files` | — | Gated; destructive post-update cleanup |
| `extension:list` | `extensions.list` | Implemented |
| `extension:enable` | `extensions.state.set` | Implemented; recovery testing pending |
| `extension:disable` | `extensions.state.set` | Implemented; recovery testing pending |
| `extension:remove` | — | Gated; package/data rollback contract missing |
| `extension:install` | — | Gated; supply-chain and rollback contract missing |
| `extension:discover` | `extensions.discovered.refresh` | Implemented; recovery testing pending |
| `extension:discover:list` | `extensions.discovered.list` | Implemented |
| `extension:discover:install` | — | Gated; install rollback contract missing |
| `user:list` | `users.users.list` | Implemented through Joomla models/API |
| `user:add` | `users.users.create` | Implemented; live ACL/recovery testing pending |
| `user:addtogroup` | `users.users.update` | Partial; command-specific group contract pending |
| `user:removefromgroup` | `users.users.update` | Partial; command-specific group contract pending |
| `user:reset-password` | `users.users.update` | Partial; password/recovery contract gated |
| `user:delete` | `users.users.delete` | Implemented; destructive recovery testing pending |
| `scheduler:list` | `scheduler.tasks.list` | Implemented |
| `scheduler:run` | `scheduler.tasks.run` | Implemented for one fixed task ID; recovery testing pending |
| `scheduler:state` | `scheduler.tasks.state.set` | Implemented; recovery testing pending |
| `finder:index` | — | Gated; load, timeout, and recovery contract missing |
| `maintenance:database` | — | Gated; database mutation/recovery contract missing |
| `session:gc` | `sessions.data.gc` | Implemented for site/administrator; live testing pending |
| `session:metadata:gc` | `sessions.metadata.gc` | Implemented; live testing pending |
| `database:export` | — | Gated; artifact, credential, and size contract missing |
| `database:import` | — | Gated; destructive restore and rollback contract missing |

## Companion commands

| Command | Purpose |
|---|---|
| `joomla:mcp:describe` | Return the versioned semantic action catalogue and effective actor ACL |
| `joomla:mcp:dispatch` | Execute one allowlisted semantic action from JSON stdin |
| `joomla:mcp:self-test` | Verify plugin activation, catalogue integrity, and a fixed `system.info` dispatch |
| `joomla:mcp:cli-inventory` | Describe Joomla's installed command registry without executing commands |

## Integration rule

There is deliberately no generic MCP command executor. Useful Joomla commands
are integrated one at a time as typed semantic actions with a fixed native
target, explicit toolset and ACL, bounded input/output, plan/apply confirmation
for writes, verification, audit, and a recovery contract. Inventory evidence
informs integration work; it never grants execution authority.
