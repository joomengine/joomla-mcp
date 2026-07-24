# JoomEngine MCP for Joomla companion

This directory builds `pkg_joomlamcp`, an installable Joomla package containing
the `console/joomlamcp` plugin. It requires Joomla 6.1 or later and PHP 8.3 or
later.

The plugin adds four Joomla console commands:

```text
--quiet joomla:mcp:describe --format=json
--quiet joomla:mcp:dispatch --input=- --format=json
--quiet joomla:mcp:self-test --format=json
--quiet joomla:mcp:cli-inventory --format=json
```

`self-test` is a fixed, read-only installation probe. It verifies the reviewed
catalogue and an internal `system.info` dispatch; it accepts no action, command,
path, or payload from the caller.

`cli-inventory` reads Joomla's native installed command registry and returns
bounded command, argument, option, alias, and namespace metadata. It never
executes the commands it discovers and is exposed through the MCP
`joomla_cli_inventory` discovery tool.

The dispatch contract is deliberately smaller than a general Joomla CLI. Only
actions registered in `JoomlaActionRegistryFactory` can execute. There is no
shell, SQL, PHP, filesystem, URL, or Joomla-command passthrough.

The current allowlist contains 231 actions: fixed CRUD operations for all 36
core entity bases, bounded state operations for supported models, and selected
native operational actions. Writes preview by default and require confirmation
from the TypeScript edge before execution. High-risk actions return pre/post
state, verification, and recovery metadata wherever Joomla exposes a reliable
read-back.

The production operations available in companion 0.7.0 are:

| Action | Native Joomla 6.1+ capability |
|---|---|
| `cache.expired.purge` | `CacheModel::purge()` / `cache:clean expired` |
| `extensions.discovered.refresh` | `DiscoverModel::discover()` / `extension:discover` |
| `extensions.updates.refresh` | `UpdateModel::purge()` and `findUpdates()` / `update:extensions:check` |
| `extensions.update-sites.list` | `UpdatesitesModel::getItems()` |
| `extensions.update-sites.state.set` | `UpdatesitesModel::publish()` |
| `extensions.state.set` | `ManageModel::publish()` |
| `scheduler.tasks.state.set` | `scheduler:state` |
| `scheduler.tasks.run` | `scheduler:run --id` |
| `site.state.get`, `site.state.set` | Joomla configuration plus `site:down` / `site:up` |
| `sessions.data.gc` | `session:gc` for `site` or `administrator` only |
| `sessions.metadata.gc` | `session:metadata:gc` |

These are typed adapters, not reimplementations. The action registry fixes every
component, model, method, command, and accepted field. Extension installation or
removal, core updates, database maintenance, arbitrary scheduler batches, and
generic Joomla command execution are not exposed.

See [`docs/COVERAGE.md`](../docs/COVERAGE.md) for the exact MCP connection status
and remaining live-validation gates.

Build and test:

```bash
php companion/tests/run.php
php companion/build.php
```

The package ZIP is written to `companion/dist/`. See
[`docs/PHP_COMPANION.md`](../docs/PHP_COMPANION.md) for installation and protocol examples.

Install or upgrade the generated `pkg_joomlamcp-0.7.0.zip` with Joomla's native
Extensions installer. First installation enables the console plugin through
Joomla's native extension lifecycle; upgrades preserve its current enabled
state. Then confirm that the dedicated MCP actor still has only
the intended ACL permissions. Before upgrading, retain the previous package ZIP
and a normal Joomla backup. To roll back, reinstall the previous package version;
site and extension state changes are separate Joomla state transitions and must
be reversed using the recovery input returned by the action that applied them.
