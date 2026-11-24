# JoomEngine MCP for Joomla companion

Install the companion when the [Node.js MCP server](../README.md) can run PHP
on the Joomla host and needs local Joomla actions or CLI discovery. Sites
connected only through the Joomla Web Services API can skip this package.

This directory builds `pkg_joomlamcp`, an installable Joomla package containing
the `console/joomlamcp` plugin. It requires Joomla 6.1 or later and PHP 8.3 or
later.

## Install and verify

1. When building this source revision for direct JCB jobs, run `php companion/build.php` in the repository root and use the ZIP in `companion/dist/`. For the published 0.8.0 server, get the `pkg_joomlamcp-0.8.0.zip` asset from the [matching server release](https://github.com/joomengine/joomla-mcp/releases/tag/v0.8.0).
2. In Joomla Administrator, open **System → Install → Extensions** and upload
   the ZIP. Open **System → Manage → Plugins**, select **Console - JoomEngine
   MCP for Joomla Companion**, and set **MCP actor user** to the dedicated
   Joomla account whose permissions the server should use. Save and confirm
   the plugin is enabled. A fresh installation enables it automatically.
3. From the Joomla root, run the probe as the operating-system account that
   will run the MCP server. A successful probe returns JSON with `ok: true`.

   ```bash
   php cli/joomla.php joomla:mcp:self-test --format=json --no-interaction --no-ansi
   ```

4. In the server's site configuration, set `cli.root` to the absolute Joomla
   root and `cli.phpBinary` to the absolute PHP executable available to that
   account. Enable the toolsets needed for this site. For example,
   `cli.discovery` exposes the installed command inventory. See the
   [site configuration example](../config/sites.example.json) and the
   [JCB integration walkthrough](../docs/JCB.md).

## Console commands

The plugin registers four Joomla console commands.

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

The Joomla core allowlist contains 231 actions: fixed CRUD operations for all 36
core entity bases, bounded state operations for supported models, and selected
native operational actions. Writes preview by default and require confirmation
from the TypeScript edge before execution. High-risk actions return pre/post
state, verification, and recovery metadata wherever Joomla exposes a reliable
read-back.

For JCB compiler and package jobs, build the companion from the same revision
as the Node server and configure the site's job directory and `jcb.execute`
toolset. The actor needs JCB administration permission. The server resolves
eligible commands from the installed JCB plugin. [JCB jobs](../docs/JCB.md)

Companion 0.8.0 includes the following native operations.

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

## Build from source

Run these commands from the repository root with PHP 8.3 or newer and the PHP
`zip` extension.

```bash
php companion/tests/run.php
php companion/build.php
```

The build writes `companion/dist/pkg_joomlamcp-0.8.0.zip`. Install it through
the same Joomla extension installer. The [companion reference](../docs/PHP_COMPANION.md)
covers the protocol and includes a read-only dispatch example.

## Upgrade and rollback

Keep the previous ZIP and a Joomla backup before upgrading. Upload the new
ZIP through the extension installer. Upgrades preserve the plugin's enabled
state. Recheck the MCP actor's permissions and rerun the probe after upgrading.
To roll back the companion, reinstall the previous ZIP. Undo Joomla state
changes separately using the recovery input returned by the action that applied
them.
