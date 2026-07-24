# Live Joomla validation

`joomla-mcp-live-test` exercises the published MCP package against a Joomla
site. It uses the same catalogue, permission requests, reviewed plans,
one-time confirmation tokens, API adapter, companion adapter, stdio server,
and Streamable HTTP gateway as a real host application. It does not call
Joomla routes directly.

The full runner is intentionally destructive. Use a disposable demo site or a
site whose owner has explicitly authorized the selected mutations. Never run
`crud` or `full` against production.

## What the profiles prove

| Profile | Joomla activity | Intended use |
|---|---|---|
| `read` | Catalogue discovery and every selected executable read | Existing non-production site; no write grant |
| `crud` | Create two labelled records per selected CRUD family, list/get, update and read back the showcase, delete and verify the deletion candidate | Demo or disposable site |
| `full` | `crud` plus media, configuration, plugin, privacy, language-override, history, cache, scheduler, session, extension, state, and other fixed administrative actions | Explicitly disposable site only |

Every run can select:

- Joomla path: Web Services API, companion CLI, or both;
- MCP transport: stdio, authenticated Streamable HTTP, or both;
- all domains or a comma-separated family subset;
- continue-and-report or fail-fast behavior;
- removal or retention of generated showcase data.

The scenario inventory is generated from the authoritative API and companion
catalogues. Unit validation fails when an action is added without a live
scenario or when one of the 36 CRUD bases lacks deterministic fixture data.
The five Joomla routes that are deliberately fail-closed remain visible as
`SOURCE_ONLY_GATED`.

## Configure a target

Use the normal Joomla MCP site configuration. A dual-path run requires both
`api` and `cli`, all selected toolsets, and an approval secret:

```json
{
  "defaultSite": "demo",
  "approval": {
    "secretEnv": "JOOMLA_MCP_LIVE_APPROVAL_SECRET",
    "ttlMs": 300000,
    "requestTtlMs": 300000
  },
  "sites": {
    "demo": {
      "toolsets": [
        "discovery",
        "content.read",
        "content.write",
        "structure.read",
        "structure.write",
        "media.read",
        "media.write",
        "users.read",
        "users.admin",
        "extensions.read",
        "extensions.admin",
        "configuration.read",
        "configuration.write",
        "maintenance.read",
        "maintenance.admin",
        "core-update",
        "cli.discovery"
      ],
      "api": {
        "baseUrl": "https://demo.example",
        "tokenEnv": "JOOMLA_MCP_LIVE_API_TOKEN"
      },
      "cli": {
        "root": "/srv/www/demo",
        "phpBinary": "/usr/bin/php8.3",
        "timeoutMs": 120000,
        "maxOutputBytes": 2097152
      }
    }
  }
}
```

Export the referenced secrets from a secret manager. The API token must belong
to an actor with the Joomla ACL required by the selected actions. A Joomla
Update lane also needs the separately scoped `updateTokenEnv`; when it is not
configured, update actions are reported as `BLOCKED_BY_PREREQUISITE`.

HTTP Joomla origins must use HTTPS. `allowInsecureLoopback: true` permits HTTP
only for `localhost`, `127.0.0.1`, or `::1`; it exists solely for disposable
local fixtures and cannot enable cleartext access to a remote host.

## Interactive demo run

Build the package, then start the menu:

```bash
npm run build
npx joomla-mcp-live-test
```

The menu asks for the site, profile, Joomla path, MCP transport, families,
retention, and run seed. Before any mutation it prints the exact target and
requires:

```text
MUTATE <target-hostname> <run-seed>
```

The default interactive mutation run retains one clearly labelled showcase
record in each tested CRUD family and still creates/deletes a separate deletion
candidate. Use `--cleanup` to remove the showcase records as well.

## Unattended run

A read-only run requires no mutation flag:

```bash
npm run test:live -- \
  --config /etc/joomla-mcp/demo-sites.json \
  --site demo \
  --profile read \
  --joomla-path all \
  --mcp-transport all \
  --non-interactive \
  --output ./artifacts/live-read
```

