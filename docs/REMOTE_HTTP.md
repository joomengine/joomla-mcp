# Remote Streamable HTTP

The HTTP entry point exposes MCP Streamable HTTP at the configured `mcpPath`.
The stdio entry point remains a separate process and does not require this
authorization configuration.

## Required configuration

Copy the `http` object from `config/sites.example.json` and set:

- `listenHost` and `port` to a private listener;
- `mcpPath`, `healthPath`, and `readinessPath` to three distinct paths;
- `shutdownGraceMs` to the maximum graceful connection-drain interval (default
  30,000 ms; accepted range 1,000–120,000 ms);
- `allowedHosts` to the exact external authority, including a non-default port;
- `allowedOrigins` to approved browser origins, if any;
- `issuer`, `audience`, and `jwksUrl` to the external authorization server;
- `resourceMetadataUrl` to this service's HTTPS protected-resource metadata URL;
- `requiredScopes` to the global MCP access scope;
- `limits` according to measured workload and available memory.

All issuer, audience, JWKS, metadata, and browser-origin URLs must use HTTPS.
The gateway validates access tokens but does not issue them and does not use a
Joomla API token as an inbound MCP credential.

An accepted token needs all applicable scopes:

| Operation | Required scope |
|---|---|
| Enter the service | Every value in `http.requiredScopes` |
| List site aliases | `joomla:sites:list` |
| Access one site | `joomla:site:<alias>` or `joomla:sites:*` |
| Use one toolset | `joomla:toolset:<toolset>` or `joomla:toolsets:*` |
| Request, approve, or revoke a permission | `joomla:permissions:grant` |
| List active permissions | `joomla:permissions:read` |
| Apply a planned write | `joomla:writes:apply` |

Use narrow site and toolset scopes for people and clients. Wildcard scopes are
appropriate only for separately controlled operator identities.

## Security contract

- `Host` is required and must match an exact configured value, including the port when one is present. Wildcards are not supported.
- An `Origin`, when supplied, must be a canonical exact match. Set `requireOrigin: true` for browser-only deployments; non-browser MCP clients commonly omit it.
- Every `/mcp` request requires one structurally valid Bearer JWT. The injected `JwtCryptographicVerifier` is the cryptographic trust boundary: it must verify the signature and trusted key and reject unsupported algorithms before returning claims.
- The gateway then independently enforces the configured issuer, audience, expiry, not-before time, and every required scope. It never treats decoded, unverified claims as authenticated.
- When `resourceMetadataUrl` is configured, its exact path serves unauthenticated RFC 9728 metadata and authentication challenges reference that URL. The advertised resource, authorization server and scopes come from the same authorization policy used for validation.
- Stateful MCP sessions use a cryptographically random SDK v1 session ID, a fresh `McpServer` instance and transport per session, principal binding, idle expiry, absolute lifetime, and a bounded session table.
- SSE resumability can be enabled with an isolated `eventStoreFactory`; without one, replay after a disconnected stream is intentionally unavailable.
- Body size and read time, header size, global/per-principal concurrency, per-principal token-bucket rate, and session count are bounded.
- Audit events contain request IDs, principals, session IDs, outcomes and stable reason codes. They never contain the bearer token or request body.
- `/healthz` is intentionally shallow and unauthenticated. It still passes Host/Origin checks and reports no configuration, downstream state, or secrets.
- `/readyz` is unauthenticated but passes the same Host/Origin policy. `GET` or
  `HEAD` warms and validates the configured HTTPS JWKS dependency. Success is
  `200 {"status":"ready"}`. Failure is a generic `503` with reason
  `not_ready`; no JWKS URL, response, key, or internal error is disclosed.
- Tool calls additionally require `joomla:site:<alias>` plus `joomla:toolset:<toolset>` (or `joomla:sites:*` plus `joomla:toolsets:*`). Site discovery, permission management, permission listing, and write apply require `joomla:sites:list`, `joomla:permissions:grant`, `joomla:permissions:read`, and `joomla:writes:apply` as applicable. A permission request and write plan are bound to the issuer/subject/client. Approval and apply recheck their site and toolset scopes before activating or consuming state.

Terminate TLS at a trusted reverse proxy, clear inbound forwarding headers, preserve the original allowed `Host`, and do not expose the Node listener directly to an untrusted network. Distributed replicas need a shared session/rate strategy or session affinity; the included stores are process-local.

## Integration

The shipped entry point wires the gateway to the Joomla server factory and the fixed HTTPS JWKS verifier. The equivalent programmatic integration is:

```ts
import { createRemoteHttpServer } from '../http/index.js';
import { createServer } from '../mcp/create-server.js';
import { JwksJwtVerifier } from '../security/jwks-jwt-verifier.js';

const productionVerifier = new JwksJwtVerifier({
  jwksUrl: 'https://identity.example.org/.well-known/jwks.json',
});

const remote = createRemoteHttpServer({
  createMcpServer: () => createServer(configuration),
  jwtVerifier: productionVerifier,
  authorization: {
    issuer: 'https://identity.example.org',
    audience: 'https://joomla-mcp.example.org',
    requiredScopes: ['mcp:access'],
  },
  requestPolicy: {
    allowedHosts: ['joomla-mcp.example.org'],
    allowedOrigins: ['https://approved-client.example.org'],
  },
  resourceMetadataUrl: 'https://joomla-mcp.example.org/.well-known/oauth-protected-resource',
  readinessPath: '/readyz',
  readinessCheck: () => productionVerifier.warm(),
  shutdownGraceMs: 30_000,
  audit: productionAuditSink,
});

remote.server.listen(3000, '127.0.0.1');
```

The gateway validates access tokens but does not mint them. Configure the external authorization server for the resource audience and Joomla site/toolset scopes. Put session affinity or shared session/event infrastructure in front of multiple replicas before horizontal scaling.

## Operations

Use `/healthz` for liveness and `/readyz` for the configured JWKS readiness
dependency. Joomla API/companion, database, coordination, and audit readiness
still require separate non-mutating checks. Monitor readiness failures, reject
reason codes, audit-sink health, active connections, session capacity, and
event-loop latency. Rotate JWT signing keys through the verifier's trusted JWKS
cache and fail closed when a key cannot be validated.

Before exposing the endpoint:

1. validate configuration and run the offline security suite;
2. bind Node to loopback or a private service network;
3. terminate TLS at a maintained reverse proxy;
4. replace forwarded headers rather than trusting arbitrary inbound values;
5. preserve the exact external `Host` expected by `allowedHosts`;
6. test a valid token, wrong audience, wrong issuer, expired token, missing site
   scope, missing toolset scope, forbidden host, and forbidden origin;
7. verify that request IDs and denial reasons reach the audit destination without
   tokens or request bodies.

On shutdown, admission stops before drain begins. Idle connections close
immediately; active connections may finish for at most `shutdownGraceMs`, after
which the server force-closes them. Size the service manager/container stop
timeout above that value. Restart drains in-memory sessions and invalidates
pending write plans. Clients must reconnect, verify any interrupted operation,
and re-plan. Do not enable write traffic on multiple replicas until shared
confirmation/idempotency/lock state and the chosen session strategy have passed
failure and replay tests.
