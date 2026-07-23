# Troubleshooting

## JoomEngine fixture fails during bootstrap

Run the fixture with a dedicated diagnostics directory:

```bash
php companion/build.php
JOOMLA_FIXTURE_ARTIFACT_DIR="$PWD/.fixture-artifacts" \
  npm run test:fixture:joomengine
```

Inspect `compose-ps.txt`, `compose.log`, `describe.json`, `self-test.json`,
`cli-list.txt`, `cli-inventory.json`, the bounded `cli-help/` directory,
`dispatch.json`, and `evidence.json`. The harness always removes its volumes unless
`JOOMLA_FIXTURE_KEEP=1` is explicitly set for local debugging.

A companion installation can succeed while its command remains unavailable if
an older package installed the console plugin disabled. Install or upgrade to
0.5.0, then verify `joomla:mcp:describe` as `www-data`. Do not reuse a failed
JoomEngine volume: its extension and configured CLI phases are first-install
only.

Start with the exact process stderr/audit reason, then verify the narrowest
boundary. Do not work around a denial by enabling broad toolsets or granting
Super Users.

## Startup and configuration

| Symptom | Cause | Corrective action |
|---|---|---|
| `Unable to read configuration` | Wrong `JOOMLA_MCP_CONFIG`, owner, or mode | Use an absolute readable path and verify the service account can traverse parent directories |
| `Invalid configuration` | Unknown key, invalid HTTPS URL, alias, scope, or bounds | Compare with `config/sites.example.json`; configuration is strict |
| `Environment variable ... is not set` | A `tokenEnv`, `updateTokenEnv`, or approval secret is absent | Define it in the service secret store and restart; do not put the value in JSON |
| `write approval secret must contain at least 32 bytes` | Weak approval secret | Generate and install a random secret of at least 32 characters/bytes |
| Joomla root/PHP/launcher is not a file or directory | Incorrect or inaccessible fixed local path | Correct the server-side path and permissions; tool calls cannot override it |
| `Remote HTTP is unavailable until the http configuration block is defined` | HTTP entry point started with stdio-only configuration | Add a valid `http` object or run the stdio entry point |
| Invalid or duplicate HTTP paths | `mcpPath`, `healthPath`, and `readinessPath` collide | Configure three distinct canonical paths; defaults are `/mcp`, `/healthz`, `/readyz` |
| Invalid shutdown grace | `shutdownGraceMs` is outside 1,000–120,000 ms | Use the default 30,000 ms or a bounded value and set the outer stop timeout higher |

## HTTP authentication and policy

| Symptom | Cause | Corrective action |
|---|---|---|
| Host/origin forbidden | Proxy authority does not exactly match policy | Preserve the external Host and add only the canonical expected authority/origin |
| `No trusted JWKS key matches` | Unknown `kid`, unsupported algorithm, stale/incorrect JWKS | Verify issuer JWKS, key publication, algorithm, and HTTPS reachability; do not disable verification |
| JWT signature/audience/issuer/time rejection | Wrong token or authorization-server setup | Mint a token for the configured resource audience and issuer with valid times |
| Principal lacks a site/toolset scope | Token is intentionally narrower than the requested operation | Grant only the exact `joomla:site:<alias>` and `joomla:toolset:<name>` scopes required |
| Site listing or apply denied | Missing special scope | Add `joomla:sites:list` or `joomla:writes:apply` only for the principal that needs it |
| Health check fails while process runs | Health request Host differs from `allowedHosts` | Align the health-probe Host and path with the HTTP configuration |
| `/readyz` returns 503 `not_ready` | The configured JWKS cannot be fetched or validated | Check authorization-server/network/TLS/JWKS health in restricted operator logs; the public response intentionally hides dependency details |

## Joomla API

| Symptom | Cause | Corrective action |
|---|---|---|
| HTTP 401 | Token/plugin configuration | Enable both Joomla token plugins, permit the user's group, and rotate/test the token |
| HTTP 403 | Missing `core.login.api` or component ACL | Add the minimum declared Joomla permission to the dedicated actor and preserve the denied-actor test |
| HTTP 404 | Required Web Services plugin disabled or unsupported route | Enable the native plugin for that family and confirm the route in the supported Joomla source |
| Joomla Update token not configured | Action uses Joomla's separate update credential | Define `updateTokenEnv`; do not substitute the normal API token |
| Malformed JSON or response-size error | Joomla/proxy returned unexpected or excessive content | Inspect redacted downstream response/proxy errors and keep the bound; do not increase it blindly |
| Redirect rejected | `baseUrl` or proxy redirects API traffic | Configure the canonical HTTPS site origin; redirects are intentionally not followed |

## Companion and CLI

| Symptom | Cause | Corrective action |
|---|---|---|
| Commands are missing | Package/plugin not installed or enabled | Install the built package, enable the Console plugin, and run Joomla's command list locally |
| `ACCESS_DENIED` | Actor unset or lacks native Joomla ACL | Select a dedicated actor and grant only the declared permission |
| `UNKNOWN_ACTION` / not advertised | Edge and companion versions differ or action is not local | Run `joomla:mcp:describe`, compare action IDs, and upgrade/rollback the pair together |
| Malformed/unsupported protocol response | Output contamination, version mismatch, or plugin failure | Run the exact `--no-interaction --no-ansi` command manually, capture redacted stderr, and verify package integrity |
| Timeout/truncated output | Native operation exceeded configured limits | Inspect Joomla/PHP logs and action bounds; fix the native problem before cautiously changing limits |
| API works but `transport: auto` fails locally | A configured companion is preferred and denies/does not advertise the action | Correct companion/actor parity or explicitly select `api` for an API-backed action |

## Writes

| Symptom | Cause | Corrective action |
|---|---|---|
| Controlled writes unavailable | No approval configuration | Add the approval block and strong secret only after write gates pass |
| No token returned | Request used `dryRun: true` | Review the preview, then issue a separate non-dry plan when approved |
| Token unknown, expired, or used | One-time/short-lived protection worked | Re-read current Joomla state and create a new plan; never retry an old token |
| Another write is in progress | Per-site lock is held | Wait for the bounded operation; inspect a persistent condition instead of bypassing the lock |
| Idempotency key used for another operation | UUID was reused incorrectly | Generate a new UUID for a genuinely different intended mutation |
| Companion did not prove apply | Native result did not meet the edge postcondition | Treat the outcome as uncertain, inspect Joomla independently, and do not retry until reconciled |
| Verification mismatch after API write | Joomla state differs from expected postcondition | Stop writes for the family, preserve evidence, and restore/repair through the tested native path |
| Connections are cut during shutdown | Outer stop timeout expired before application drain | Set Compose `stop_grace_period` or systemd `TimeoutStopSec` above `shutdownGraceMs`; clients must verify interrupted write postconditions |

## CI contracts skip

`npm run test:contract` skips when either `JOOMLA_CONTRACT_BASE_URL` or
`JOOMLA_CONTRACT_TOKEN` is empty. Add both target-specific repository secrets as
described in [Fixtures](FIXTURES.md). A private fixture also needs a dedicated
self-hosted runner with network reachability.

If the issue remains, collect the commit/image and companion digests, Joomla/PHP
and database versions, redacted configuration shape, exact action ID/transport,
error/audit reason, and reproduction steps. Use the private process in
[`SECURITY.md`](../SECURITY.md) if the report may expose a vulnerability.
