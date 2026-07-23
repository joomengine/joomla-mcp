# Deployment, upgrade, and rollback

## Choose the deployment path

| Need | Recommended path |
|---|---|
| Local developer/desktop MCP client | Source build with stdio |
| Remote API-only edge | Pinned OCI image with Compose or an orchestrator |
| Remote edge as a host service | Source/release build with systemd |
| Joomla-native companion actions | Host deployment with PHP and direct access to the fixed Joomla root |

The shipped OCI image contains the TypeScript HTTP edge, not PHP or a Joomla
installation. It is therefore API-only unless a separately reviewed image and
mount model is introduced. Do not mount a production Joomla root into the
standard edge container expecting companion execution.

## Deployment prerequisites

- Pin a reviewed commit, release tag, or image digest.
- Run all checks in [Testing](TESTING.md).
- Prepare `/etc/joomla-mcp/sites.json` from the example with exact aliases,
  toolsets, API origins, and HTTP authorization settings.
- Keep `mcpPath`, `healthPath`, and `readinessPath` distinct. The defaults are
  `/mcp`, `/healthz`, and `/readyz`.
- Set `shutdownGraceMs` to 1,000–120,000 ms; the default is 30,000 ms. The
  container/service stop timeout must be longer than this grace.
- Put every `tokenEnv`, `updateTokenEnv`, and `approval.secretEnv` value in a
  root/operator-managed secret store or mode `0600` environment file.
- When `approval.grantStorePath` is configured, make its parent writable only
  by the MCP service account. The store file must be a regular mode `0600`
  file. Indefinite grants are rejected unless the durable path is configured.
- Configure a dedicated Joomla actor for each enabled path.
- Keep the HTTP listener private and terminate TLS at a trusted reverse proxy.
- Take tested Joomla filesystem and database backups before enabling writes or
  upgrading the companion.

The uninterrupted single-company procedure is in
[Single-company, single-site deployment](SINGLE_SITE.md). Client configurations
are in [AI client connections](CLIENTS.md).

## Release artifacts and manual release

The release workflow accepts either a pushed `vX.Y.Z` tag or a manual
`workflow_dispatch` from `main`. For a manual release, enter SemVer without the
`v` prefix. The version must already match `package.json` and both Joomla
companion manifests. The workflow validates, builds, attests, and only then
creates the tag and immutable GitHub release.

Each release contains:

- `joomengine-mcp-for-joomla-vX.Y.Z.tgz` — compiled/installable Node server;
- `joomengine-mcp-for-joomla-deployment-vX.Y.Z.tar.gz` — Compose, systemd,
  configuration, operations, and client runbooks;
- `pkg_joomlamcp-X.Y.Z.zip` — Joomla companion package;
- `joomengine-mcp-for-joomla-vX.Y.Z.spdx.json` — source SBOM;
- `SHA256SUMS` — checksums for every downloadable asset;
- an attested OCI image at
  `ghcr.io/<repository-owner>/joomla-mcp:vX.Y.Z`.

The manual release input does not rewrite versions or source. Prepare and merge
the version change before dispatching the workflow.

## Stdio installation

From a verified checkout:

```bash
npm ci
npm run validate
npm run build
JOOMLA_MCP_CONFIG=/absolute/path/to/sites.json npm start
```

Configure the MCP client to launch `dist/bin/joomla-mcp.js` and provide only
environment variable names/values required for that deployment. The stdio
process should run as a dedicated account when it can reach a production site.

## OCI and Docker Compose

Release images are published to `ghcr.io/joomengine/joomla-mcp` by
the tag workflow. Verify provenance and pin the selected image by digest, for
example `ghcr.io/joomengine/joomla-mcp@sha256:<digest>`. Do not use
`latest` for production.

From the repository root:

```bash
cp deploy/sites.container.example.json deploy/sites.json
cp deploy/secrets.env.example deploy/secrets.env
```

Edit both files, then make the non-secret site configuration readable by the
container's fixed UID but not writable, and keep the Compose-consumed secret
file private to its host owner:

