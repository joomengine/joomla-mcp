# Security model

This document defines the runtime security contract. Report suspected
vulnerabilities through the private process in [`SECURITY.md`](../SECURITY.md).

## Defaults

- Read-only toolsets by default; write and administration toolsets require explicit configuration.
- Fixed site aliases and adapter locations.
- Dedicated Joomla API identities.
- HTTPS only, redirects rejected.
- No generic HTTP, shell, CLI, PHP, SQL, or filesystem tool.
- Bounded API responses, pagination, CLI output, and execution time.
- Secrets referenced by environment variable and omitted from discovery/audit results.
- Native Joomla ACL and model checks remain authoritative; edge authorization is an additional boundary, not a replacement.

## Threats and controls

| Threat | Required control |
|---|---|
| Prompt injection in Joomla content | Treat all returned content as untrusted data; never derive policy from it |
| Confused deputy | Map authenticated MCP identity to site/toolsets; use dedicated downstream Joomla identities |
| Command injection | Fixed executable/root, argument arrays, no shell, typed action schemas |
| SSRF | Server-configured origins only; reject redirects; bridge actions cannot accept arbitrary URLs |
| Path traversal/symlinks | Canonicalize configured roots at startup; clients never supply paths |
| Secret exfiltration | Environment/secret references, strict configuration allowlist, redacted metadata-only logs |
| Destructive action | Disabled by default; plan/apply approval; site lock; postcondition verification |
| Extension/core-update RCE | Separate privileged toolset and identity; package origin/hash policy; signed approval |
| Cross-site leakage | Immutable request site context; tenant/subject/site/action keyed state |
| Session/token replay | HTTPS, short-lived audience-bound MCP tokens, expiry and rotation |
| DNS rebinding/CORS | Exact Origin/Host validation on the Streamable HTTP transport |
| Denial of service | Rate limits, size/page ceilings, subprocess concurrency limits, timeouts |
| Log leakage | Never log raw authorization, secrets, passwords, or unrestricted payloads |
| Supply-chain compromise | Lockfile, audit, SBOM, signed artifacts and provenance |
| Joomla actor escalation | Dedicated actors, effective companion ACL preflight, explicit Web Services plugin and component permissions |
| Unsafe native lifecycle | Source-backed semantic action, preview/confirmation, postcondition, action-specific rollback and live recovery tests |

## Joomla-specific warnings

- Joomla CLI operates outside the normal Web Services token/ACL boundary.
- `--no-interaction` can skip delete confirmation and is never user approval.
- `config:get` can reveal database and mail credentials and is not exposed.
- Password-bearing CLI options are unsafe because process arguments are visible.
- Extension installation executes PHP and URL installation is also an SSRF surface.
- Database import drops tables before recreating them.
- Joomla Update uses a separate update token and configuration.

The service must run as a dedicated per-site deployment account, never root. Filesystem permissions should cover only the Joomla paths required by enabled actions.

The companion is an adapter around Joomla's dependency-injection container,
ACL, services, models, tables, forms, and events. It must not duplicate Joomla
domain logic or invoke a caller-selected model or method. A stock Joomla CLI
capability becomes remotely usable only after a fixed structured action defines
its input, permission, bounds, postcondition, and recovery behavior.

The local Joomla CLI is a trusted administrative boundary. The companion trusts
the edge-internal `_edgeConfirmed` stdin marker; it cannot validate the edge's
HMAC confirmation token. Restrict login, process execution, sudo, and filesystem
access to the deployment account. Production MCP mutations must enter through
edge plan/apply; companion stdin is not a separately authenticated remote API.

## Least-privilege deployment

1. Create a non-human Joomla API user for each site or trust zone.
2. Put it in a dedicated group that is permitted by the Joomla API Token plugin.
3. Grant `core.login.api` and only the component actions required by configured
   read toolsets.
4. Create a separate companion actor when local actions need different
   permissions; leaving the actor unset must fail closed.
