# Disposable Joomla fixture setup

The live matrix must use installations owned by the project or explicitly
authorized for destructive testing. Never point contract tests at a production
site.

## Repository-managed Joomla 6.1 live fixture

The repository includes a blocking, disposable JoomEngine fixture for the first
live gate:

```bash
php companion/build.php
npm run test:fixture:joomengine
```

It follows JoomEngine's `octoleo/joomengine:6` stable-major tag, currently JCB
6.1.6, Joomla 6.1.2, and PHP 8.4, with MariaDB 11.4. CI pins the validated `:6`
image digest after an intentional image upgrade. The fixture:

1. creates isolated Joomla and database volumes with generated credentials;
2. mounts the exact built companion ZIP read-only;
3. installs it through JoomEngine's `JOOMLA_EXTENSIONS_PATHS` bootstrap;
4. runs companion-owned description, self-test, and CLI-inventory commands through
   `JOOMLA_CLI_COMMANDS` and validates their machine-readable feedback;
5. independently describes, self-tests, inventories the installed Joomla CLI,
   captures native `list` output and `help <command>` for every installed command,
   and dispatches the companion as `www-data`;
6. confirms the content Web Services route enforces authentication;
7. creates a throwaway API token and a host CLI bridge scoped to the fixture;
8. runs the packaged full live suite through API and companion CLI over stdio
   and Streamable HTTP;
9. uploads redacted Markdown, JSON, JUnit, per-action, Joomla, PHP, MCP, and
   container evidence; and
10. always destroys the disposable volumes.

JoomEngine's extension and CLI variables execute only during its first
successful Joomla installation. Never reuse a failed fixture volume: the
upstream image removes Joomla's installation directory before its extension and
command phase, so a partial bootstrap is not retryable. The harness therefore
requires container state, configuration, HTTP health, command logs, JSON
responses, and runtime versions instead of trusting container startup alone.

The JoomEngine entrypoint currently performs bootstrap PHP commands as its
entrypoint user even though its documentation describes `www-data`. This is
acceptable only inside the isolated disposable smoke fixture. All independent
companion checks explicitly use `www-data`, and this lane is not evidence for a
production operating-system least-privilege boundary.

The default keeps the requested `octoleo/joomengine:6` label and pins the
validated registry digest. Set `JOOMLA_FIXTURE_IMAGE` and
`JOOMLA_FIXTURE_DATABASE_IMAGE` to new immutable digest references only when
deliberately validating an image upgrade. Set
`JOOMLA_FIXTURE_ARTIFACT_DIR` to retain bounded diagnostics and evidence.
`JOOMLA_FIXTURE_KEEP=1` is available for local debugging only; never use it in
CI.

The API token is captured in a mode-0600 temporary file, exported only to the
live-test process, deleted before evidence generation completes, and covered by
recursive report redaction. MariaDB remains exclusively on the internal fixture
network. Joomla also joins a dedicated bridge edge because Docker suppresses
published ports for containers attached only to an internal network; that edge
publishes only an ephemeral loopback listener and no database port. Full runner
usage, safety controls, statuses, and failure investigation are documented in
[Live Joomla validation](LIVE_TESTING.md).

## Fixture set

Provision separate, resettable installations for:

- current Joomla 6.1 on a supported MySQL/MariaDB database;
- current Joomla 6.2 on a supported MySQL/MariaDB database;
- the same supported releases on PostgreSQL;
- a Joomla 7 canary that may fail without blocking release.

Use distinct domains, databases, Joomla secrets, API tokens, companion actors,
and operating-system accounts. Take a clean filesystem and database snapshot
after Joomla installation and before installing the companion. The fixture must
be restorable without relying on MCP.

## Joomla API actor

On each fixture, in Joomla Administrator:

1. Create a group named for the fixture, such as **Joomla MCP API Fixture**,
   underneath the least-privileged appropriate parent group.
2. Enable **User - Joomla API Token** and permit that group in the plugin's
   allowed-user-group setting.
3. Enable **API Authentication - Web Services Joomla Token**.
4. Enable only the core Web Services plugins needed by the test run.
5. Grant the group **Web Services Login** (`core.login.api`).
6. Grant component permissions one family at a time. Maintain two users: an
   allowed actor with the permission under test and a denied actor without it.
7. Create both users with non-human fixture addresses and strong random
   passwords; do not grant Super Users unless a test specifically proves a
   privileged operation and its denial counterpart.
