# JoomEngine MCP for Joomla

An embeddable library and self-hosted Model Context Protocol (MCP) server for
administering Joomla 6.x through bounded, auditable semantic actions.

The server has two Joomla integration paths:

- **Joomla Web Services API:** remote HTTPS access with a dedicated Joomla API identity.
- **Joomla-native companion:** local access through an installable console plugin, Joomla dependency injection, ACL checks, and core models.

Native Joomla capabilities are the authority. The companion adapts native Joomla services and models to a structured JSON contract; it does not replace or reimplement Joomla functionality. There is no generic HTTP, CLI, shell, PHP, SQL, filesystem, model, method, or URL passthrough.

Joomla 6.1 is the implementation baseline, Joomla 6.2 is the compatibility target, and Joomla 7 is tested as a canary.

> **Production status:** all 236 Joomla 6.1 core Web Services route templates are source-catalogued, but five are explicitly source-only and no family has completed the required live Joomla 6.1/6.2 success, denial, postcondition, and recovery matrix. Production certification remains gated on that evidence, deeper value/output contracts, privileged recovery tests, and shared coordination for multi-replica writes. See [coverage and release status](docs/COVERAGE.md).

## Why this stack

TypeScript is a Tier 1 MCP SDK while PHP is Tier 3. For convenience, TypeScript is used and PHP where possible.

## Capabilities

- Source-backed semantic catalogue for all 236 Joomla 6.1 core Web Services route templates.
- CRUD actions for the 36 core resource bases, including articles, banners, users, contacts, categories, menus, modules, tags, redirects, fields, templates, languages, messages, and newsfeeds.
- Reviewed field allowlists for every CRUD mutation family and exact schemas for fixed-shape media, privacy, plugin, language-override, application-configuration, and Joomla Update mutations.
- Explicit source-only gates for routes that are defective in Joomla 6.1 or require unimplemented runtime secret/schema discovery.
- Joomla-native local actions through a fixed companion allowlist.
- Read-only discovery, safe configuration filtering, and immutable multi-site aliases.
- Guarded writes using explicit principal-bound operator grants (`once`, `30-minutes`, or `indefinite`), preview, signed one-time plans, idempotency, locks, audit events, and verification where supported.
- MCP over stdio or authenticated Streamable HTTP.
- Versioned ESM package with typed root and subpath exports for host applications.
- OCI image, Docker Compose, and systemd deployment foundations.
- Interactive and unattended catalogue-complete live validation with
  deterministic Joomla fixtures, safety confirmation, and redacted
  Markdown/JSON/JUnit failure evidence.

The generated [API action reference](docs/API_ACTIONS.md) lists every route, semantic ID, accepted field set, transport, risk, and source-only gate. The release truth table is in [docs/COVERAGE.md](docs/COVERAGE.md). An implemented action is not described as production-verified until it has passed the corresponding live Joomla matrix.

## Requirements

- Node.js 22.12 or newer.
- Joomla 6.1 or newer for companion use; a Joomla 6.x site for API use.
- PHP 8.3 or newer on a host using the companion.
- HTTPS and a dedicated least-privilege Joomla API user for remote API access.
- An OAuth/OIDC authorization server with a HTTPS JWKS endpoint for remote MCP access.

## Use as a library dependency

Install the public, versioned package:

```bash
npm install @joomengine/joomla-mcp@^0.7.0
```

Create a transport-neutral application without starting a process or binding a
port:

```js
import {
  createJoomlaMcp,
  loadConfiguration,
} from '@joomengine/joomla-mcp';

const configuration = await loadConfiguration('/etc/joomla-mcp/sites.json');
const application = createJoomlaMcp({ configuration });
const mcpServer = application.createServer();
```

The package retains the complete catalogue, reads, guarded writes,
administration actions, grant workflow, Joomla API and companion transports,
stdio and authenticated HTTP support. Host applications may inject secret
resolution, audit, API, and CLI adapters while the action and security
boundaries remain controlled by this package.

See [library integration](docs/LIBRARY.md) for every public entry point,
configuration and secret-manager integration, stdio/HTTP lifecycle, adapter
contracts, isolation rules, executable examples, and compatibility policy.

## Install and validate

