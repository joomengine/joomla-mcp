# Operations

## Startup checks

At every start or deployment, confirm:

- configuration parses and every referenced secret exists;
- configured Joomla roots, PHP binaries, and CLI launchers resolve to the
  expected fixed files;
- the HTTP listener is private and its `Host`/`Origin` policy matches the proxy;
- `/healthz` returns shallow liveness and `/readyz` successfully warms/validates
  the configured JWKS;
- token validation works with the expected issuer, audience, and scopes;
- each API origin is HTTPS and answers a safe bounded read;
- `joomla:mcp:describe` reports the expected companion version, action IDs, and
  actor permissions for local sites;
- the audit destination is writable and protected;
- the permission grant store is mode `0600`, writable only by the service
  account, and passes integrity validation;
- write toolsets remain disabled unless their release and site-specific gates
  passed.

## Health and readiness

`GET` or `HEAD /healthz` is deliberately shallow. It establishes that the
process can serve HTTP after Host/Origin policy; it does not probe dependencies.

`GET` or `HEAD /readyz` passes the same Host/Origin policy and warms/validates
the configured JWKS dependency. It returns `200` with `{"status":"ready"}` on
success. Any dependency failure returns a generic `503` reason `not_ready`
without disclosing the JWKS URL, keys, or internal error. Remove an instance
from MCP traffic while readiness fails, but do not restart it solely because an
external authorization service is temporarily unavailable.

Use separate probes for:

- a safe read with the dedicated API actor;
- companion description with the dedicated local actor;
- audit event delivery;
- Joomla's own application and database health.

Do not place downstream mutation probes in liveness or readiness checks.

## Logs and audit

The HTTP process emits operational and audit JSON to stderr. With systemd:

```bash
journalctl -u joomla-mcp.service --since today
journalctl -u joomla-mcp.service -f
```

With Compose:

```bash
docker compose --project-directory deploy --env-file deploy/.release.env -f deploy/compose.yaml logs --tail=200 joomla-mcp
```

Restrict log access and retention. Logs must not contain authorization headers,
Joomla/update tokens, passwords, approval secrets, confirmation tokens, full
request bodies, or unbounded Joomla content. Alert on repeated authentication
or scope denials, rate/session exhaustion, companion capability changes, write
verification failures, process timeout/truncation, JWKS failures, and audit-sink
failure. Retain and alert on permission request, approval, use, and revocation
events.

## Routine maintenance

- Apply supported Node base-image, operating-system, Joomla, PHP, and dependency
  security updates through the tested upgrade procedure.
- Rotate Joomla API/update tokens, OAuth client credentials, and approval
  secrets on a documented schedule and after personnel or trust changes.
- Re-run companion description after Joomla, companion, actor ACL, or plugin
  configuration changes.
- Review site toolsets and OAuth scopes; remove unused permissions.
- Exercise Joomla filesystem/database restore and edge rollback regularly.
- Re-run the supported live matrix before promoting an action or runtime update.
- Verify release artifact digests, SBOM, and provenance before deployment.

## Secret rotation

1. Create the replacement credential at its authority.
2. Update the secret store/environment without changing the public site file
   unless the variable name itself changes.
3. Restart or roll the single edge process.
4. Verify a safe read and required denial cases.
5. Revoke the old credential.

Before rotating the approval secret, revoke active grants, preserve the old
grant store as restricted incident/change evidence, and install a new empty
mode `0600` store. Rotation intentionally invalidates pending write plans and
old persistent grant signatures.
Rotating a Joomla token does not alter inbound MCP authorization, and rotating
OAuth signing keys does not alter the downstream Joomla identity.

## Backup boundaries

The MCP edge is not a Joomla backup system. Back up and restore Joomla through a
tested native/site-operations procedure that includes the filesystem, database,
configuration, media, and extension state. Edge configuration, the signed
permission grant store, and secret-store metadata need their own protected
backup, but raw secrets should follow the secret manager's recovery process.

## Safe shutdown and restart

Drain write traffic before stopping. `SIGTERM` initiates HTTP server shutdown:
new request admission stops, idle connections close, and active connections may
finish for at most `http.shutdownGraceMs`. The default is 30 seconds; the
accepted range is 1–120 seconds. When the grace expires, remaining connections
are force-closed. Configure the service/container stop timeout above the chosen
grace so it does not terminate the process first.

Restart discards in-process sessions, pending permission requests, pending
confirmation plans, locks, idempotency state, and rate state. Active grants
survive only when `grantStorePath` is configured. Clients reconnect and
re-plan; they must not assume an interrupted write failed without checking
Joomla's postcondition.

## Multi-replica boundary

The current process-local coordination is a production boundary. Read-only
replicas may be deployed with an explicit session strategy, but write-enabled
horizontal scaling remains gated until shared locks, idempotency, confirmation,
rate state, replay behavior, session handling, and failure recovery pass the
matrix. Do not rely on best-effort sticky sessions as write integrity.

## Incident runbook

For suspected compromise or unauthorized mutation:

1. disable remote access or the affected toolsets;
2. revoke inbound and downstream credentials;
3. revoke all permission grants, archive and reset the grant store, then rotate the approval secret;
4. preserve redacted proxy, edge, operating-system, Joomla, and database logs;
5. compare deployed artifact digests with release attestations;
6. verify Joomla state through an independent administrator/native path;
7. restore the tested Joomla backup if integrity cannot be established;
8. correct and test the root cause on disposable fixtures before reactivation.
