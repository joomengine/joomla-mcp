# AI client connections

> **Current installation:** this page documents the TypeScript proof-of-concept
> stack. For new installations, use the stable
> [MCP package](https://github.com/joomengine/mcp_package/tags), then follow the
> [Joomla setup guide](https://github.com/joomengine/mcp_component/blob/main/docs/GETTING-STARTED.md)
> and [AI / direct client guide](https://github.com/joomengine/mcp_component/blob/main/docs/CLIENT-CONNECTIONS.md).
> The current PHP client is maintained in
> [`mcp_client`](https://github.com/joomengine/mcp_client).

JoomEngine MCP for Joomla is model-independent. The server speaks standard MCP;
the AI product is an MCP host. Use local stdio when the host can start the Node
process, or authenticated Streamable HTTP when the host connects over a
network.

Joomla API tokens, Joomla Update tokens, and the approval HMAC secret belong in
the MCP server process environment. Do not paste them into prompts or put their
values in an AI client configuration.

## Compatibility matrix

| Client | Local stdio | Streamable HTTP | Authentication |
|---|---:|---:|---|
| ChatGPT remote apps | No | Yes | HTTPS remote connector; this predecessor requires its configured OAuth/OIDC flow |
| Codex CLI/app/IDE | Yes | Yes | Inherited environment, bearer-token variable, or OAuth |
| Claude Code | Yes | Yes | Inherited environment, headers, or OAuth |
| Claude Desktop | Yes | Remote connector separately | Local process environment or connector OAuth |
| Gemini CLI | Yes | Yes | Inherited environment, headers, or OAuth discovery |
| Grok/xAI Responses API | No | Yes | Bearer token passed as the MCP `authorization` value |

The configurations below use:

- repository checkout: `/opt/joomla-mcp`;
- compiled entry point: `/opt/joomla-mcp/dist/bin/joomla-mcp.js`;
- site configuration: `/etc/joomla-mcp/sites.json`;
- remote endpoint: `https://mcp.company.example/mcp`.

Change only those installation-specific paths and hostnames.

## ChatGPT

Use a remote HTTPS MCP app connection. A local `mcpServers` stdio launcher
configuration is for compatible local MCP hosts, including Codex and Claude;
it is not a ChatGPT connection recipe.

For this TypeScript predecessor, publish its authenticated Streamable HTTP
endpoint as described in [remote HTTP](REMOTE_HTTP.md), configure the OAuth/OIDC
flow required by that server, then follow
[OpenAI's current ChatGPT connection instructions](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).
Select the remote HTTPS endpoint, complete authentication, inspect the
discovered tools and start with a read-only request. Availability and settings
depend on the ChatGPT account and workspace.

For the actively maintained Joomla-native package and PHP client, follow the
[current connection guide](https://github.com/joomengine/mcp_component/blob/main/docs/CLIENT-CONNECTIONS.md);
its transport and authentication requirements differ from this predecessor.

ChatGPT's app-level confirmation policy is additional to the server's Joomla
permission grant; it does not replace the server-side grant.

## Codex CLI, app, and IDE extension

These surfaces share `~/.codex/config.toml`.

Local stdio:

```toml
[mcp_servers.joomla]
command = "/usr/bin/node"
args = ["/opt/joomla-mcp/dist/bin/joomla-mcp.js"]
env = { JOOMLA_MCP_CONFIG = "/etc/joomla-mcp/sites.json" }
env_vars = [
  "JOOMLA_COMPANY_TOKEN",
  "JOOMLA_COMPANY_UPDATE_TOKEN",
  "JOOMLA_MCP_APPROVAL_SECRET"
]
default_tools_approval_mode = "writes"
required = true
tool_timeout_sec = 180
```

Remote HTTP:

```toml
[mcp_servers.joomla]
url = "https://mcp.company.example/mcp"
auth = "oauth"
default_tools_approval_mode = "writes"
required = true
tool_timeout_sec = 180
```

Run:

```bash
codex mcp list
codex mcp login joomla
```

The login command is required only for the OAuth-protected HTTP configuration.

## Claude Code

Local stdio:

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  --env JOOMLA_MCP_CONFIG=/etc/joomla-mcp/sites.json \
  joomla \
  -- /usr/bin/node /opt/joomla-mcp/dist/bin/joomla-mcp.js
```

Launch Claude Code from an environment that already contains the secret
variables referenced by `sites.json`.

Remote HTTP:

```bash
claude mcp add \
  --transport http \
  --scope user \
  joomla \
  https://mcp.company.example/mcp
```

Run `claude mcp list`, then `/mcp` inside Claude Code. Complete OAuth when
prompted. The `type` of a JSON remote configuration must be `http` or
`streamable-http`; a URL without a type is not a valid Claude Code
configuration.

See <https://docs.anthropic.com/en/docs/claude-code/mcp>.

## Claude Desktop

Claude Desktop can use the same local stdio process. Add this entry to the
desktop MCP configuration and restart Claude Desktop:

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

The desktop process must inherit the secret environment variables. Remote
Claude connectors are account-managed and connect from Anthropic’s
infrastructure rather than from the desktop’s local network.

## Gemini CLI

Add this to `~/.gemini/settings.json`:

```json
{
  "mcp": {
    "allowed": ["joomla"]
  },
  "mcpServers": {
    "joomla": {
      "command": "/usr/bin/node",
      "args": ["/opt/joomla-mcp/dist/bin/joomla-mcp.js"],
      "env": {
        "JOOMLA_MCP_CONFIG": "/etc/joomla-mcp/sites.json",
        "JOOMLA_COMPANY_TOKEN": "$JOOMLA_COMPANY_TOKEN",
        "JOOMLA_COMPANY_UPDATE_TOKEN": "$JOOMLA_COMPANY_UPDATE_TOKEN",
        "JOOMLA_MCP_APPROVAL_SECRET": "$JOOMLA_MCP_APPROVAL_SECRET"
      },
      "timeout": 180000,
      "trust": false
    }
  }
}
```

For Streamable HTTP, replace the server entry with:

```json
{
  "mcpServers": {
    "joomla": {
      "httpUrl": "https://mcp.company.example/mcp",
      "timeout": 180000,
      "trust": false
    }
  }
}
```

Use `/mcp` and `/mcp auth joomla` to inspect and authenticate the remote server.
Do not set `trust` to `true` for a write-capable Joomla server.

See <https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html>.

## Grok through the xAI Responses API

Grok’s remote MCP tool connects from xAI infrastructure, so use the HTTPS
endpoint. The bearer token must be a short-lived JWT issued for this MCP
resource; it is not a Joomla token.

```bash
curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${XAI_API_KEY}" \
  -d "{
    \"model\": \"grok-4.5\",
    \"input\": [{
      \"role\": \"user\",
      \"content\": \"List the configured Joomla sites and describe their enabled capabilities.\"
    }],
    \"tools\": [{
      \"type\": \"mcp\",
      \"server_url\": \"https://mcp.company.example/mcp\",
      \"server_label\": \"joomla\",
      \"server_description\": \"JoomEngine MCP for Joomla\",
      \"authorization\": \"${JOOMLA_MCP_ACCESS_TOKEN}\",
      \"allowed_tools\": [
        \"joomla_sites_list\",
        \"joomla_capabilities\",
        \"joomla_actions_search\",
        \"joomla_action_describe\",
        \"joomla_action_read\"
      ]
    }]
  }"
```

The example deliberately allows only discovery and generic read tools. Expand
`allowed_tools` only after testing the server-side permission workflow. xAI
currently supports remote MCP over Streamable HTTP and SSE:
<https://docs.x.ai/developers/tools/remote-mcp>.

## Connection acceptance test

For every client:

1. List tools and confirm the product reports `joomengine-mcp-for-joomla`.
2. Call `joomla_sites_list`; verify that no token or environment value appears.
3. Call `joomla_capabilities` for the configured alias.
4. Run one bounded read.
5. Preview one write with `dryRun: true`; verify that no confirmation token is
   returned.
6. Attempt a non-dry-run plan without a grant; it must direct the AI to
   `joomla_permission_request`.
7. Complete a one-operation permission request and apply one staging mutation.
8. Confirm the grant, plan, use, result, and verification events in the audit
   stream.

