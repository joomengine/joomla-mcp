# Single-company, single-site deployment

This is the supported first production shape: one company, one Joomla site,
one JoomEngine MCP for Joomla process, and one dedicated Joomla automation
identity.

Start read-only. Add each write or administration toolset after it passes the
company’s staging, backup, denial, and recovery checks.

## 1. Install and validate the server

```bash
getent group joomla-mcp >/dev/null || sudo groupadd --system joomla-mcp
id -u joomla-mcp >/dev/null 2>&1 || sudo useradd \
  --system \
  --gid joomla-mcp \
  --home-dir /nonexistent \
  --shell /usr/sbin/nologin \
  joomla-mcp
sudo install -d -o root -g root -m 0755 /opt/joomla-mcp
sudo install -d -o root -g joomla-mcp -m 0750 /etc/joomla-mcp
git clone https://github.com/joomengine/joomla-mcp.git /opt/joomla-mcp
cd /opt/joomla-mcp
npm ci
npm run validate
npm run build
```

For a tagged release, the equivalent server artifact is
`joomengine-mcp-for-joomla-vX.Y.Z.tgz`. The deployment bundle contains the
Compose, systemd, configuration, operations, and troubleshooting material.

## 2. Create a dedicated Joomla API identity

In Joomla:

1. Enable **API Authentication - Web Services Joomla Token**.
2. Enable **User - Joomla API Token**.
3. Create a dedicated automation user and group.
4. Grant `core.login.api`.
5. Grant only the component read permissions needed by the enabled read
   toolsets.
6. Enable only the required Web Services plugins.
7. Generate the user’s Joomla API token.

Do not use a human Super User token.

## 3. Install the read-only site configuration

```bash
sudo cp \
  /opt/joomla-mcp/config/sites.single-site-readonly.example.json \
  /etc/joomla-mcp/sites.json
sudo chown root:joomla-mcp /etc/joomla-mcp/sites.json
sudo chmod 0640 /etc/joomla-mcp/sites.json
sudoedit /etc/joomla-mcp/sites.json
```

Set `api.baseUrl` to the site’s canonical HTTPS origin. Keep the site alias
stable; AI clients use the alias and never receive the origin or token from a
tool input.

Provision the token through the process environment:

```bash
export JOOMLA_COMPANY_TOKEN='the-token-generated-by-joomla'
export JOOMLA_MCP_CONFIG='/etc/joomla-mcp/sites.json'
cd /opt/joomla-mcp
npm start
```

Use a service manager or secret store for an unattended deployment. The export
commands are a foreground validation example, not a production secret-storage
recommendation.

## 4. Connect an AI client

Use [AI client connections](CLIENTS.md). The quickest in-house path is local
stdio:

```json
{
  "mcpServers": {
    "joomla": {
      "command": "/usr/bin/node",
      "args": ["/opt/joomla-mcp/dist/bin/joomla-mcp.js"],
      "env": {
        "JOOMLA_MCP_CONFIG": "/etc/joomla-mcp/sites.json"
      }
    }
  }
}
```

The client process must inherit `JOOMLA_COMPANY_TOKEN`.

Verify:

1. `joomla_sites_list`
2. `joomla_capabilities`
3. `joomla_actions_search` with `includeWrites: false`
4. one resource-specific list or `joomla_action_read`

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
maintenance.admin
core-update
```

Add the approval block:

```json
{
  "approval": {
    "secretEnv": "JOOMLA_MCP_APPROVAL_SECRET",
    "ttlMs": 300000,
    "requestTtlMs": 300000,
    "grantStorePath": "/var/lib/joomla-mcp/permission-grants.json",
    "allowIndefinite": false
  }
}
```

Create the protected state directory and secret:

```bash
sudo install -d -o joomla-mcp -g joomla-mcp -m 0700 /var/lib/joomla-mcp
sudo -u joomla-mcp sh -c 'printf "%s\n" "{\"version\":1,\"grants\":[]}" > /var/lib/joomla-mcp/permission-grants.json'
sudo chmod 0600 /var/lib/joomla-mcp/permission-grants.json
export JOOMLA_MCP_APPROVAL_SECRET="$(openssl rand -hex 32)"
```

The file must remain owned by the MCP service account with mode `0600`. The
systemd unit uses `StateDirectory=joomla-mcp`; the Compose deployment mounts a
dedicated state volume.

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

Install the companion only when the MCP process runs on the Joomla host and
needs fixed Joomla-native operations unavailable through Web Services:

```bash
cd /opt/joomla-mcp
php companion/tests/run.php
php companion/build.php
cd /srv/www/joomla
php cli/joomla.php extension:install \
  --path=/opt/joomla-mcp/companion/dist/pkg_joomlamcp-0.7.0.zip
php cli/joomla.php joomla:mcp:self-test --format=json --no-interaction --no-ansi
```

Select a dedicated MCP actor in the plugin configuration and add the fixed
`cli` block described in [the companion guide](PHP_COMPANION.md).

The companion does not expose arbitrary shell, PHP, SQL, filesystem paths,
models, methods, URLs, or discovered Joomla commands.

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
