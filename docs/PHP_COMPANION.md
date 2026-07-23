# Joomla PHP companion

`pkg_joomlamcp` is an installable Joomla 6.1+ console package for the local MCP
path. It does not implement MCP transport. It adapts fixed semantic actions to
Joomla's native console runtime, dependency-injection container, actor ACL,
services, and administrator models.

Joomla remains the implementation authority. The companion does not recreate
Joomla validation, persistence, events, state transitions, extension discovery,
scheduling, sessions, or configuration behavior.

## Build and install

PHP 8.3 or newer and the PHP `zip` extension are required:

```bash
php companion/tests/run.php
php companion/build.php
```

The build produces `companion/dist/pkg_joomlamcp-0.5.0.zip`. Install or upgrade
it through Joomla's native extension installer. First installation enables the
console plugin through Joomla's extension table lifecycle; upgrades preserve
the operator's enabled/disabled state. Then:

1. verify **Console - JoomEngine MCP for Joomla Companion** is enabled;
2. select a dedicated least-privilege Joomla user under **MCP actor user**;
3. run the verification command from the Joomla root as the dedicated
   deployment account:

```bash
php cli/joomla.php joomla:mcp:describe --format=json --no-interaction --no-ansi
php cli/joomla.php joomla:mcp:self-test --format=json --no-interaction --no-ansi
php cli/joomla.php joomla:mcp:cli-inventory --format=json --no-interaction --no-ansi
```

Leaving the actor unset fails closed: actions with Joomla ACL requirements are
described as unavailable and dispatch returns `ACCESS_DENIED`. Do not select a
human Super User as a shortcut.

## Native command contract

The package registers only:

```text
joomla:mcp:describe --format=json --no-interaction --no-ansi
joomla:mcp:dispatch --input=- --format=json --no-interaction --no-ansi
joomla:mcp:self-test --format=json --no-interaction --no-ansi
joomla:mcp:cli-inventory --format=json --no-interaction --no-ansi
```

`joomla:mcp:self-test` accepts no action or payload. It checks that the plugin
is active, the reviewed catalogue is available, and the fixed read-only
`system.info` action dispatches successfully. Any failed check returns nonzero
with a bounded generic error.

`joomla:mcp:cli-inventory` returns the installed Joomla command registry as
bounded JSON, including definitions for arguments and options. It reads
`ConsoleApplication::getAllCommands()` and does not execute any discovered
command. The TypeScript edge exposes this through `joomla_cli_inventory` under
the `cli.discovery` toolset.

The TypeScript edge starts the configured PHP executable and fixed
`<joomla-root>/cli/joomla.php` with an argument array and no shell. Requests use
stdin so content and secrets never appear in process arguments.

One-shot read request:

```bash
printf '%s' '{"protocol":"joomla-mcp/1","id":"smoke-1","action":"system.info","input":{}}' \
  | php cli/joomla.php joomla:mcp:dispatch --input=- --format=json --no-interaction --no-ansi
```

Success envelope:

```json
{
  "protocol": "joomla-mcp/1",
  "id": "smoke-1",
  "ok": true,
  "result": {
    "joomlaVersion": "6.1.0",
    "phpVersion": "8.3.0"
  }
}
```

Error envelope:

```json
{
  "protocol": "joomla-mcp/1",
  "id": "smoke-2",
  "ok": false,
  "error": {
    "code": "UNKNOWN_ACTION",
    "message": "Action is not registered."
  }
}
```

NDJSON mode consumes and emits one object per line, accepts at most 1,000
requests per process, and caps each request at 1 MiB. The edge normally uses one
isolated process per MCP operation with its own stricter time and output limits.

## Capability description

`joomla:mcp:describe` returns protocol/package version, action IDs, schemas,
risk, supported Joomla range, declared ACL, and effective permission for the
configured actor. Refresh it after package installation/upgrade, Joomla upgrade,
actor ACL changes, or plugin configuration changes.

The companion 0.5.0 allowlist contains 231 actions:

- 180 list/get/create/update/delete actions for the 36 fixed core entity bases;
- 28 model-state actions where the fixed Joomla model supports state changes;
- 23 supplemental/alias actions for system/safe configuration, extensions,
  cache, scheduler, site state, sessions, and core-update status.

Every entity definition fixes its component, model, context, fields, ACL, and
supported operations. There is no caller-selected command, component, model,
method, path, URL, shell, PHP, SQL, or filesystem primitive.

