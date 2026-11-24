# Using Joomla MCP with Joomla Component Builder

On a site with Joomla Component Builder (JCB), use the server to inspect the
commands your installed version of JCB provides. You can also use the usual
Joomla actions, such as listing articles or inspecting menus, on the same site.
JCB is optional for those core actions.

## Connect the server to the JCB site's CLI

1. Install JCB on the Joomla site and enable the JCB console plugin that registers
   its `componentbuilder:` commands.
2. Install this repository's `pkg_joomlamcp` companion, enable its console plugin,
   and choose the MCP actor user. Follow the [companion setup and self-test](PHP_COMPANION.md#build-and-install).
3. Run the Node server on a host with access to that Joomla installation and its
   PHP executable. For example, the following read-only `sites.json` works with a
   Joomla root at `/srv/joomla` and PHP at `/usr/bin/php8.3`. Set both paths to
   the values on the host running Node.

```json
{
  "defaultSite": "localDevelopment",
  "sites": {
    "localDevelopment": {
      "toolsets": ["discovery", "cli.discovery"],
      "cli": {
        "root": "/srv/joomla",
        "phpBinary": "/usr/bin/php8.3"
      }
    }
  }
}
```

Point `JOOMLA_MCP_CONFIG` at the file and [connect your MCP client](CLIENTS.md).
For a remote MCP client, the server on the Joomla host can expose Streamable HTTP.
The caller needs the site scope `joomla:site:localDevelopment` and the
`joomla:toolset:cli.discovery` scope for the two calls below, in addition to the
server's required connection scopes. The published Docker image supports the
Joomla Web Services API. CLI discovery requires a deployment with local PHP and
Joomla. See [deployment options](DEPLOYMENT.md) and [HTTP authentication](REMOTE_HTTP.md).

## Find a command and read its help

In your MCP client, ask “Which JCB admin-view commands are installed on
`localDevelopment`? Show the arguments and options for getting an admin view.”
You can also make these two tool calls directly.

1. Call `joomla_cli_inventory` with `{"site":"localDevelopment"}`. Find names
   beginning with `componentbuilder:` in `data.commands` in the tool result.
   Each entry lists its arguments and options. The installed registry determines
   which names you can inspect.
2. If the inventory lists `componentbuilder:get:admin_view`, call
   `joomla_cli_command_help` with the following arguments. Otherwise choose a
   command name returned by your site.

```json
{
  "site": "localDevelopment",
  "command": "componentbuilder:get:admin_view"
}
```

The help text in `stdout` describes how the installed JCB command works. These
calls read metadata only. If no `componentbuilder:` entries appear, run
`php cli/joomla.php list --no-interaction --no-ansi` from the configured Joomla
root as the same operating-system user and check that site's JCB console plugin.

## Choose a tool for the work

| Task | Where to perform it |
| --- | --- |
| Inspect JCB command names, arguments and options | Use the inventory and help calls above. |
| Read or update Joomla articles, menus and other supported core resources on the JCB site | Enable the relevant core toolsets on the site alias, then search and describe the semantic action. See [MCP tools and use cases](USAGE.md). |
| Work on JCB component definitions, execute JCB package commands or compile a component | Use JCB's administrator interface or the installed JCB CLI. For an MCP workflow with native JCB operations and background jobs, see the [Joomla-native component's JCB setup](https://github.com/joomengine/mcp_component/blob/main/docs/GETTING-STARTED.md#enable-jcb-operations-and-background-jobs). |

The TypeScript server executes only its registered semantic actions. Installing
a JCB console command or enabling a generated component's Web Services plugin
does not add an executable action to this server's catalogue.
