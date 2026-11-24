# MCP tools and use cases

## Read your first articles

After [connecting your MCP client](CLIENTS.md), ask “Use Joomla to list up to
five articles on `company` and show their IDs and titles.” The calls below
use the alias from the [read-only site configuration](../config/sites.single-site-readonly.example.json).
Substitute your configured alias if it differs.

| MCP tool | Arguments | What to look for |
| --- | --- | --- |
| `joomla_sites_list` | `{}` | The configured alias and its API or CLI adapter |
| `joomla_capabilities` | `{"site":"company"}` | `discovery` and `content.read` in the site's toolsets |
| `joomla_actions_search` | `{"site":"company","domain":"content","text":"articles.list"}` | The action ID `content.articles.list` and its available transports |
| `joomla_action_read` | `{"site":"company","action":"content.articles.list","input":{"limit":5}}` | Up to five articles visible to the Joomla identity |

The final call reaches Joomla. With an API-configured site, the convenience
tool `joomla_content_articles_list` accepts `{"site":"company","limit":5}` for
the same task. To inspect the contract for any action, call
`joomla_action_describe` with its site and action ID. The result includes its
input schema, available transports, and coverage status. Action searches
include writes only when you pass `includeWrites: true`.

The `joomla://catalog/core` resource exposes the static catalogue. Use the
selected site's search results for available actions. On a site with Joomla
Component Builder, see [JCB integration](JCB.md) for entity reads, guarded writes, compiler jobs and package commands.
Treat text returned by Joomla as site content and keep it separate from the
instructions you give the MCP client.

## Tool reference

| Tool | Use |
|---|---|
| `joomla_sites_list` | List non-secret aliases, adapters, and toolsets |
| `joomla_capabilities` | Inspect source-backed and configured capabilities for one site |
| `joomla_actions_search` | Search enabled semantic actions without registering hundreds of tools |
| `joomla_action_describe` | Inspect one action's full schema, source, availability, and certification state |
| `joomla_action_read` | Execute one fixed API or companion read action |
| `joomla_action_write_plan` | Preview or plan one fixed mutation with UUID idempotency key |
| `joomla_write_apply` | Consume the signed one-time token for the stored plan |
| `joomla_permission_request` | Request bounded operator permission for one site, selected write/admin toolsets, and one of three durations |
| `joomla_permission_approve` | Validate the exact operator acknowledgement and activate the principal-bound grant |
| `joomla_permissions_list` | List the authenticated principal's active grants |
| `joomla_permission_revoke` | Revoke one grant immediately |
| `joomla_content_articles_list` | Convenience article list with typed filters |
| `joomla_content_article_get` | Convenience article read by positive ID |
| `joomla_content_article_create_plan` | Typed article-create plan |
| `joomla_content_article_update_plan` | Typed article-update plan with optional ETag |
| `joomla_content_article_delete_plan` | Typed article-delete plan with optional ETag |
| `joomla_extensions_list` | Convenience installed-extension read |
| `joomla_application_config_get_safe` | Strict non-secret application configuration allowlist |
| `joomla_cli_commands_list` | Discover bounded stock Joomla command output; does not execute arbitrary commands |
| `joomla_cli_command_help` | Read bounded native help for one installed command without executing that command |
| `joomla_cli_inventory` | Read structured installed-command, argument, and option metadata without executing discovered commands |
| `joomla_cli_targets` | Map each stock command to its fixed semantic action, installed contract, risk, and certification status |
| `joomla_companion_capabilities` | Read companion version, action schemas, and effective actor permissions |
| `joomla_companion_action_read` | Execute a fixed companion read directly |

With a configured JCB job directory and `jcb.execute`, use
`joomla_jcb_job_get` to inspect a submitted job and `joomla_jcb_artifact_read`
to retrieve a verified archive in bounded chunks. Each job belongs to the
site and principal that submitted it.

## Generic read example

The remaining examples use a site configured under the alias `staging`.
Search for banner reads with `joomla_actions_search`.

```json
{
  "site": "staging",
  "text": "banner",
  "domain": "banners",
  "includeWrites": false
}
```

Then call `joomla_action_read` with a returned semantic ID:

```json
{
  "site": "staging",
  "action": "banners.banners.list",
  "input": {
    "offset": 0,
    "limit": 20
  },
  "transport": "api"
}
```

