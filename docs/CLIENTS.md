# AI client connections

Configure a Joomla site alias and credentials using the [npm quick start](../README.md)
or the [single-site source installation](SINGLE_SITE.md). With **stdio**, your MCP client starts the
server and communicates over its standard input and output. With **Streamable
HTTP**, the client connects to an already running instance at its HTTPS
`/mcp` endpoint. Either transport can reach a remote Joomla site through its
Web Services API.

The server reads Joomla credentials from its own environment. Remote clients
authenticate to the MCP server with a token from its OAuth issuer. Keep the
Joomla API token, any Joomla Update token, and the approval secret on the
server.

## Compatibility matrix

| Client | Local stdio | Streamable HTTP | Authentication |
|---|---:|---:|---|
| ChatGPT custom MCP server (HTTPS connection) | — | Yes | OAuth through your configured issuer |
| Codex CLI/app/IDE | Yes | Yes | Inherited environment, bearer-token variable, or OAuth |
| Claude Code | Yes | Yes | Inherited environment, headers, or OAuth |
| Claude Desktop | Yes | Remote connector separately | Local process environment or connector OAuth |
| Gemini CLI | Yes | Yes | Inherited environment, headers, or OAuth discovery |
| Grok/xAI Responses API | No | Yes | Bearer token passed as the MCP `authorization` value |

The local examples assume a checkout built with `npm ci && npm run build`
at `/opt/joomla-mcp`, a site file at `/etc/joomla-mcp/sites.json` and the
`company` alias from the [read-only example](../config/sites.single-site-readonly.example.json).
Use the absolute paths and secret variable names from your installation. If
you installed the npm executable on your PATH, you can use the absolute path
reported by `command -v joomla-mcp` as the stdio command and omit the script
argument. For HTTP examples, substitute your public MCP endpoint for
`https://mcp.company.example/mcp`.

## ChatGPT

1. Deploy the [authenticated HTTP endpoint](REMOTE_HTTP.md). Configure its
   public URL, OAuth issuer, audience and protected-resource metadata URL.
2. In ChatGPT's custom MCP server setup, enter the HTTPS endpoint and select
   OAuth. Complete your issuer's login and check the discovered Joomla tools.
3. Install and select the connection in a conversation. Ask it to list up to
   five Joomla articles on the configured site. Workspace permissions govern
   access to custom servers. See [OpenAI's custom MCP server instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Codex CLI, app, and IDE extension

These surfaces share `~/.codex/config.toml`.

Local stdio:

```toml
[mcp_servers.joomla]
command = "/usr/bin/node"
args = ["/opt/joomla-mcp/dist/bin/joomla-mcp.js"]
env = { JOOMLA_MCP_CONFIG = "/etc/joomla-mcp/sites.json" }
env_vars = ["JOOMLA_COMPANY_TOKEN"]
default_tools_approval_mode = "writes"
required = true
tool_timeout_sec = 180
```

Remote HTTP:

```toml
[mcp_servers.joomla]
url = "https://mcp.company.example/mcp"
default_tools_approval_mode = "writes"
required = true
tool_timeout_sec = 180
```

Run:

```bash
codex mcp list
codex mcp login joomla
```

Use the login command for HTTP with OAuth. For stdio, start Codex with the
Joomla token set and add any other variables referenced by your site file to
`env_vars`. See [Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Claude Code

Local stdio:

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  joomla \
  --env JOOMLA_MCP_CONFIG=/etc/joomla-mcp/sites.json \
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
prompted. A JSON configuration for this endpoint uses `"type": "http"`.
See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).

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

If the desktop launcher filters environment variables, save the required
values in a private Node environment file readable by the desktop account
(mode `0600` on Unix). Insert `--env-file=/absolute/path/to/client.env` as
the first Node argument, before the path to the built script. For a remote
Claude connector, provide an HTTPS endpoint reachable from Anthropic's
infrastructure.

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
        "JOOMLA_COMPANY_TOKEN": "$JOOMLA_COMPANY_TOKEN"
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

See [Gemini CLI's MCP guide](https://geminicli.com/docs/tools/mcp-server/).

## Grok through the xAI Responses API

Grok's remote MCP tool connects from xAI infrastructure. Set `XAI_MODEL` to
a model available to your xAI account that supports remote MCP. Set
`XAI_API_KEY` to your xAI key and `JOOMLA_MCP_ACCESS_TOKEN` to a short-lived
JWT from the MCP server's issuer with the discovery scopes for your site.

```bash
curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${XAI_API_KEY}" \
  -d "{
    \"model\": \"${XAI_MODEL:?Set XAI_MODEL to a model with remote MCP support}\",
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

The example allows only discovery and generic read tools. See
[xAI's remote MCP reference](https://docs.x.ai/developers/tools/remote-mcp).

## Verify the connection

Open the client’s tool list and look for `joomla_sites_list`. Calling it with
`{}` should return `defaultSite` and the configured aliases. Then run the
[first article read](USAGE.md#read-your-first-articles) to check the connection
all the way through to Joomla. An empty article list is a successful response
on a fresh site. For a site configured only for CLI discovery, use the
[installed command inventory](CLI.md) instead.

If the tools appear but an API read fails, check the site's `content.read`
toolset, the Content Web Services plugin, and the Joomla token supplied to
the server process. For HTTP, confirm the JWT also carries the required site
and toolset scopes. See [troubleshooting](TROUBLESHOOTING.md) and
[remote scopes](USAGE.md#remote-scopes). To test an intentional change on a
write-enabled staging site, follow the [guarded write example](USAGE.md#generic-write-example).