5. Use a separate downstream identity and deployment for privileged toolsets
   where practical.
6. Give remote MCP principals exact site and toolset scopes. Avoid wildcard
   scopes for interactive clients.
7. Run Node and PHP as an unprivileged operating-system user with access only to
   the configured Joomla root and required runtime files.
8. Keep `configuration.php`, secret environment files, tokens, package sources,
   backups, and audit stores unreadable by unrelated accounts.

The site configuration toolsets are an upper bound, inbound OAuth scopes are a
per-principal bound, and Joomla ACL is the downstream bound. All must allow an
operation.

## Controlled writes

- A non-dry write plan requires an active operator grant bound to the authenticated principal, site, and exact write/administration toolset.
- A grant request returns a random exact acknowledgement phrase. The MCP client must show the complete request to the operator and may approve it only after the operator supplies that phrase.
- Grant duration is exactly one operation, 30 minutes, or indefinite until revoked. Indefinite grants are disabled by default and require a mode `0600` integrity-protected persistent store.
- Grant request, approval, use, and revocation emit audit events without the acknowledgement phrase or raw principal.
- A plan validates a fixed action schema and stores the exact operation server-side.
- The returned HMAC-signed token contains only identifiers, expiry, operation fingerprint, and a one-way principal fingerprint; it is short-lived and one-time.
- A remote plan is bound to the authenticated issuer, subject, and client. Apply rechecks the planned site and toolset scopes before the token is consumed.
- Apply executes the stored operation, not caller-supplied replacement fields.
- Idempotency keys, optional ETags, site locks, audit events, and verification reads reduce duplicate and concurrent mutations.
- Current locks and idempotency state are process-local. Multi-replica deployments must provide shared coordination before enabling writes.
- Restarting a single process invalidates pending plans; clients must re-plan rather than replay a previous token. Active grants survive only when `grantStorePath` is configured.

## Remote authorization

The HTTP edge cryptographically verifies JWTs against the configured HTTPS JWKS, then independently validates issuer, resource audience, expiry, not-before, and scopes. A token needs the global configured scope plus a site scope and toolset scope for each operation. Downstream Joomla tokens are never accepted from or passed through the inbound MCP token.

## Toolset activation

Start with `discovery` and the necessary `*.read` toolsets. Enable one write or
administration toolset only after:

- its action IDs and native Joomla path are reviewed;
- the actor's allow and deny cases pass on disposable supported fixtures;
- accepted and rejected schemas are proven;
- success postconditions and cleanup are verified;
- timeout, duplicate, concurrent, partial-failure, and rollback cases pass;
- audit output is complete and secret-free.

`users.admin`, `extensions.admin`, `configuration.write`,
`maintenance.admin`, and `core-update` require separate operational approval.
Database import/export, extension installation/removal, password operations,
core update execution, and similar recovery-sensitive actions remain disabled
until explicitly marked live-verified in the coverage matrix.

## Logging and incident response

Audit events belong on a restricted append-only destination outside returned MCP
content. Monitor authentication denials, site/toolset authorization denials,
rate and session exhaustion, companion capability changes, write plans and
applies, downstream Joomla failures, verification mismatches, and audit-sink
failures.

If compromise is suspected:

1. stop remote traffic or disable the affected toolsets;
2. revoke inbound OAuth tokens and rotate authorization-server signing keys as
   required;
3. revoke and regenerate affected Joomla API and update tokens;
4. revoke active grants, preserve the old grant store for evidence, replace it with an empty mode `0600` store, and rotate the approval secret, which invalidates pending write plans and old grant signatures;
5. preserve redacted edge, reverse-proxy, operating-system, and Joomla logs;
6. compare companion package and OCI image digests with release attestations;
7. restore Joomla through its tested site/database backup process if mutation
   integrity is uncertain;
8. complete a root-cause review before re-enabling writes.