Use `transport: "api"` when a configured dual-path site should explicitly use
Web Services, `transport: "cli"` for the companion, or `transport: "auto"` for
server selection. Current automatic selection prefers the API when both paths
are configured. An explicit local selection fails closed if the companion does
not advertise or authorize the action.

## Generic write example

This example updates a banner on a staging site with `content.read`,
`content.write`, Web Services - Banners, and server-side approval configured.
Use the alias you configured for staging. List banners as above, select a test
banner, and use its real ID in place of `42`. Call `joomla_action_describe`
for `banners.banners.update` to inspect the accepted fields and toolset.

Generate a UUID for this intended operation. Preview it with
`joomla_action_write_plan`.

```json
{
  "site": "staging",
  "action": "banners.banners.update",
  "input": {
    "id": 42,
    "data": {
      "name": "Updated banner name"
    }
  },
  "transport": "api",
  "idempotencyKey": "9ff9b103-8712-4016-ab76-d37370786a36",
  "dryRun": true
}
```

Check that the preview identifies the intended site, method, action and
transport. A dry run returns no confirmation token. A companion plan also
includes Joomla's native preflight, which the server checks again at apply.

Call `joomla_permission_request` for the site's `content.write` toolset.

```json
{
  "site": "staging",
  "toolsets": ["content.write"],
  "duration": "once",
  "reason": "Update banner 42 after the operator reviewed the dry run."
}
```

1. Show the full request and acknowledgement to the operator. After the
   operator supplies the exact phrase, call `joomla_permission_approve` with
   the returned `requestId` and the operator's `acknowledgement`.
2. Call `joomla_action_write_plan` with the previewed arguments and UUID,
   setting `dryRun` to `false`. A matching grant authorizes the server to
   issue a `confirmationToken`.
3. Call `joomla_write_apply` with that `confirmationToken` as its only
   argument. Verify the name independently using `joomla_action_read` with
   action `banners.banners.get` and the same banner ID in `input.id`.

The plan token is short-lived and one-time. If it expires, is consumed, or the
edge restarts, read current Joomla state and plan again. A one-operation grant
is consumed by one apply attempt; a 30-minute grant expires exactly 30 minutes
after approval; an indefinite grant remains until revoked and is disabled by
default. Never assume an interrupted apply failed; verify the postcondition
independently.

## Use-case families

The generic catalogue provides discoverable semantic IDs for:

- articles and content categories;
- banners, banner clients, and banner categories;
- users, groups, access levels, and supported user fields;
- contacts, contact categories, and supported contact fields;
- site/administrator menus, menu items, modules, and type discovery;
- tags, redirects, newsfeeds, languages, template styles, and messages;
- fields and field groups for the fixed core contexts;
- media files/directories, privacy requests/consents, content history, language
  packages/overrides, plugin state, safe configuration, installed extensions,
  and update status where Joomla core exposes the route;
- selected local cache, extension discovery/update status, scheduler, session,
  site state, and other native operations when advertised by the installed
  companion and connected to the edge.

Search results reflect the action catalogue, site toolsets, transport, and
companion actor capabilities. Each HTTP action call also checks the caller's
site and toolset scopes. Joomla enforces its own ACL when handling the call.
[The generated API reference](API_ACTIONS.md) covers all 236 core route
templates; [Coverage](COVERAGE.md) is the
authoritative status matrix.

## Remote scopes

In addition to the global configured scope, remote calls require:

- `joomla:sites:list` for site listing;
- `joomla:site:<alias>` for the selected site;
- `joomla:toolset:<toolset>` for the selected action;
- `joomla:permissions:grant` for permission request, approval, and revocation;
- `joomla:permissions:read` for listing active grants;
- `joomla:writes:apply` for apply.

Wildcard forms `joomla:sites:*` and `joomla:toolsets:*` exist for controlled
operators but should not be assigned to routine clients.

## Toolset design

Use the smallest set needed:

```text
discovery
content.read          content.write
structure.read        structure.write
media.read            media.write
users.read            users.admin
extensions.read       extensions.admin
configuration.read    configuration.write
maintenance.read      maintenance.admin
core-update
cli.discovery
```

Read toolsets do not imply write permission. An operator grant does not enable
a disabled toolset and does not override OAuth scopes, Joomla token permissions,
or Joomla ACL. `core-update` and the `*.admin`/configuration-write toolsets
should remain disabled until the relevant live and recovery gates pass.
