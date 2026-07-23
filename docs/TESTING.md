# Testing and release evidence

Testing is divided by what it proves. Passing a narrower layer does not confer
the status of a broader one.

| Layer | Command or job | Evidence |
|---|---|---|
| Type and build | `npm run check`, `npm run build` | TypeScript contracts compile and production output is generated |
| Offline behavior | `npm test` | Complete route catalogue, field allowlists, special schemas, adapter availability, MCP tools, operator permission grants, write controls, release validation, HTTP security, and process boundaries behave against mocks/fixtures |
| Generated action reference | `npm run docs:actions:check` | The 236-action user reference exactly matches the executable catalogue |
| Offline security | `npm run test:security` | Focused authorization, confirmation, and security-boundary checks |
| Companion boundary | `php companion/tests/run.php` | Framing, registry, ACL preflight, allowlists, confirmation, manifests, and source escape-hatch checks |
| Companion package | `php companion/build.php` | Installable package ZIP can be assembled |
| Joomla 6.1 install smoke | `npm run test:fixture:joomengine` | Fresh Joomla 6.1.2/PHP 8.4/MariaDB installs the exact package, validates companion self-test feedback, inventories all 153 installed commands, captures bounded native help for each, dispatches `system.info` as `www-data`, and exposes the authenticated API boundary |
| API read contract | `npm run test:contract` | Configured live Joomla answers all 36 CRUD collection reads plus safe configuration |
| Companion read contract | `npm run test:contract` | Configured local Joomla advertises required actions and executes bounded list/status reads through native services |
| Container build | CI container job | OCI build definition is buildable |
| Release supply chain | Tag or manual workflow | Version-validated server package, deployment bundle, companion ZIP, OCI image, SBOM, checksums, and provenance jobs execute |

The existing live contracts are read-oriented smoke/shape contracts, not
mutation, denial, recovery, database-matrix, or production certification. The
complete release matrix below remains required.

## Local validation

```bash
npm ci
npm run validate
npm run test:security
npm run docs:actions:check
npm audit --omit=dev --audit-level=high
php companion/tests/run.php
php companion/build.php
```

With Docker and Compose v2 available, also run the blocking Joomla 6.1 package
installation smoke gate:

```bash
npm run test:fixture:joomengine
```

The default lane uses JoomEngine's `octoleo/joomengine:6` stable-major label
(currently JCB 6.1.6, Joomla 6.1.2, and PHP 8.4), pinned to its validated image
digest, plus an immutable MariaDB 11.4 digest. The lane records the resolved
registry digests and package SHA-256 in a non-secret evidence file. Every run
starts with new volumes and always
removes them because JoomEngine's extension and CLI environment variables are
first-install bootstrap facilities.

The bootstrap hook runs only the companion-owned `joomla:mcp:describe`,
`joomla:mcp:self-test`, and `joomla:mcp:cli-inventory` commands through
`JOOMLA_CLI_COMMANDS`, then validates their feedback. The inventory uses
Joomla's installed command registry and records command, argument, and option
metadata without executing discovered commands. Post-start, the fixture runs
only Joomla's fixed `list` and `help <command>` discovery paths for all 153
installed commands—38 core, 111 Component Builder, and four companion
commands—under per-command time and output bounds. It never invokes a discovered
mutation. Structured dispatch requests still travel over stdin, and post-start
assertions explicitly execute as `www-data`. Never place MCP/client/model input
in the JoomEngine command environment.

Do not run mutation or maintenance tests against a production Joomla site.

## Live API smoke contract

Export credentials for one disposable site and run:

```bash
export JOOMLA_CONTRACT_BASE_URL='https://joomla-fixture.example'
export JOOMLA_CONTRACT_TOKEN='redacted-fixture-token'
npm run test:contract
```

If either value is absent, the suite intentionally skips. The URL is the Joomla
site origin, not `/api/index.php`; the adapter adds the API path. Use a token for
a disposable least-privilege fixture actor.

To activate the local companion contract on a host or self-hosted runner with
filesystem access to the disposable Joomla installation:

```bash
export JOOMLA_CONTRACT_ROOT='/srv/joomla-fixture'
export JOOMLA_CONTRACT_PHP_BINARY='/usr/bin/php8.3'
npm run test:contract
```

If either local value is absent, the companion contract skips. The suite checks
that the installed package advertises every edge-required CRUD/operational
action and executes the safe list/status set; it does not execute writes.

The CI job recognizes:

- `JOOMLA_61_CONTRACT_BASE_URL` and `JOOMLA_61_CONTRACT_TOKEN`;
- `JOOMLA_62_CONTRACT_BASE_URL` and `JOOMLA_62_CONTRACT_TOKEN`;
- `JOOMLA_70_CONTRACT_BASE_URL` and `JOOMLA_70_CONTRACT_TOKEN`.

Joomla 6.1 and 6.2 are blocking targets. Joomla 7 is a permitted-failure canary.
GitHub-hosted runners must be able to resolve and reach the fixture over HTTPS.
For a fixture behind a firewall, use a dedicated self-hosted runner on the same
trusted network; do not expose Joomla administration merely to satisfy CI.

The hosted JoomEngine lane removes the external-fixture requirement for the
Joomla 6.1 package-install and safe companion smoke checks only. Authenticated
API action contracts, Joomla 6.2, PostgreSQL, least-privilege denial, mutations,
rollback, and recovery still require their dedicated fixtures.

## Required per-action live contract

Each semantic action must prove:

1. its catalogue route or companion action matches the supported Joomla source;
2. its least-privilege actor succeeds;
3. an actor missing the declared ACL is denied;
4. valid minimum and representative inputs succeed;
5. unknown, missing, oversized, and forbidden fields fail closed;
6. result normalization and pagination bounds are correct;
7. writes trigger Joomla's native validation/events and reach the documented
   state;
8. a verification read confirms the postcondition;
9. missing, wrong-principal, wrong-site, wrong-toolset, expired, revoked, and
   consumed permission grants fail closed;
10. duplicate idempotency keys and reused/expired confirmation tokens cannot
   repeat the mutation;
11. created fixture data is removed through the documented cleanup path.

Delete, state, update, extension, database, password, configuration, scheduler,
and cache actions also require timeout, partial-failure, retry, concurrency,
rollback, and restore cases appropriate to their native Joomla lifecycle.

## Compatibility matrix

The production gate requires at least:

| Dimension | Required targets |
|---|---|
| Joomla | Current supported 6.1 release and current supported 6.2 release |
| Canary | Current 7.0 development/release target; non-blocking until supported |
| PHP | Joomla-supported PHP versions, beginning with 8.3 |
| Database | MySQL/MariaDB and PostgreSQL versions supported by the target Joomla release |
| Transport | stdio and Streamable HTTP |
| Joomla path | API-only, companion-only, and dual-path actions |
| Permission | allowed actor and denied actor |
| Deployment | package install/upgrade/uninstall; OCI/systemd start/restart/rollback |
| Failure | downstream timeout, malformed response, process truncation, lost connection, restart, and audit failure |
| Scale | bounded load, rate/concurrency/session exhaustion, and multi-replica replay/coordination |

Store the exact Joomla commit/release, PHP version, database/version, package
digest, edge commit/image digest, actor ACL, and test result with the release
evidence. Never store tokens or fixture content containing personal data.

## Documentation gate

After an action changes, update [coverage](COVERAGE.md), schemas/examples, native
source references, security/rollback notes, and operator procedures. Mark it
**live-verified** only when the retained matrix evidence supports that claim.
