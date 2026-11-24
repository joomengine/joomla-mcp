# Using Joomla MCP with Joomla Component Builder

Use the Node server to read and edit Joomla Component Builder (JCB) definitions through Joomla Web Services. A Node process on the Joomla host can also run approved compiler and package operations through this repository's PHP console companion. Choose the access your site needs.

Build the Node server and companion from this revision, or install a release containing the direct JCB integration. The published 0.8.0 server provides CLI inventory and help for JCB. Its API definition tools and compiler/package jobs require the newer implementation.

| Task | Joomla-side requirement | Site toolsets |
| --- | --- | --- |
| Read component definitions, admin views, fields and other JCB resources | JCB and its Web Services routing plugin, plus a Joomla API user with access to the requested resource | `discovery`, `jcb.read` |
| Create, edit or delete a JCB definition | Same as above, with the JCB resource's create, edit, state or delete permission as appropriate | Add `jcb.write` and configure an approval secret |
| Inspect the installed JCB command names, arguments and options | Local PHP, the JCB console plugin and this repository's console companion | `cli.discovery` |
| Compile a component or run a package get, init, pull, push or reset | Same local setup, an authorized companion actor and a private job directory | `discovery`, `jcb.execute` and an approval secret |

## Connect to JCB over the API

1. Install JCB on the Joomla site and enable its **Web Services** plugin with element `componentbuilderapiroutes`. The [JCB 6.2.1 package](https://github.com/joomengine/pkg-component-builder/tree/v6.2.1) includes the component and the API and console plugins.
2. Set up the dedicated Joomla API identity and its token using the [single-site guide](SINGLE_SITE.md). Grant the user Web Services Login and the JCB permissions for its work. For example, reading an individual language definition requires `language.access` on the component and record.
3. Save a site configuration like the following. Replace the URL with your Joomla site's HTTPS URL, supply the token in the Node process environment, set `JOOMLA_MCP_CONFIG` to the file's absolute path, and [connect your client](CLIENTS.md).

```json
{
  "defaultSite": "builder",
  "sites": {
    "builder": {
      "api": { "baseUrl": "https://joomla.example.org", "tokenEnv": "JCB_JOOMLA_TOKEN" },
      "toolsets": ["discovery", "jcb.read"]
    }
  }
}
```

Call `joomla_actions_search` with `{"site":"builder","domain":"jcb","text":"joomla_components"}`. The server checks the collection with the site's token before advertising its actions. Call `joomla_action_describe` for an ID in the result to see its input schema, origin and available transport. Then call `joomla_action_read` with the following arguments.

```json
{
  "site": "builder",
  "action": "jcb.api.joomla_components.list",
  "transport": "api",
  "input": { "limit": 5 }
}
```

Use a returned record's numeric ID with `jcb.api.joomla_components.get`. Resources with a registered GUID route also advertise `.get.guid`, accepting a `guid` instead of an `id`. For lists, the description identifies the available filters and ordering fields. If the expected collection is missing, check the routing plugin, the selected site, and its API user's JCB permissions. The published Node Docker image supports this API connection.

## Preview and apply a definition change

Add `jcb.write` to the site's toolsets alongside `jcb.read`. At the top level of the configuration add `"approval": {"secretEnv":"JOOMLA_MCP_APPROVAL_SECRET"}` and set that secret on the Node host. Search again with `includeWrites: true`. Use the resource's described schema when choosing editable fields.

For example, to edit a language definition, read the record and use its actual ID in `joomla_action_write_plan`. Choose `action: "jcb.api.languages.update"`, `transport: "api"`, and pass `input` such as `{"id":7,"data":{"name":"Oshiwambo"}}` if record 7 is the intended language. Include `site: "builder"`, a fresh UUID `idempotencyKey` and `dryRun: true` to preview. Follow the [permission request, operator acknowledgement and plan/apply flow](USAGE.md) for the site's `jcb.write` toolset. Finish with an independent `jcb.api.languages.get` for the same ID.

The apply receipt reports the native response status and verification result. If it reports `uncertain`, inspect the affected JCB definition before deciding what to do next. JCB's installed form, model and ACL govern the save. For translation updates, the adapter preserves the existing immutable source text. Creating a translation through the reviewed form is gated because that form disables its required source.

## Connect local compiler and package jobs

Install the [console companion](../companion/README.md) from the same server release, enable the JCB console plugin (`componentbuildercommands`), and select the companion's **MCP actor user**. Grant the actor the dedicated JCB component administration permission (`core.admin` on `com_componentbuilder`) required by the companion. Run the Node service with a PHP executable and Joomla root it can access. The published Docker image is API-only. The [host deployment instructions](DEPLOYMENT.md) also cover systemd.

Create a private directory outside the Joomla web root. For the example paths below, run `install -d -m 0700 -o joomla-mcp -g joomla-mcp /var/lib/joomla-mcp/jcb-jobs` as a system administrator on a host using that dedicated Node service account. Use the actual account and filesystem paths for your installation. The node process and its PHP child both need access.

```json
{
  "defaultSite": "builder",
  "approval": { "secretEnv": "JOOMLA_MCP_APPROVAL_SECRET" },
  "sites": {
    "builder": {
      "toolsets": ["discovery", "cli.discovery", "jcb.execute"],
      "cli": {
        "root": "/srv/joomla",
        "phpBinary": "/usr/bin/php8.3",
        "jcbJobDirectory": "/var/lib/joomla-mcp/jcb-jobs",
        "timeoutMs": 300000
      }
    }
  }
}
```

1. Call `joomla_cli_inventory` with `{"site":"builder"}` to see the installed commands. Call `joomla_cli_command_help` with the site and an exact command name for its native help.
2. Search with `{"site":"builder","domain":"jcb","includeWrites":true,"text":"compile"}`, then describe `jcb.compile.component`. For package work, search for the operation and area, for example `jcb.init.joomla_component`. Discovery intersects the reviewed operations with the installed command definitions and the actor's permissions.
3. Preview a compile using `joomla_action_write_plan`, with the ID above, `transport: "cli"`, a new UUID idempotency key and `dryRun: true`. The input is an `options` object. For the Demo J6 definition shipped with the fixture, this is `{"options":{"component":"1c20aec5-bf1a-44e7-9deb-d1c920ca591d","joomla-version":"6"}}`. On your site, use the GUID of your component. For the corresponding package init, use `{"options":{"items":"1c20aec5-bf1a-44e7-9deb-d1c920ca591d"}}` when that action is available.
4. After the operator approves a `jcb.execute` grant, request the executable plan and apply it once. Record `job.jobId` from the receipt. Poll `joomla_jcb_job_get` with the same `site`, `jobId` and MCP identity. For stdio, keep the server process alive while it executes the job.
5. On success, the job returns its verification result and artifact list. Pass the job ID, site, returned filename (`name`) and byte `offset` to `joomla_jcb_artifact_read`. Decode the base64 `data`, advance the offset by `bytes` until `eof`, then compare the total size and SHA-256 with the artifact receipt. A failed or uncertain job needs operator inspection before another attempt.

The compiler accepts inline component GUIDs and the native flags advertised by its described schema. Its `options` command option can carry a JSON string of those same settings. Explicit named options take precedence, and the preview shows their resolved values. Package jobs accept inline `items` selectors (CSV, newline-separated or a JSON array in a string). Depending on the installed command, they can also accept a configured repository GUID in `repo` and boolean `force` or `resolve` flags. Choose explicit selectors. Local paths, wildcard selections, arbitrary command options and the compiler's `--install`, `--backup`, `--repository` and `--powers-repository` options are outside the MCP input contract.

If a job becomes `uncertain`, keep its job receipt and record the site, job ID and idempotency key. Stop the worker or confirm it has exited. Inspect the actual Joomla definitions, configured repository branch and generated files to establish what changed. An outstanding site claim is stored as `active-<SHA-256 of the site alias>` in that site's configured job directory. On the service host, inspect the claim's JSON and verify its site and job ID match this uncertain job. Once the outcome is reconciled and the worker is stopped, remove only the matching claim. Keep the job directory and its receipt. Any further execution requires a new operator-approved plan and a fresh idempotency key.

For remote MCP clients, grant the site scope and matching toolset scopes in addition to the normal connection, permission and apply scopes documented in [HTTP authorization](REMOTE_HTTP.md). For API writes the caller needs both `jcb.read` and `jcb.write` scopes. The Joomla API identity and the companion's actor each retain their own Joomla permissions.

## What the fixture checks

The [installed JCB test](../scripts/fixtures/verify-jcb.mjs) has a dedicated **Joomla 6.1 / JCB 6.2.1 integration** CI job. Build the companion with `php companion/build.php` and run `npm run test:fixture:joomengine -- --jcb-only` to start the same isolated Docker Compose fixture locally. It installs the pinned JCB 6.2.1 package with its actual routing plugin on disposable Joomla 6.1 and uses an API-only site alias for the language definition CRUD lifecycle over both stdio and Streamable HTTP. It checks preview without mutation, a denied grant, an authenticated user denied by Joomla, independent item read-back and cleanup. The suite compares the installed plugin's method, path and controller for all 320 registrations, tries every collection, and compares numeric/GUID reads for two resource families. For the compiler and extrusion list controllers, it distinguishes an independently reproduced native HTTP error from a server regression. A CLI-only alias compares the installed command names, arguments and options with the exposed executable schemas. It exercises the Demo J6 package init and compile, verifies the downloaded ZIP's digest and Joomla extension manifest, and runs a separate push/get/init/pull/reset round trip against a disposable local repository. The independent checks read both the component and its linked update definition from Joomla and the fixture repository. CI writes these outcomes in `jcb-evidence.json`. The local repository follows the [sibling implementation's package acceptance fixture](https://github.com/joomengine/mcp_component/blob/aedd96a7be89d54b5dae10a70067aeb7e191e123/tests/golden-image/package-roundtrip.php).

The API catalogue describes the routes and forms represented in the [pinned source metadata](../src/jcb/api-catalog.json). The language fixture exercises one resource's full write lifecycle. Write coverage for other resources, other package areas, production repository credentials and site-specific permission combinations requires separate verification.