## Native operational actions

Companion 0.5.0 includes these fixed Joomla-native adapters:

| Action | Native Joomla capability |
|---|---|
| `cache.expired.purge` | Cache model `purge()` |
| `extensions.discovered.refresh` | Installer Discover model `discover()` |
| `extensions.updates.refresh` | Installer Update model `purge()` and `findUpdates()` |
| `extensions.update-sites.list` | Installer Update Sites model `getItems()` |
| `extensions.update-sites.state.set` | Installer Update Sites model `publish()` |
| `extensions.state.set` | Installer Manage model `publish()` |
| `scheduler.tasks.state.set` | Native single-task `scheduler:state` behavior |
| `scheduler.tasks.run` | Native single-task `scheduler:run --id` behavior |
| `site.state.get`, `site.state.set` | Joomla configuration with native site up/down behavior |
| `sessions.data.gc` | Native `session:gc`, restricted to site/administrator clients |
| `sessions.metadata.gc` | Native `session:metadata:gc` |

These are not generic Joomla command wrappers. Inputs are typed and bounded;
extension identifiers, update-site identifiers, task identifiers, state,
session client, and other choices are validated. High-risk results include
pre/post state, verification, and recovery metadata where Joomla provides a
reliable read-back.

The four new reversible setters (installed extension, update site, scheduled
task, and site availability) and all 28 generated core model-state actions mark
`applied: true` only after the native operation succeeds and a fresh read-back
matches the requested state. A mismatch fails with `POSTCONDITION_FAILED`.

The twelve actions above are described by the TypeScript edge and execute
through generic read or guarded plan/apply with matching schemas, toolsets,
scopes, and audit. They remain gated until their live Joomla allowed/denied,
postcondition, interruption, rollback, and recovery tests pass. See
[Coverage](COVERAGE.md).

## Writes and recovery

Companion writes preview by default. Execution requires both `dryRun: false`
and the edge-internal `_edgeConfirmed: true` marker after a successful MCP
plan/apply confirmation. The companion trusts that local marker and does not
verify the edge HMAC. Anyone who can invoke Joomla CLI as the deployment account
is inside a trusted administrative boundary and could construct a confirmed
request. Restrict operating-system/CLI access; production MCP writes must go
through the edge plan/apply flow.

The companion delegates the actual change to Joomla, then returns structured
application/verification evidence. Before state, update, scheduler, site,
session, cache, user, extension, configuration, or destructive operations,
retain the Joomla backup and action-specific recovery procedure. An interrupted
operation has uncertain outcome until the native Joomla state is read back.

## Edge site configuration

A local site entry fixes:

- Joomla root;
- PHP executable;
- allowed toolsets;
- process timeout;
- maximum output bytes.

The effective invocation is always:

```text
<php> <joomla-root>/cli/joomla.php joomla:mcp:dispatch --input=- --format=json --no-interaction --no-ansi
```

Tool calls cannot replace those paths or supply process environment. Run the
edge/companion under a dedicated operating-system account, never root. The
standard OCI edge contains neither PHP nor Joomla and is API-only. Use the host
systemd/bare deployment for native local actions and grant only the filesystem
access described in [Deployment](DEPLOYMENT.md).

## Upgrade and rollback

Before upgrade, retain the previous companion ZIP and a tested Joomla
filesystem/database backup. Validate the new package on matching disposable
fixtures, install it with Joomla's extension installer, and compare the complete
description and actor permissions before re-enabling writes.

To roll back code, reinstall the retained previous ZIP through Joomla's native
installer and verify its description. Rolling back package files does not undo
Joomla state changes made by an action; apply the recorded native recovery
input or restore the tested Joomla backup.

## Tests and remaining evidence

`php companion/tests/run.php` is dependency-free. It checks protocol framing,
strict envelopes, duplicate/unknown action rejection, pre-execution ACL denial,
fixed counts/schemas, field filtering, preview/confirmation, manifests,
native-adapter mappings, and the absence of generic command/caller-selected
execution primitives. The current suite has 23 checks and the package build is
validated in CI.

These are offline boundary checks. Native models and operational actions still
require installation, allowed/denied actor, mutation, postcondition, cleanup,
upgrade, rollback, and recovery tests on live Joomla 6.1 and 6.2 fixtures across
supported databases before production approval.
