# Deployment, upgrade, and rollback

The Node.js MCP server runs on the client machine or on a host you manage. It
connects to Joomla over Web Services, through the local companion, or both.

## Choose the deployment path

| Need | Recommended path |
|---|---|
| Local developer/desktop MCP client | Node.js stdio process launched by the client |
| Remote API-only edge | Pinned OCI image with Compose or an orchestrator |
| Remote edge as a host service | Source/release build with systemd |
| Joomla-native companion actions | Host deployment with PHP and direct access to the fixed Joomla root |

The shipped OCI image runs the Node.js HTTP server and connects to Joomla
over the Web Services API. For companion actions, run Node.js on a host with
PHP and local access to the Joomla installation.

## Deployment prerequisites

- Pin a reviewed commit, release tag, or image digest.
- Run all checks in [Testing](TESTING.md).
- Prepare the site file for your deployment with the intended aliases,
  toolsets and API origins. For HTTP clients, also set the authorization and
  listener options.
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

For a local client, start with the [single-site walkthrough](SINGLE_SITE.md)
and the [client configuration examples](CLIENTS.md).

## Obtain a release

Choose the version you want to deploy from the [GitHub releases](https://github.com/joomengine/joomla-mcp/releases).
The matching deployment bundle contains the Compose file, systemd unit,
configuration examples and rollout scripts. For the systemd build below, use
a full source checkout. The npm package can also be
installed by version from the registry.

Each release contains:

- `joomengine-mcp-for-joomla-vX.Y.Z.tgz` — compiled/installable Node server;
- `joomengine-mcp-for-joomla-deployment-vX.Y.Z.tar.gz` — Compose, systemd,
  configuration, operations, and client runbooks;
- `pkg_joomlamcp-X.Y.Z.zip` — Joomla companion package;
- `joomengine-mcp-for-joomla-vX.Y.Z.spdx.json` — source SBOM;
- `release-manifest.json` — exact source, package, image, and asset identities;
- `SHA256SUMS` — checksums for every downloadable asset;
- an attested OCI image at
  `ghcr.io/joomengine/joomla-mcp:X.Y.Z` and `:vX.Y.Z`.

Verify the assets against their release checksums. Maintainers can find
publication and recovery procedures in [Versioning and releases](RELEASING.md).

## Stdio installation

The MCP client launches the stdio process. Build a verified checkout with
Node.js 22.12 or newer:

```bash
npm ci
npm run validate
```

Use the absolute path to Node as the client’s `command`, the absolute path to
`dist/bin/joomla-mcp.js` as its argument, and set `JOOMLA_MCP_CONFIG` to the
site file. Pass the environment variables referenced by that file to the child
process. For a read-only site, follow the
[single-site walkthrough](SINGLE_SITE.md) through its first Joomla article read.

## OCI and Docker Compose

Release images are published to `ghcr.io/joomengine/joomla-mcp` with tags
aligned to the npm version:

| Tag | Meaning |
|---|---|
| `0.8.0` and `v0.8.0` | Immutable tags for the same 0.8.0 release digest |
| `sha-<commit>` | Immutable image built from the exact release commit |
| `latest` | Latest verified stable release |
| `next` | Latest verified prerelease; does not change `latest` |

The workflow promotes `latest` or `next` only after verifying the matching npm
version's integrity and channel, and rejects channel version regressions.
Verify provenance and pin production deployments by digest, for example
`ghcr.io/joomengine/joomla-mcp@sha256:<digest>`. The moving channel tags are
convenient for discovery; the rollout script requires an immutable digest.

Use a Linux host with Docker Compose v2, Node.js for the readiness probe, and
a TLS reverse proxy. From the repository or extracted deployment bundle root:

```bash
cp deploy/sites.container.example.json deploy/sites.json
install -m 0600 deploy/secrets.env.example deploy/secrets.env
```

Set `sites.production.api.baseUrl` to your Joomla installation URL. For an
initial read-only deployment, keep `discovery` and `content.read` in the site
toolsets and remove the top-level `approval` object. Supply the Joomla token in
`deploy/secrets.env` under the name in `api.tokenEnv`. If you keep the example’s
write toolsets and approval block, also set `JOOMLA_MCP_APPROVAL_SECRET` to a
persistent random secret of at least 32 characters.

Configure the `http` block for your public MCP hostname and OAuth issuer. Keep
`listenHost` at `0.0.0.0` inside the container so the published host port
reaches it. The supplied Compose file binds that port to host loopback. Keep
the internal health-probe Host in `allowedHosts` alongside the public hostname,
or set `JOOMLA_MCP_HEALTH_HOST` for both probes to an allowed value.

Compose mounts `deploy/sites.json` read-only at `/run/joomla-mcp/sites.json`.
The file contains secret names and must be readable by UID 10001.

```bash
chmod 0444 deploy/sites.json
chmod 0600 deploy/secrets.env
```

When working from a full checkout, run `npm ci` and
`scripts/deploy/validate.sh` to check the deployment artifacts. To roll out the
image, obtain the verified `release-manifest.json` from your chosen release.
With that manifest in the current directory, read its digest using `jq` and
wait for the service to become ready.

```bash
image_digest="$(jq -er '.oci.digest' release-manifest.json)"
scripts/deploy/compose-rollout.sh apply "ghcr.io/joomengine/joomla-mcp@${image_digest}"
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

The shipped unit expects Node.js 22.12 or newer at `/usr/bin/node`. Build in a
non-privileged staging checkout before copying the finished release into `/opt`.

```bash
npm ci
npm run validate
npm prune --omit=dev
```

On a Linux host using `groupadd` and `useradd`, create the unprivileged service
account and group. Install the verified runtime and readiness probe in a release
directory named for the checked-out commit. Run these commands from the checkout.

```bash
getent group joomla-mcp >/dev/null || sudo groupadd --system joomla-mcp
id -u joomla-mcp >/dev/null 2>&1 || sudo useradd --system --gid joomla-mcp \
  --home-dir /nonexistent --shell /usr/sbin/nologin joomla-mcp

release_dir="/opt/joomla-mcp/releases/$(git rev-parse HEAD)"
sudo install -d -o root -g root -m 0755 "$release_dir"
sudo install -d -o root -g joomla-mcp -m 0750 /etc/joomla-mcp
sudo cp -a dist node_modules package.json scripts "$release_dir/"
sudo chown -R root:root "$release_dir"
sudo chmod -R go-w "$release_dir"
```

The rollout script also rejects broken links, non-root-owned content, and
symlinks that escape the selected release tree.

For a first installation, start with the single-site read-only configuration
and set the Joomla URL. Add the top-level `http` block from
[`config/sites.example.json`](../config/sites.example.json), set the real OAuth
and public URLs, and keep the host listener on loopback. Set
`JOOMLA_MCP_HEALTH_HOST` in `runtime.env` to an exact `http.allowedHosts` entry.
Place the Joomla token in `secrets.env` under the name in `api.tokenEnv`
(`JOOMLA_COMPANY_TOKEN` for the single-site example).

```bash
sudo install -m 0644 deploy/systemd/joomla-mcp.service /etc/systemd/system/joomla-mcp.service
sudo install -o root -g joomla-mcp -m 0640 config/sites.single-site-readonly.example.json /etc/joomla-mcp/sites.json
sudo install -o root -g joomla-mcp -m 0640 deploy/runtime.env.example /etc/joomla-mcp/runtime.env
sudo install -o root -g root -m 0600 deploy/secrets.env.example /etc/joomla-mcp/secrets.env
sudoedit /etc/joomla-mcp/sites.json /etc/joomla-mcp/runtime.env /etc/joomla-mcp/secrets.env
sudo systemctl daemon-reload
sudo scripts/deploy/systemd-rollout.sh activate "$release_dir"
sudo systemctl enable joomla-mcp.service
sudo systemctl status joomla-mcp.service
```

On later rollouts retain the site and environment files. The rollout script
switches `/opt/joomla-mcp/current` to the selected release directory.

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

After upgrading, request a fresh operator grant for remote clients whose OAuth
subject or client ID contains a colon. The server now binds these grants and
job receipts to a hash of the issuer, subject and client ID.

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
