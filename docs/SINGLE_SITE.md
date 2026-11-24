# Single-company, single-site deployment

This guide connects a local MCP client to one Joomla site over the Web Services
API. The client launches a Node.js process under your operating-system account.
One dedicated Joomla user determines what that process can do on the site.
Start with read access and verify an article query before enabling writes.

For a shared HTTPS endpoint hosted with Compose or systemd, follow
[Deployment, upgrade, and rollback](DEPLOYMENT.md).

## 1. Build the server on the client machine

Run these commands in Bash with Git, npm and Node.js 22.12 or newer. Use a
directory owned by the account that will launch the MCP client.

```bash
git clone https://github.com/joomengine/joomla-mcp.git "$HOME/joomla-mcp"
cd "$HOME/joomla-mcp"
npm ci
npm run validate
```

Validation includes the build. The stdio entry point is
`dist/bin/joomla-mcp.js`. To install a compiled release from npm, see the
[README](../README.md).

## 2. Create a dedicated Joomla API identity

In Joomla:

1. Enable **API Authentication - Web Services Joomla Token**.
2. Create a dedicated automation user and group.
3. Enable **User - Joomla API Token** and include the group in the plugin’s allowed groups.
4. Grant `core.login.api`.
5. Grant only the component read permissions needed by the enabled read
   toolsets.
6. Enable **Web Services - Content** for the article query below and the Web Services plugins for any other enabled toolsets.
7. Generate the user’s Joomla API token.

Do not use a human Super User token. Article/banner creation requires **Access
Administration Interface** (`core.manage`) on the target component as well as
**Create** (`core.create`) on the selected category. Configure these through
the component's Options → Permissions; read success alone does not establish
write access. **Configure ACL & Options** (`core.admin`) is not required.

## 3. Configure the site and its credential

From the checkout, create a private configuration for this account.

```bash
install -d -m 0700 "$HOME/.config/joomla-mcp"
install -m 0600 config/sites.single-site-readonly.example.json "$HOME/.config/joomla-mcp/sites.json"
```

In that file, set `sites.company.api.baseUrl` to the Joomla installation URL
(for example, `https://www.example.com`). The adapter appends the Web Services
path. Keep the alias `company` for the example calls below.

Supply the token to the Node process as `JOOMLA_COMPANY_TOKEN`. For a client
launched from an interactive Bash shell, enter the token without echoing it or
putting it in the shell history.

```bash
read -rsp 'Joomla API token: ' JOOMLA_COMPANY_TOKEN
echo
export JOOMLA_COMPANY_TOKEN
```

## 4. Connect and verify a read

For a client that accepts an `mcpServers` JSON object, run the following from
the checkout to print a client entry with this machine’s absolute paths.

```bash
node --input-type=module <<'JS'
import { homedir } from 'node:os';
import { resolve } from 'node:path';
const server = {
  command: process.execPath,
  args: [resolve('dist/bin/joomla-mcp.js')],
  env: { JOOMLA_MCP_CONFIG: resolve(homedir(), '.config/joomla-mcp/sites.json') }
};
console.log(JSON.stringify({ mcpServers: { joomla: server } }, null, 2));
JS
```

Add the entry to the client and configure it to pass `JOOMLA_COMPANY_TOKEN`
to its child process. Restart the client and use its MCP tools. For Codex TOML
and other client-specific settings, see [AI client connections](CLIENTS.md).

| Tool | Arguments | What to check |
|---|---|---|
| `joomla_sites_list` | `{}` | The configured alias `company` is listed. |
| `joomla_capabilities` | `{"site":"company"}` | The site has the API adapter and `content.read`. |
| `joomla_content_articles_list` | `{"site":"company","limit":1}` | Joomla returns at most one accessible article. An empty successful list is valid on a new site. |

## 5. Enable controlled writes

Add only the required write toolsets to the site. The available permission
classes are:

```text
content.write
structure.write
media.write
users.admin
extensions.admin
configuration.write
jcb.write
jcb.execute
maintenance.admin
core-update
```

