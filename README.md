# JoomEngine MCP for Joomla

[![CI](https://github.com/joomengine/joomla-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/joomengine/joomla-mcp/actions/workflows/ci.yml) [![Release](https://github.com/joomengine/joomla-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/joomengine/joomla-mcp/actions/workflows/release.yml) [![Publish](https://github.com/joomengine/joomla-mcp/actions/workflows/publish-release.yml/badge.svg)](https://github.com/joomengine/joomla-mcp/actions/workflows/publish-release.yml) [![npm](https://img.shields.io/npm/v/%40joomengine%2Fjoomla-mcp?label=npm)](https://www.npmjs.com/package/@joomengine/joomla-mcp) [![Joomla](https://img.shields.io/badge/Joomla-6.1%2B-5091CD?logo=joomla&logoColor=white)](https://www.joomla.org/) [![Node](https://img.shields.io/badge/Node-22.12%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![License](https://img.shields.io/badge/License-GPL--2.0%2B-blue)](LICENSE)

Connect an MCP client to a Joomla site to read articles, inspect menus and
extensions, and plan and apply changes with operator approval. The
`@joomengine/joomla-mcp` npm package provides the Node.js server and an
embeddable TypeScript library. One server can address several sites by alias,
each with its own credentials and enabled tools.

| I want to… | Where to start |
| --- | --- |
| Connect a desktop or terminal client to a Joomla site | Follow the read-only setup below, then the [client guide](docs/CLIENTS.md). |
| Connect a hosted MCP client such as ChatGPT | Deploy the [Streamable HTTP server](docs/REMOTE_HTTP.md) with HTTPS and OAuth. [Docker Compose and systemd instructions](docs/DEPLOYMENT.md) |
| Use Joomla's native models or inspect the local CLI | Install the [PHP console companion](docs/PHP_COMPANION.md) on the Joomla host. |
| Work with a site that uses Joomla Component Builder (JCB) | Use Joomla actions on the site and inspect installed JCB commands. [JCB setup and worked example](docs/JCB.md) |
| Embed Joomla tools in a Node.js application | Use the [library API and runnable examples](docs/LIBRARY.md). |

## Connect your first Joomla site

This example uses local **stdio** between your MCP client and the Node server.
The server connects to Joomla over **HTTPS**. Only the client machine needs
Node.js (22.12 or newer). Joomla needs the core Web Services plugins for the
resources you want to access. The example uses Joomla 6.x and a site alias
named `company`.

### 1. Prepare the Joomla API user

In Joomla Administrator, enable **API Authentication - Web Services Joomla
Token**, **User - Joomla API Token**, and **Web Services - Content**. Create a
dedicated user and group for this connection. Include the group in the user
token plugin's allowed groups and grant it **Web Services Login**
(`core.login.api`) and the component permissions needed for your reads. Get
the user's token from the **Joomla API Token** tab in that user's profile.
The [single-site guide](docs/SINGLE_SITE.md) covers permissions and enabling
additional toolsets.

### 2. Install the server and configure the site

Run these commands in Bash on the machine that will launch the MCP client.

```bash
mkdir -p "$HOME/joomla-mcp"
cd "$HOME/joomla-mcp"
npm install --prefix . @joomengine/joomla-mcp@0.8.0
cp node_modules/@joomengine/joomla-mcp/config/sites.single-site-readonly.example.json sites.json
```

Edit `sites.json`. Set `sites.company.api.baseUrl` to the HTTPS address of your
Joomla installation, including its subdirectory if applicable. The server
appends `/api/index.php/v1/…`. For an articles-only connection, set
`sites.company.toolsets` to `["discovery", "content.read"]`. Leave `tokenEnv`
set to `JOOMLA_COMPANY_TOKEN`. It names the environment variable that holds
the token.

```bash
read -rsp 'Joomla API token: ' JOOMLA_COMPANY_TOKEN
echo
export JOOMLA_COMPANY_TOKEN
```

### 3. Register the stdio server in your MCP client

For clients that use `mcpServers` JSON, the following command prints a server
entry with the absolute paths from your installation. Run it in the same
`$HOME/joomla-mcp` directory and add the entry to your client's configuration.

```bash
node --input-type=module <<'NODE'
import { resolve } from 'node:path';

console.log(JSON.stringify({
  mcpServers: {
    joomla: {
      command: process.execPath,
      args: [resolve('node_modules/@joomengine/joomla-mcp/dist/bin/joomla-mcp.js')],
      env: { JOOMLA_MCP_CONFIG: resolve('sites.json') }
    }
  }
}, null, 2));
NODE
```

Launch or restart the client with `JOOMLA_COMPANY_TOKEN` available to its
server process. Clients that filter the environment need to forward this
variable explicitly. Each client starts the stdio server itself. For Codex
TOML, Claude Code, Gemini CLI, desktop apps and remote connections, see
[client-specific configuration](docs/CLIENTS.md).

### 4. Verify a read

| MCP tool | Arguments | What it verifies |
| --- | --- | --- |
| `joomla_sites_list` | `{}` | The server loaded the `company` alias and its configured adapters. |
| `joomla_content_articles_list` | `{"site":"company","limit":1}` | The server can reach Joomla and read content with this user's token. An empty list is valid on a site with no visible articles. |

In a chat client, you can ask “List at most one Joomla article on the
`company` site.” If discovery succeeds and the article read fails, check the
site URL, token, Joomla permissions and Content Web Services plugin.
[Troubleshooting](docs/TROUBLESHOOTING.md)

## Joomla and JCB actions

Use `joomla_actions_search` to find what the site enables and
`joomla_action_describe` to inspect an action's inputs and available
transports. The catalogue covers 236 Joomla 6.1 core Web Services route
templates. Five entries are source-only. Joomla 6.1 is the baseline, 6.2 is
the compatibility target, and Joomla 7 has a canary check. The live success,
denial and recovery matrix is still incomplete. Review the [action
reference](docs/API_ACTIONS.md) and [coverage status](docs/COVERAGE.md)
before enabling writes in production.

With JCB installed, the same core tools work for articles, menus and other
Joomla resources. To discover the `componentbuilder:` commands available on
that particular site, configure the local companion and enable `cli.discovery`.
Use `joomla_cli_inventory` to find a command and `joomla_cli_command_help`
to inspect its arguments. For component authoring and compilation options,
see [Using Joomla MCP with JCB](docs/JCB.md).

### Apply a change with operator approval

1. Enable the specific write toolset for the site and configure the approval
   secret. The Joomla identity also needs permission for the operation.
2. Describe the action and call `joomla_action_write_plan` with its inputs, a
   UUID idempotency key and `dryRun: true`. Review the target and proposed change.
3. Call `joomla_permission_request` for the site, toolset, reason and duration.
   Show the acknowledgement phrase to the operator. After the operator supplies
   the exact phrase, submit it to `joomla_permission_approve`.
4. Repeat the plan with `dryRun: false`. Pass its signed confirmation token to
   `joomla_write_apply`, then read the resource back and check the audit result.

The [usage guide](docs/USAGE.md) explains the tools and grant workflow.
For content-specific examples, see [article text](docs/ARTICLE_TEXT.md),
[custom field values](docs/CUSTOM_FIELDS.md) and [menu component
binding](docs/MENU_COMPONENT_BINDING.md).

## Deploy and operate the server

- **Remote API sites.** Run the published `ghcr.io/joomengine/joomla-mcp`
  image with Compose for an API-only server, or run Node under systemd.
  Configure the `http` block and an OAuth/OIDC issuer with a reachable HTTPS
  JWKS endpoint. The reverse proxy terminates TLS. The MCP client sends its
  access token to the server, which uses a separate Joomla credential for
  each site. [Deployment, upgrades and rollback](docs/DEPLOYMENT.md)
- **Local Joomla access.** Run Node on the Joomla host with access to PHP
  8.3+ and the Joomla root. Install the matching `pkg_joomlamcp` ZIP, select
  a dedicated MCP actor in the console plugin and run its self-test. A site
  can configure the API adapter, the local companion, or both.
  [Companion installation](companion/README.md)
- **Operational checks.** `/healthz` reports HTTP process liveness and
  `/readyz` checks the JWKS dependency. Use a bounded Joomla read to verify
  site access. Run a single server replica for writes. [Operations and
  monitoring](docs/OPERATIONS.md) · [Security model](docs/SECURITY.md)

## Build and test from source

```bash
git clone https://github.com/joomengine/joomla-mcp.git
cd joomla-mcp
npm ci
npm run validate
```

The built stdio executable is `dist/bin/joomla-mcp.js`. Set
`JOOMLA_MCP_CONFIG` to the absolute path of your site file before launching it
from your client. See the [changelog](CHANGELOG.md) for changes since the
published package.

To build the installable companion and exercise it against the disposable
JoomEngine fixture, use PHP 8.3+ with the ZIP extension and Docker Compose v2.

```bash
php companion/tests/run.php
php companion/build.php
npm run test:fixture:joomengine
```

See [live testing](docs/LIVE_TESTING.md) for the fixture, interactive site
selection, unattended runs and cleanup controls. Developer references include
[architecture](docs/ARCHITECTURE.md), [CLI mapping](docs/CLI.md),
[testing](docs/TESTING.md), [release procedures](docs/RELEASING.md) and
[contributing](CONTRIBUTING.md). Report vulnerabilities using the
[private reporting instructions](SECURITY.md).

## License

Copyright (C) 2026 Vast Development Method.

JoomEngine MCP for Joomla is free software licensed under the **GNU General Public License, version 2 or, at your option, any later version** (`GPL-2.0-or-later`). You may use, modify, and redistribute it under those terms. The complete license text is in [LICENSE](LICENSE).
