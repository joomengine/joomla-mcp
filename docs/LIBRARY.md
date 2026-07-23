# Library integration

`@joomengine/joomla-mcp` is both the complete self-hosted server and an
embeddable Node.js library. The command-line binaries, container, systemd
deployment, and host applications all use the same runtime and action
registration code.

## Install

Pin a compatible version in the consuming application:

```bash
npm install @joomengine/joomla-mcp@^0.6.0
```

For exact, reproducible deployments:

```json
{
  "dependencies": {
    "@joomengine/joomla-mcp": "0.6.0"
  }
}
```

The package is ESM-only and requires Node.js 22.12 or newer. Commit the
consumer's lockfile. Do not import `dist/*` files directly; the public package
exports define the compatibility boundary.

Every versioned GitHub release also includes the exact installable npm
tarball. A consumer that cannot reach the npm registry can pin that immutable
release asset:

```json
{
  "dependencies": {
    "@joomengine/joomla-mcp": "https://github.com/joomengine/joomla-mcp/releases/download/v0.6.0/joomengine-mcp-for-joomla-v0.6.0.tgz"
  }
}
```

Verify release assets with the attached `SHA256SUMS` and provenance
attestations.

## Public entry points

| Import | Contract |
|---|---|
| `@joomengine/joomla-mcp` | Application factory, runtime/server factories, configuration resolution, services, audit types, JWKS verifier, and package identity |
| `@joomengine/joomla-mcp/config` | Configuration schemas, types, file loader, and secret-resolver API |
| `@joomengine/joomla-mcp/catalog` | Complete source-backed Joomla action catalogue and resolution helpers |
| `@joomengine/joomla-mcp/adapters` | Joomla API and companion CLI transport contracts and default implementations |
| `@joomengine/joomla-mcp/http` | Authenticated Streamable HTTP gateway, authorization, limits, audit, and request-policy contracts |
| `@joomengine/joomla-mcp/security` | Confirmation, operator grant, fingerprinting, and JWKS verification primitives |
| `@joomengine/joomla-mcp/package.json` | Package metadata for tooling that explicitly needs it |

JavaScript and TypeScript consumers use the same ESM exports. Declaration
files and source maps are included in the package.

## Create an application

Importing the library has no operational side effects. It does not read a
configuration file, inspect environment variables, bind a port, connect a
transport, or register process signal handlers.

```js
import {
  createJoomlaMcp,
  loadConfiguration,
} from '@joomengine/joomla-mcp';

const configuration = await loadConfiguration('/etc/joomla-mcp/sites.json');
const application = createJoomlaMcp({ configuration });
```

The application owns one shared `JoomlaMcpRuntime`. Each call to
`application.createServer()` returns a fresh MCP protocol server backed by
that runtime. This is essential for authenticated HTTP sessions: protocol
connections are isolated while permission grants, write plans, idempotency,
locks, and audit dependencies remain coherent inside the application.

## Resolve secrets through the host

Configuration documents contain secret references, never secret values.
`loadConfiguration` uses `process.env` by default. A host can resolve those
references through its own vault, database, or secret manager:

```js
import {
  loadConfiguration,
} from '@joomengine/joomla-mcp';

const configuration = await loadConfiguration('/etc/joomla-mcp/sites.json', {
  resolveSecret: async ({ name, purpose, site }) => {
    return secretManager.read({
      key: name,
      purpose,
      tenant: site,
    });
  },
});
```

When configuration is already available as an object, avoid temporary files:

```js
import { resolveConfiguration } from '@joomengine/joomla-mcp/config';

const configuration = await resolveConfiguration(rawConfiguration, {
  source: 'tenant configuration',
  resolveSecret: ({ name }) => secretManager.read({ key: name }),
});
```

`RawConfigurationSchema` remains the authority for the object shape and
applies the same strict defaults and validation as file loading. CLI paths are
canonicalized and checked before use.

## Connect stdio

The host owns the transport and lifecycle:

```js
import { createJoomlaMcp } from '@joomengine/joomla-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const application = createJoomlaMcp({
  configuration,
  server: {
    name: 'company-joomla-mcp',
    localPrincipal: 'automation:joomla',
  },
});
const server = application.createServer();

await server.connect(new StdioServerTransport());
```

`localPrincipal` binds operator grants and write confirmations to the
embedding identity when the transport does not provide MCP `AuthInfo`. Use a
stable identity that cannot be selected by an untrusted caller. Remote HTTP
principals always come from the verified JWT.

## Create authenticated HTTP

`application.createHttpServer()` inserts the application server factory into
the complete HTTP gateway. The host supplies identity verification,
authorization, request boundaries, the listener, and shutdown policy:

```js
const verifier = new JwksJwtVerifier({ jwksUrl: http.jwksUrl });
const controller = application.createHttpServer({
  jwtVerifier: verifier,
  authorization: {
    issuer: http.issuer,
    audience: http.audience,
    requiredScopes: http.requiredScopes,
  },
  requestPolicy: {
    allowedHosts: http.allowedHosts,
    allowedOrigins: http.allowedOrigins,
    requireOrigin: http.requireOrigin,
  },
  limits: http.limits,
  readinessCheck: () => verifier.warm(),
});

controller.server.listen(http.port, http.listenHost);
// During host shutdown:
await controller.close();
```

See the complete executable
[HTTP example](../examples/embedded-host/http.mjs) and
[remote HTTP contract](REMOTE_HTTP.md).

## Inject host adapters

The runtime accepts stable host-facing ports:

```js
const application = createJoomlaMcp({
  configuration,
  runtimeOptions: {
    audit: auditSink,
    api: joomlaApiTransport,
    cli: joomlaCliTransport,
  },
});
```

- `AuditSink` receives bounded, secret-free Joomla action and permission
  events.
- `JoomlaApiTransport` performs the fixed, already-resolved Joomla API
  requests.
- `JoomlaCliTransport` performs the fixed companion operations.
- A fully assembled `JoomlaMcpRuntime` may be supplied when a host needs
  complete service construction control.

An adapter does not expand the action surface. Origins, credentials, methods,
paths, commands, and schemas still come from immutable configuration and the
public catalogue. Do not turn an adapter into generic URL, shell, SQL,
filesystem, PHP, or Joomla-model passthrough.

## Isolation and scaling

Create a separate application runtime for every trust boundary. A hosted
service should normally create one runtime per tenant or per isolated site
group and must never share downstream credentials, permission grants, write
plans, or audit identity across tenants.

The default confirmation, idempotency, lock, and session coordination is
process-local. The indefinite-grant store is integrity protected but
file-backed. A write-enabled deployment must therefore route one trust
boundary to one active writer process. Read-only replicas may scale
independently. Multi-writer deployment remains blocked unless the host
provides an architecture with equivalent shared coordination and proves it
against the write and recovery contract.

## Compatibility policy

- Public root and documented subpath exports follow Semantic Versioning.
- Additive tools, catalogue entries, optional fields, and exports are minor
  releases.
- Removing or changing a documented export, required field, tool contract, or
  behavior requires a major release.
- Security corrections may tighten invalid or unsafe input acceptance in a
  patch release.
- Repository source paths and undocumented `dist` paths are not public APIs.
- The npm package, companion ZIP, OCI image, deployment bundle, SBOM, and
  documentation use one synchronized version.

Before upgrading, read the GitHub release notes, update the pinned dependency,
run the consuming application's tests, and exercise the supported Joomla
contract matrix.

## Licensing

The library is `GPL-2.0-or-later`. A consuming application must comply with
the license when it conveys a combined or derivative work. Consult qualified
legal counsel for the distribution model in question.
