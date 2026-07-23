# AI client connections

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
| ChatGPT desktop app | Yes | Yes | Inherited environment for stdio; OAuth for HTTP |
| ChatGPT web | No | Yes | OAuth through a developer-mode or published plugin |
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

## ChatGPT desktop app

Open **Settings → MCP servers → Add server**.

For a local installation:

- Name: `JoomEngine MCP for Joomla`
- Transport: `STDIO`
- Command: `/usr/bin/node`
- Arguments: `/opt/joomla-mcp/dist/bin/joomla-mcp.js`
- Environment: `JOOMLA_MCP_CONFIG=/etc/joomla-mcp/sites.json`

Ensure the ChatGPT desktop process inherits every secret environment variable
referenced by `sites.json`. Save, restart the app, and use `/mcp` to verify the
connection.

For a remote installation, choose **Streamable HTTP**, enter
`https://mcp.company.example/mcp`, save, restart, and select **Authenticate**.

OpenAI’s current MCP client instructions are maintained at
<https://developers.openai.com/codex/mcp>.

## ChatGPT web

ChatGPT web does not read the local configuration. The server must be available
through HTTPS Streamable HTTP and a standards-compliant OAuth flow.

For an in-house beta:

1. Enable Developer mode in **Settings → Security and login**.
2. Open **Settings → Plugins**.
3. Create a developer-mode app named **JoomEngine MCP for Joomla**.
4. Enter `https://mcp.company.example/mcp`.
5. Complete OAuth, inspect the discovered tools, and test in a new chat.

ChatGPT has its own app-level confirmation policy. That client policy is
additional to the MCP server’s principal-bound Joomla permission grant; it does
not replace the server-side grant.

See <https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>.

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

