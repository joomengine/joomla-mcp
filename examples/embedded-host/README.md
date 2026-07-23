# Embedded host example

These ready-to-run examples consume `@joomengine/joomla-mcp` as a normal npm
dependency. They do not import repository source files or internal `dist`
paths.

Install the example:

```bash
cd examples/embedded-host
npm install
```

Copy and edit the repository's site configuration, then export the secret
variables referenced by `tokenEnv`, `updateTokenEnv`, and
`approval.secretEnv`:

```bash
export JOOMLA_MCP_CONFIG=/absolute/path/to/sites.json
node stdio.mjs
```

For authenticated Streamable HTTP, include the documented `http` block and
run:

```bash
node http.mjs
```

`stdio.mjs` demonstrates an explicitly named local principal.
`http.mjs` demonstrates a host-owned listener, JWT verifier, request policy,
graceful shutdown, and one shared Joomla MCP runtime for all HTTP sessions.
The complete integration contract is in [docs/LIBRARY.md](../../docs/LIBRARY.md).