```bash
git clone https://github.com/joomengine/joomla-mcp.git
cd joomla-mcp
npm ci
cp config/sites.example.json config/sites.json
npm run validate
```

Edit `config/sites.json`, then export every secret named by `tokenEnv`, `updateTokenEnv`, and `approval.secretEnv`. Tokens and approval secrets are never stored in the site file.

For write-enabled sites, generate an approval secret of at least 32 random characters:

```bash
export JOOMLA_MCP_APPROVAL_SECRET="$(openssl rand -hex 32)"
```

Do not put production secrets in shell history, source control, client configuration, or command arguments. Use the operating-system service manager or a secret store.

To build the companion and prove a fresh installation plus the complete live
MCP matrix against the repository's disposable Joomla 6.1/JoomEngine fixture:

```bash
php companion/build.php
npm run test:fixture:joomengine
```

This requires Docker with Compose v2. The fixture uses fresh isolated volumes,
publishes Joomla only on a random loopback port, generates throwaway
credentials and an ephemeral API token, inventories installed CLI contracts,
then exercises the full action catalogue through API/companion and
stdio/Streamable HTTP before removing the site and database. Failures upload
redacted Markdown, JSON, JUnit, per-action evidence, and runtime logs before
teardown. See [live validation](docs/LIVE_TESTING.md).

The packaged declarative scenario is `config/live-test.default.json`. It
creates and independently verifies several categories, articles, user groups,
users, banner categories, banners, menus, article menu items, and custom HTML
modules. Relationships use named references in JSON; Joomla IDs are resolved
only after the referenced record has been created and independently observed.
Private-message tests likewise resolve each path's authenticated account from
the human-readable `target.actorUsernames` scenario setting before sending.
Pass `--scenario /path/to/override.json` to replace the packaged scenario, or
omit a resource family from the override to skip that family.

To retain every created record for inspection in Joomla without issuing any
delete or trash operation:

```bash
npm run test:live -- \
  --scenario ./config/live-test.default.json \
  --config /absolute/path/to/config/sites.json \
  --site demo \
  --profile crud \
  --non-interactive \
  --confirm-mutations \
  --cleanup never
```

The runner writes `START`, `WAIT`, and terminal status lines to standard output
as each phase runs, while preserving the full Markdown, JSON, JUnit, per-action,
and fixture-log artifacts.

To select a live demo site interactively:

```bash
npm run build
npx joomla-mcp-live-test
```

Mutation profiles print the exact target and require a typed hostname/run-seed
acknowledgement. Unattended mutation runs require explicit
`--confirm-mutations`; the full privileged profile additionally requires
`--disposable`.

## Use over stdio

Build and start the server:

```bash
npm run build
JOOMLA_MCP_CONFIG=/absolute/path/to/config/sites.json npm start
```

Example MCP client entry:

```json
{
  "mcpServers": {
    "joomla": {
      "command": "node",
      "args": ["/opt/joomla-mcp/dist/bin/joomla-mcp.js"],
      "env": {
        "JOOMLA_MCP_CONFIG": "/etc/joomla-mcp/sites.json"
      }
    }
  }
}
```

The process environment must also contain the token and approval-secret variables referenced by the site file. Stdio inherits the permissions of the local MCP client, so use a dedicated operating-system account for production.

## Use over Streamable HTTP

Add the `http` block shown in `config/sites.example.json`, then run:

```bash
npm run build
JOOMLA_MCP_CONFIG=/etc/joomla-mcp/sites.json npm run start:http
```

The HTTP entry point requires cryptographically verified JWTs and validates issuer, audience, scopes, exact `Host`, optional `Origin`, request limits, and principal-bound sessions. `/healthz` is shallow process liveness; `/readyz` warms and validates the configured JWKS dependency before the instance receives MCP traffic. Graceful shutdown stops new admission, closes idle connections, waits for active connections up to `shutdownGraceMs`, and then force-closes them. Terminate TLS at a trusted reverse proxy and keep the Node listener on a private interface. See [remote HTTP](docs/REMOTE_HTTP.md) and [deployment](docs/DEPLOYMENT.md).

## Use the Joomla companion

Build and test the installable package:

```bash
php companion/tests/run.php
php companion/build.php
```