An unattended full run requires both explicit mutation confirmation and an
explicitly disposable target:

```bash
npm run test:live -- \
  --config /etc/joomla-mcp/demo-sites.json \
  --site demo \
  --profile full \
  --joomla-path all \
  --mcp-transport all \
  --families all \
  --seed release-candidate-1 \
  --output ./artifacts/live-full \
  --repository-commit "$(git rev-parse HEAD)" \
  --non-interactive \
  --confirm-mutations \
  --disposable \
  --cleanup
```

`--fail-fast` stops at the first unexpected failure. The default continues
all independent scenarios, links dependent failures to their root cause, and
exits nonzero only after the complete report is written. Before exiting, the
command prints every direct `FAIL` and `CLEANUP_FAILED` result to standard
output with its action, phase, MCP/Joomla lane, failure code, reason,
expected/actual values when available, and exact reproduction command. It then
groups blocked descendants under their originating attempt so GitHub Actions
logs expose the complete actionable failure set without counting one root cause
as dozens of separate defects.

## Operation flow

For each selected lane, the runner:

1. initializes the actual MCP client and server transport;
2. lists sites, capabilities, and the complete enabled action catalogue;
3. requests and approves a time-bounded grant for the selected write toolsets;
4. submits every write as a dry run;
5. creates a fresh executable plan and consumes its signed one-time token;
6. performs verification reads and compares identifiers and changed fields;
7. exercises deletion against a separately generated candidate;
8. removes retained records with supported delete actions in reverse dependency
   order when `--cleanup` is selected.

Generated titles, aliases, users, addresses, paths, and constants contain the
run seed and lane. Existing records may be read as prerequisites, but they are
never chosen as generic CRUD mutation targets. Reversible administrative state
is restored by its scenario. Irreversible/high-risk scenarios do not dispatch
unless the target is declared disposable. Some full-profile actions, including
privacy requests, have no public deletion route; they remain listed under
`retainedRecords` even with `--cleanup`, which is why the full profile requires
a disposable site or external snapshot restoration.

## Evidence

The output directory contains:

| Artifact | Purpose |
|---|---|
| `summary.md` | Human result, failure table, blocked/root-cause table, retained records, and debugging procedure |
| `summary.json` | Complete machine-readable run, selection, versions, commit, seed, configuration fingerprint, fixture identities, transport diagnostics, and attempts |
| `junit.xml` | CI test cases with failures and skipped/gated classifications |
| `actions/*.json` | One bounded, redacted request/result record per attempt, including phase, lane, source, expectation, actual result, stack, dependencies, root cause, and reproduction command |
| `compose.log`, `compose-ps.txt`, `joomla-logs/` | Disposable-fixture runtime evidence captured before teardown |

Tokens, passwords, approval acknowledgements, signed confirmation tokens,
authorization headers, cookies, and secret-named values are recursively
redacted. Large strings and arrays are bounded.

Statuses have precise meanings:

| Status | Meaning | CI result |
|---|---|---|
| `PASS` | Dispatch and postcondition succeeded | pass |
| `FAIL` | Unexpected transport, Joomla, validation, or postcondition failure | fail |
| `EXPECTED_DENIAL` | Safety policy intentionally prevented dispatch | pass, reported |
| `KNOWN_UPSTREAM_LIMITATION` | The exact pinned fixture, action, phase, and error matched a reviewed Joomla defect after dispatch | pass, reported with source reference |
| `SOURCE_ONLY_GATED` | Known source route is deliberately non-executable | pass, reported |
| `BLOCKED_BY_PREREQUISITE` | Named prerequisite was absent or failed | pass, reported with root cause |
| `CLEANUP_FAILED` | Generated data/state could not be removed/restored | fail |

## Debug a failure

1. Open `summary.md` and find the failed attempt ID.
2. Open the matching file under `actions/`.
3. Check `phase`, `mcpTransport`, `joomlaPath`, `failureCode`, `reason`,
   `expected`, and `actual`.