```bash
chmod 0444 deploy/sites.json
chmod 0600 deploy/secrets.env
```

Validate the deployment artifacts:

```bash
scripts/deploy/validate.sh
```

Activate an immutable image and wait for its health probe:

```bash
scripts/deploy/compose-rollout.sh apply 'ghcr.io/joomengine/joomla-mcp@sha256:<64-lowercase-hex-digest>'
scripts/deploy/compose-rollout.sh status
docker compose --project-directory deploy --env-file deploy/.release.env -f deploy/compose.yaml logs --tail=100 joomla-mcp
```

The rollout script requires Docker Compose v2, rejects mutable tags, serializes
deployment operations, records the current and previous digest in ignored mode
`0600` state files, and automatically restores the old image if the new service
does not become live and JWKS-ready. Use `scripts/deploy/compose-rollout.sh
rollback` for an operator-requested rollback. The built-in Compose health check
uses shallow `/healthz`; the rollout script separately requires `200
{"status":"ready"}` from `/readyz` before reporting activation success.

The Compose definition binds the public host port to loopback by default,
drops capabilities, uses a read-only filesystem and non-root UID, mounts a
dedicated permission-grant state volume, limits resources, rotates logs, and
performs a bounded health check. Put a TLS reverse
proxy in front of `127.0.0.1:3000`; do not change the bind address to a public
interface without an equivalent network boundary. When `http.requireOrigin` is
true, export `JOOMLA_MCP_HEALTH_ORIGIN` with one exact allowed origin before
running the rollout script so the internal health probe passes the same policy.
If `shutdownGraceMs` is raised above 30 seconds, also raise Compose
`stop_grace_period` above it; otherwise Docker can terminate the process before
its application-level drain completes.

## systemd host service

Build and validate in a non-privileged staging checkout before copying the
finished release into `/opt`; do not run package lifecycle scripts as root:

```bash
npm ci
npm run validate
npm run build
npm prune --omit=dev
```

Use release directories so the executable can be switched back atomically:

Create the unprivileged `joomla-mcp` system account through the operating
system's account-management policy, then:

```bash
sudo install -d -o root -g root -m 0755 /opt/joomla-mcp/releases
sudo install -d -o root -g joomla-mcp -m 0750 /etc/joomla-mcp
```

Copy that verified built tree under `/opt/joomla-mcp/releases/<version>`, then
make every release path root-owned and remove group/other write access:

```bash
sudo chown -R root:root /opt/joomla-mcp/releases/<version>
sudo chmod -R go-w /opt/joomla-mcp/releases/<version>
```

The rollout script also rejects broken links, non-root-owned content, and
symlinks that escape the selected release tree.

Use the rollout script to make `/opt/joomla-mcp/current` an atomic symlink to the
selected release. Install
`deploy/systemd/joomla-mcp.service` as
`/etc/systemd/system/joomla-mcp.service`; copy `deploy/runtime.env.example` to
`/etc/joomla-mcp/runtime.env`, `deploy/secrets.env.example` to
`/etc/joomla-mcp/secrets.env`, and the reviewed site file to
`/etc/joomla-mcp/sites.json`.

```bash
sudo chown root:joomla-mcp /etc/joomla-mcp/sites.json /etc/joomla-mcp/runtime.env /etc/joomla-mcp/secrets.env
sudo chmod 0640 /etc/joomla-mcp/sites.json /etc/joomla-mcp/runtime.env
sudo chmod 0600 /etc/joomla-mcp/secrets.env
sudo systemctl daemon-reload
sudo scripts/deploy/systemd-rollout.sh activate /opt/joomla-mcp/releases/<version>
sudo systemctl enable joomla-mcp.service
sudo systemctl status joomla-mcp.service
```