Add an `approval` object alongside `sites` in the same JSON file. For a local
stdio process, set `grantStorePath` to an absolute path inside the private
configuration directory created in step 3. For example, this configuration is
for a user whose home directory is `/home/operator`.

```json
{
  "approval": {
    "secretEnv": "JOOMLA_MCP_APPROVAL_SECRET",
    "ttlMs": 300000,
    "requestTtlMs": 300000,
    "grantStorePath": "/home/operator/.config/joomla-mcp/permission-grants.json",
    "allowIndefinite": false
  }
}
```

Generate `JOOMLA_MCP_APPROVAL_SECRET` once with `openssl rand -hex 32` and store
it in your secret manager. Pass the same value to the MCP process on each
launch so it can verify persisted grants. The process creates the grant file
with mode `0600` when it persists a change. Restart the client after changing
toolsets or credentials.

For a managed service the shipped systemd unit and Compose volume provide a
private state directory at `/var/lib/joomla-mcp`.

Set `allowIndefinite` to `true` only after audit retention, revocation, backup,
and incident-response procedures have been tested.

## 6. Operator permission flow

Every write transport and every write/administration toolset uses the same
flow:

1. The AI calls `joomla_action_write_plan` with `dryRun: true`.
2. The AI calls `joomla_permission_request` with the exact site, toolsets,
   duration, and reason.
3. The MCP returns a random exact acknowledgement phrase.
4. The AI shows the complete request and phrase to the operator.
5. The operator supplies that exact phrase.
6. The AI submits it to `joomla_permission_approve`.
7. The AI repeats the write plan with `dryRun: false`.
8. The MCP binds the active grant to the signed operation plan.
9. The AI calls `joomla_write_apply`.
10. Apply rechecks OAuth site/toolset scopes, the stored operation, the grant,
    Joomla-side preconditions where available, Joomla ACL, and the result.

| Duration | Behavior | Persistence |
|---|---|---|
| `once` | Authorizes one matching apply attempt | Persisted when a store is configured; removed when consumed |
| `30-minutes` | Authorizes matching operations for exactly 30 minutes | Persisted when a store is configured |
| `indefinite` | Authorizes matching operations until explicit revocation | Disabled by default; durable store required |

The operator grant never expands server configuration, OAuth scopes, Joomla
token permissions, or Joomla ACL. All four layers must allow the operation.

Use `joomla_permissions_list` to inspect active grants and
`joomla_permission_revoke` to revoke one immediately. Grant request,
approval, use, and revocation are emitted as structured audit events. The
acknowledgement phrase and principal identity are never written to the grant
store.

## 7. Optional local Joomla companion

If the Node process has local access to the Joomla installation and PHP, it can
also invoke Joomla-native actions through this repository’s companion. Install
the matching release ZIP (for example, `pkg_joomlamcp-0.8.1.zip`) using
Joomla’s extension installer, enable the console plugin, and select its
dedicated **MCP actor user**. Run the following from the Joomla installation
directory under the account that will execute the companion.

```bash
php cli/joomla.php joomla:mcp:self-test --format=json --no-interaction --no-ansi
```

Add the site's `cli.root` and `cli.phpBinary`, restart the MCP process, and
check its capabilities again. See [the companion guide](PHP_COMPANION.md) for
package builds, filesystem permissions and the catalogue of local actions.

## 8. In-house acceptance gate

Before production writes:

- `npm run validate` passes on the deployed revision;
- the deployed image or package matches release checksums and provenance;
- Joomla staging and production versions are recorded;
- the dedicated actor has no unnecessary ACL privileges;
- every enabled Web Services plugin is justified;
- read results contain no tokens or secrets;
- permission request, approval, use, time-based expiry, and revocation are tested;
- one denial test is recorded for every enabled write toolset;
- a current backup is restorable;
- postconditions are verified for the intended mutation family;
- audit delivery and retention are monitored;
- rollback disables the affected toolset without changing source code.

The repository’s [coverage truth table](COVERAGE.md) remains authoritative.
Passing this single-site checklist does not claim universal production
certification for mutation families that are still marked pending there.