Install the generated `companion/dist/pkg_joomlamcp-*.zip` with Joomla's extension installer. A first installation enables **Console - JoomEngine MCP for Joomla Companion** through Joomla's native installer lifecycle; package updates preserve the operator's enabled/disabled state. Select a dedicated least-privilege **MCP actor user**, and configure the site's fixed Joomla root and PHP executable in `config/sites.json`.

Verify from the Joomla root:

```bash
php cli/joomla.php joomla:mcp:describe --format=json --no-interaction --no-ansi
```

The edge invokes only the companion's named, schema-validated actions over JSON stdin. See [PHP companion](docs/PHP_COMPANION.md).

## Joomla API setup

For each site:

1. Enable **API Authentication - Web Services Joomla Token**.
2. Enable **User - Joomla API Token** and permit a dedicated automation group.
3. Give the automation group `core.login.api` and only the component permissions required by its enabled toolsets.
4. Enable only the Web Services plugins needed by those toolsets.
5. Create the user's Joomla API token and place it in the environment variable named by `tokenEnv`.
6. Confirm that `https://your-site.example/api/index.php/v1/content/articles` responds using that token.

Joomla Update uses a separate token referenced by `updateTokenEnv`. Do not reuse or expose either token to MCP clients.

## Writes

Writes are disabled unless the relevant site toolset and approval configuration are enabled. The normal flow is:

1. Search the catalogue and select a fixed semantic action.
2. Call `joomla_action_describe` to inspect its complete schema, source, configured transport availability, and certification state.
3. Call `joomla_action_write_plan` with a UUID idempotency key and `dryRun: true` to inspect the operation. Companion plans execute Joomla's native non-mutating preflight and bind its redacted result into the plan.
4. Call `joomla_permission_request` for the exact site, write/administration toolsets, reason, and duration.
5. Show the returned acknowledgement phrase to the operator. Submit it to `joomla_permission_approve` only after the operator supplies it exactly.
6. Repeat the write plan with `dryRun: false`; an active matching grant is required and the returned token is bound to that grant.
7. Call `joomla_write_apply` with the token. Apply rechecks the authenticated principal, site/toolset scopes, grant, stored plan, and Joomla preconditions before executing.
8. Verify the resulting resource and the permission/plan/apply audit events.

One-operation grants are consumed by one apply attempt. Thirty-minute grants expire exactly 30 minutes after approval. Indefinite grants are disabled by default, require an integrity-protected persistent store, and remain active only until explicitly revoked. Grants never override site configuration, OAuth scopes, Joomla token permissions, or Joomla ACL.

Do not enable destructive or privileged toolsets until their live and recovery gates in [docs/COVERAGE.md](docs/COVERAGE.md) have passed for your environment.

## Documentation

- [Architecture and native-first rules](docs/ARCHITECTURE.md)
- [Library and host-application integration](docs/LIBRARY.md)
- [Versioning and coordinated package releases](docs/RELEASING.md)
- [Single-company, single-site deployment](docs/SINGLE_SITE.md)
- [ChatGPT, Codex, Claude, Gemini, and Grok connections](docs/CLIENTS.md)
- [Generated Joomla API action reference](docs/API_ACTIONS.md)
- [Action coverage and release status](docs/COVERAGE.md)
- [Deployment, upgrades, and rollback](docs/DEPLOYMENT.md)
- [Fixture setup and live verification](docs/FIXTURES.md)
- [Interactive, unattended, and CI live validation](docs/LIVE_TESTING.md)
- [Operations and monitoring](docs/OPERATIONS.md)
- [PHP companion](docs/PHP_COMPANION.md)
- [Remote Streamable HTTP](docs/REMOTE_HTTP.md)
- [Security model](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [MCP tools and use cases](docs/USAGE.md)
- [Joomla CLI inventory and integration mapping](docs/CLI.md)

## Development and contribution

```bash
npm run check
npm test
npm run build
php companion/tests/run.php
php companion/build.php
```

`npm run validate` runs TypeScript checking, the offline test suite, and the production build. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

Copyright (C) 2026 Vast Development Method.

JoomEngine MCP for Joomla is free software licensed under the **GNU General Public License, version 2 or, at your option, any later version** (`GPL-2.0-or-later`). You may use, modify, and redistribute it under those terms. The complete license text is in [LICENSE](LICENSE).