8. Open each user's **Joomla API Token** tab and copy the generated token into
   the CI or local secret store.
9. Verify HTTPS and the API outside MCP:

```bash
curl --fail-with-body --silent --show-error \
  -H 'Accept: application/vnd.api+json' \
  -H "Authorization: Bearer ${JOOMLA_CONTRACT_TOKEN}" \
  "${JOOMLA_CONTRACT_BASE_URL}/api/index.php/v1/content/articles?page%5Blimit%5D=1"
```

Do not paste the token into logs or repository configuration.

## Companion actor and package

On each fixture:

1. Build or download the companion ZIP whose digest is under test.
2. Install it through Joomla's native extension installer.
3. Verify **Console - JoomEngine MCP for Joomla Companion** is enabled. Version 0.7.0 and
   later enable it on first installation while preserving state on upgrades.
4. Select a dedicated **MCP actor user** with only the permissions for the
   current test group. An unset actor is a required denial case.
5. Run the following from the Joomla root as the dedicated deployment account:

```bash
php cli/joomla.php joomla:mcp:describe --format=json --no-interaction --no-ansi
```

6. Confirm that the response reports the expected protocol/package version,
   action IDs, and effective permission results.
7. Send a read-only smoke request over stdin:

```bash
printf '%s' '{"protocol":"joomla-mcp/1","id":"fixture-smoke","action":"system.info","input":{}}' \
  | php cli/joomla.php joomla:mcp:dispatch --input=- --format=json --no-interaction --no-ansi
```

8. Record the command exit status and redacted result. Do not run the companion
   process as root or the web-server user unless that account is the explicitly
   isolated fixture deployment account.

## Edge site entries

Create separate immutable aliases in a fixture-only `sites.json`. Give each
alias only the toolsets for the test group. A dual-path entry needs both `api`
and `cli`; an API-only entry omits `cli`; a companion-only entry omits `api`.

```json
{
  "defaultSite": "joomla61Fixture",
  "approval": {
    "secretEnv": "JOOMLA_MCP_FIXTURE_APPROVAL_SECRET",
    "ttlMs": 300000
  },
  "sites": {
    "joomla61Fixture": {
      "toolsets": ["discovery", "content.read", "cli.discovery"],
      "api": {
        "baseUrl": "https://joomla61-fixture.example",
        "tokenEnv": "JOOMLA_61_CONTRACT_TOKEN"
      },
      "cli": {
        "root": "/srv/joomla61-fixture",
        "phpBinary": "/usr/bin/php8.3",
        "timeoutMs": 120000,
        "maxOutputBytes": 2097152
      }
    }
  }
}
```

Keep this file and all referenced secrets outside source control.

## GitHub secret activation

Add these Actions secrets to the repository:

| Target | Secret names |
|---|---|
| Joomla 6.1 | `JOOMLA_61_CONTRACT_BASE_URL`, `JOOMLA_61_CONTRACT_TOKEN` |
| Joomla 6.2 | `JOOMLA_62_CONTRACT_BASE_URL`, `JOOMLA_62_CONTRACT_TOKEN` |
| Joomla 7 canary | `JOOMLA_70_CONTRACT_BASE_URL`, `JOOMLA_70_CONTRACT_TOKEN` |

Hosted CI now includes the JoomEngine package-install and full Super User
success-path lane described above. The broader compatibility and denial matrix still requires a runner that
has the exact package, PHP, filesystem access to the disposable Joomla root,
and a configured least-privilege actor. Prefer an ephemeral or dedicated
self-hosted runner; do not grant a general repository runner access to a
production server.

On that runner, set `JOOMLA_CONTRACT_ROOT` to the absolute disposable Joomla
root and `JOOMLA_CONTRACT_PHP_BINARY` to the absolute PHP executable before
running `npm run test:contract`. Both paths are validated and never accepted
from an MCP tool call.

## Seed, test, and reset

For each action family:

1. restore the clean snapshot;
2. install the exact companion artifact when the local path is tested;
3. enable only that family's Web Services plugin, actor ACL, edge toolset, and
   remote scopes;
4. create uniquely prefixed fixture records through Joomla-native setup or the
   action under test;
5. run allowed, denied, bounds, mutation, verification, and cleanup cases;
6. retain redacted evidence and artifact digests;
7. restore the filesystem and database snapshot;
8. prove that the restored Joomla site starts and passes its own health check.

Do not declare a family live-verified if cleanup or snapshot restoration fails.