The activation script records `/opt/joomla-mcp/previous`, restarts the service,
and restores the old release automatically when activation fails. Use
`sudo scripts/deploy/systemd-rollout.sh rollback` to switch current and previous
releases. The startup readiness command must be present in the selected release
and its probe `Host` must exactly match an entry in `http.allowedHosts`. When
`http.requireOrigin` is true, set `JOOMLA_MCP_HEALTH_ORIGIN` in
`/etc/joomla-mcp/runtime.env` to one exact allowed origin. The shipped systemd
unit probes `/readyz`, so activation fails closed when the JWKS dependency is
not ready; `/healthz` remains the separate shallow liveness endpoint. If
`shutdownGraceMs` is raised above 30 seconds, also raise systemd
`TimeoutStopSec` above it.

The systemd unit uses `StateDirectory=joomla-mcp` with mode `0700`, making
`/var/lib/joomla-mcp` the supported persistent grant-store directory even
under `ProtectSystem=strict`.

For companion access, the service account also needs execute/read access to the
fixed PHP binary and Joomla CLI bootstrap plus Unix filesystem ACLs for the
exact Joomla paths it needs. The shipped unit's `ProtectSystem=strict` makes
system paths read-only. If local mutation actions are enabled, copy
`deploy/systemd/joomla-mcp-native.conf.example` to
`/etc/systemd/system/joomla-mcp.service.d/native.conf` and replace its examples
with the narrow cache/log/temporary/media/configuration paths required by the
enabled native actions. Run `systemctl daemon-reload` and repeat live
denial/write/recovery tests. Do not relax `ProtectSystem`, expose a
home-directory Joomla root under `ProtectHome=true`, or grant the whole Joomla
root write access merely to make an action pass.

## Reverse proxy contract

The reverse proxy must:

- terminate HTTPS with a valid certificate;
- forward only to the private Node listener;
- replace untrusted forwarding headers;
- preserve the exact external authority expected in `allowedHosts`;
- preserve streaming request/response behavior and use timeouts compatible with
  MCP sessions;
- apply an outer request/body/concurrency limit no weaker than the edge;
- expose the configured protected-resource metadata path;
- probe the configured `readinessPath` before routing MCP traffic;
- avoid logging bearer tokens or request bodies.

Use `/healthz` only as shallow liveness. `/readyz` warms and validates the
configured JWKS and returns a generic `503` reason `not_ready` on failure.
Joomla API/companion, database, coordination, and audit readiness still require
separate non-mutating checks.

## Upgrade procedure

1. Read the release notes and coverage changes; identify configuration, schema,
   companion, and minimum-runtime changes.
2. Back up Joomla files and database and prove the restore procedure.
3. Retain the current edge image digest/release directory and companion ZIP.
4. Validate the new edge and companion artifacts in disposable Joomla 6.1/6.2
   fixtures with the same enabled toolsets and database family.
5. Install or pull the new artifacts without replacing the active version.
6. Validate configuration with the new code and build/package checks.
7. Drain write clients. Let active writes finish; pending plans will be invalid
   after a process restart and must be re-planned.
8. Upgrade the Joomla companion through Joomla's native extension installer.
   Run `joomla:mcp:describe` and compare action/permission changes.
9. Activate the pinned image digest or release directory with the shipped
   rollout script.
10. Verify liveness, JWKS readiness, authorization denials, catalogue, one safe
    API read, one safe companion read when configured, and audit delivery.
11. Re-enable write clients only after post-upgrade checks pass.

## Rollback procedure

Rollback is an operator-controlled recovery, not an MCP action.

1. Disable write traffic and preserve logs.
2. If Joomla data integrity is uncertain, stop and restore the tested filesystem
   and database snapshot before restarting automation.
3. Run the shipped Compose or systemd rollback command to activate the retained
   digest/release directory.
4. Reinstall the previous companion package through Joomla's native extension
   installer when the package changed. If its upgrade changed persistent data,
   follow that release's database restore instructions.
5. Restart the edge; all old pending plans are invalid and must not be replayed.
6. Repeat the liveness, JWKS readiness, denial, catalogue, safe-read, and audit
   checks.
7. Re-enable reads, then writes, only after Joomla and MCP postconditions pass.

Never roll back only application files after a Joomla/database migration unless
the release notes explicitly establish compatibility.