4. Follow `rootCauseId` before investigating dependent failures.
5. Use the recorded reproduction command to isolate the family and lane.
6. For `joomla_http_*`, inspect the redacted Joomla body and Joomla logs.
7. For `companion_error`, inspect bounded stderr, the companion response, PHP
   logs, and `joomla:mcp:describe`.
8. For `postcondition_failed`, compare the applied mutation with the
   verification read; confirm Joomla events/plugins did not transform the
   submitted value.
9. Treat every `CLEANUP_FAILED` as operationally significant. Review
   `retainedRecords` and remove only records carrying the exact run label.

`KNOWN_UPSTREAM_LIMITATION` is deliberately narrower than a skip. The request
was dispatched and its failure evidence was captured. The classification is
accepted only for the exact pinned fixture identity plus an exact
action/phase/error signature documented in the report. The same action on a
different Joomla image, or a changed error on the pinned image, is `FAIL`.

For a mutation whose Joomla response reports failure after changing state, the
status also requires a successful independent read-back of the exact submitted
identifier or fields. If that verification is absent or differs, the attempt is
`FAIL`.

The pinned Joomla 6.1.2 fixture currently documents these reviewed behaviors:

| API behavior | Why the report can classify it | Joomla source |
|---|---|---|
| Contact item GET returns 500 immediately after a successful delete | Exact contact action, `verify-deleted` phase, image digest, and 500 body must match | [Contact API controller](https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_contact/src/Controller/ContactController.php) |
| Site or administrator module POST reports missing `params` | The generic save runs before the modules controller seeds its edit-model client state; the companion lane remains executable | [Modules API controller](https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_modules/src/Controller/ModulesController.php) |
| Private-message POST returns 404 after storing the message | A list read must find the exact submitted subject before the attempt is accepted and cleanup continues | [Generic API add flow](https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/MVC/Controller/ApiController.php#L369-L379) |
| Content-language PATCH reports an empty check-in failure after storing the fields | An item read must match every submitted field before update or cleanup continues | [Generic API post-save check](https://github.com/joomla/joomla-cms/blob/6.1.2/libraries/src/MVC/Controller/ApiController.php#L523-L535) |
| Override item GET, site create, delete, or cache refresh fails in the reviewed signature | Joomla filters the string item ID as an integer, coerces the named site client as administrator, or delegates the file-backed operation through an incompatible generic path | [Overrides controller](https://github.com/joomla/joomla-cms/blob/6.1.2/api/components/com_languages/src/Controller/OverridesController.php), [override model](https://github.com/joomla/joomla-cms/blob/6.1.2/administrator/components/com_languages/src/Model/OverrideModel.php) |

This table describes fixture evidence, not a blanket Joomla-version waiver.
Every rule is encoded and unit-tested as an exact match.

Common failure codes:

| Code | First check |
|---|---|
| `joomla_http_401` / `403` | Token, `core.login.api`, component ACL, Web Services plugin |
| `joomla_http_404` | Joomla version/plugin route and generated identifier |
| `joomla_http_422` | Per-resource dummy payload and Joomla form validation |
| `mcp_tool_error` | Per-action MCP content plus server transport diagnostics |
| `companion_error` | Installed companion version, actor ACL, PHP stderr |
| `timeout` | Joomla/PHP/container logs and configured API/CLI bounds |
| `postcondition_failed` | Mutation response versus follow-up read |
| `prerequisite_unavailable` | `dependencyIds` and `rootCauseId` |

## Disposable CI fixture

The `joomla-61-fixture` job builds and installs the companion, creates a
throwaway Super User API token inside the isolated fixture, publishes Joomla
only on a random loopback port, configures an internal Mailpit SMTP sink for
contact-form delivery, and creates a local CLI bridge that executes as
`www-data` inside the container. It then runs the same packaged command with:

- `full`;
- API and companion CLI;
- stdio and Streamable HTTP;
- explicit non-interactive mutation and disposable flags;
- cleanup verification before volume destruction;
- all action families.

The token and approval secret exist only for the process lifetime and are
removed before evidence upload. The job uploads reports and logs even when the
suite fails, then always destroys both Joomla and database volumes.
