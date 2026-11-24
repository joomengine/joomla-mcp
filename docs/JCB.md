# Using Joomla MCP with Joomla Component Builder

Use the Node server to read and edit Joomla Component Builder (JCB) definitions through Joomla Web Services. A Node process on the Joomla host can also run approved compiler and package operations through this repository's PHP console companion. Choose the access your site needs.

Build the Node server and companion from this revision, or install a release containing the direct JCB integration. The published 0.8.0 server provides CLI inventory and help for JCB. Its API definition tools and compiler/package jobs require the newer implementation.

| Task | Joomla-side requirement | Site toolsets |
| --- | --- | --- |
| Read component definitions, admin views, fields and other JCB resources | JCB and its Web Services routing plugin, plus a Joomla API user with access to the requested resource | `discovery`, `jcb.read` |
| Create, edit or delete a JCB definition | Same as above, with the JCB resource's create, edit, state or delete permission as appropriate | Add `jcb.write` and configure an approval secret |
| Inspect the installed JCB command names, arguments and options | Local PHP, the JCB console plugin and this repository's console companion | `cli.discovery` |
| Compile a component or run a package get, init, pull, push or reset | Same local setup, an authorized companion actor and a private job directory | `discovery`, `jcb.execute` and an approval secret |

## Build the server for JCB

From the root of a checkout containing the direct JCB integration, run the following with Node.js 22.12 or newer.

```bash
npm ci
npm run build
```

For stdio, configure your client to run `node` with the absolute path to `dist/bin/joomla-mcp.js`. For a shared HTTP endpoint, deploy `dist/bin/joomla-mcp-http.js` using the [hosted deployment guide](DEPLOYMENT.md). API-only sites can proceed directly to the token setup below. If the server will compile or run package jobs, also build the matching companion in this checkout with `php companion/build.php` (PHP 8.3+ with ZIP) and install the resulting `companion/dist/pkg_joomlamcp-*.zip` on the Joomla site.

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

Use a returned record's numeric ID with `jcb.api.joomla_components.get`. Resources with a registered GUID route also advertise `.get.guid`, accepting a `guid` instead of an `id`. For lists, the description identifies the available filters and ordering fields. If the expected collection is missing, check the routing plugin, the selected site, and its API user's JCB permissions. A Node-only container built from this revision can make this API connection.

## Preview and apply a definition change

Add `jcb.write` to the site's toolsets alongside `jcb.read`. At the top level of the configuration add `"approval": {"secretEnv":"JOOMLA_MCP_APPROVAL_SECRET"}` and set that secret on the Node host. Search again with `includeWrites: true`. Use the resource's described schema when choosing editable fields.

For example, to edit a language definition, read the record and use its actual ID in `joomla_action_write_plan`. Choose `action: "jcb.api.languages.update"`, `transport: "api"`, and pass `input` such as `{"id":7,"data":{"name":"Oshiwambo"}}` if record 7 is the intended language. Include `site: "builder"`, a fresh UUID `idempotencyKey` and `dryRun: true` to preview. Follow the [permission request, operator acknowledgement and plan/apply flow](USAGE.md) for the site's `jcb.write` toolset. Finish with an independent `jcb.api.languages.get` for the same ID.

On create, the plan lists the required fields it fills from JCB’s form defaults in `formDefaults`. Bundled content plugins can add required switches for headers, privacy and language options. Their fixed defaults appear separately in `pluginFormDefaults` because Joomla’s item response omits those private form parameters. For a component code name, check `normalizedComponentCodeName` if JCB changes the value. Updates send only the approved fields and preserve the installed model’s handling of omitted values.

The apply receipt reports the native response status and verification result. If it reports `uncertain`, inspect the affected JCB definition before deciding what to do next. JCB's installed form, model and ACL govern the save. For translation updates, the adapter preserves the existing immutable source text. Creating a translation through the reviewed form is gated because that form disables its required source.

The [JCB Web Services action reference](JCB_API_ACTIONS.md) lists every family, its numeric and GUID actions, supported filters and parent links.

## Work with a component, its admin views and fields

JCB stores a component, an admin view and a field as separate definitions. Association records describe which views belong to the component and which fields appear on each view. The same MCP site alias can read both the definitions and their associations.

| To find | Read this JCB family | What to follow |
| --- | --- | --- |
| A component | `joomla_components` | Keep the component GUID from the item read. |
| Its administrator views | `components_admin_views` | Match `joomla_component` to the component GUID. Each `addadmin_views` row identifies its view in `adminview`. |
| A view definition | `admin_views` | Read the view by GUID to see its names and definition. |
| Fields attached to that view | `admins_fields` | Match `admin_view` to the view GUID. Each `addfields` row identifies a field in `field` and stores its ordering and display settings. |
| A field definition | `fields` | Read the field by GUID. Its `fieldtype` identifies the corresponding `fieldtypes` definition. |

For example, describe `jcb.api.components_admin_views.list` to see the installed collection filters, then call it with `joomla_action_read`. Page through results when needed. In a JSON:API item, check `attributes` for values and `relationships` for linked IDs. When a repeatable value is serialized as JSON text, decode it before reading the rows.

To attach an existing field, read the whole `admins_fields` association for the view. Keep every existing row, add the chosen field GUID and its display settings, and send `addfields` as a JSON array. JCB stores these rows in `tab`, `alignment`, then `order_edit` order and discards named row keys. Use that order for the array and preview `jcb.api.admins_fields.update` for the association’s numeric ID. The approved value replaces that entire subform. If the view has no association yet, describe `jcb.api.admins_fields.create` and supply the existing view GUID in `admin_view`. After applying the plan, read the association again and check both the original rows and the newly attached field. Compile the component when the saved definition is ready to test.

## Connect local compiler and package jobs

Install the [console companion](../companion/README.md) from the same server release, enable the JCB console plugin (`componentbuildercommands`), and select the companion's **MCP actor user**. Grant the actor the dedicated JCB component administration permission (`core.admin` on `com_componentbuilder`) required by the companion. Run the Node service with a PHP executable and Joomla root it can access. The project’s Node-only Docker image serves API sites. CLI jobs need a process with local access to PHP and the Joomla installation. The [host deployment instructions](DEPLOYMENT.md) also cover systemd.

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

Use `joomla_jcb_jobs_list` with `{"site":"builder","limit":25}` to find your job IDs after reconnecting. Pass a returned `nextCursor` as `cursor` for the next page. Only your jobs for that site appear. If another write holds the site's execution claim, your submission stays queued. When the site is free, call `joomla_jcb_job_redispatch` with the same site and `jobId` to run the original approved inputs. Use `joomla_jcb_job_cancel` with those arguments to cancel a job still waiting for dispatch. Both commands require the original MCP identity and, for HTTP clients, the `joomla:writes:apply` scope. Running or uncertain native mutations require inspection through the [recovery procedure](JCB_JOB_OPERATIONS.md).

To deploy the compiled component, assemble the returned archive and verify its SHA-256 against the job receipt. On the target Joomla site, open **System → Install → Extensions → Upload Package File** and select that ZIP. Check the installed extension and version under **System → Manage → Extensions**, then open the component and check the views you changed. This lets a build site compile for a separate target site with its own administrator permissions.

The compiler accepts inline component GUIDs and the native flags advertised by its described schema. Its `options` command option can carry a JSON string of those same settings. Explicit named options take precedence, and the preview shows their resolved values. Package jobs accept inline `items` selectors (CSV, newline-separated or a JSON array in a string). Depending on the installed command, they can also accept a configured repository GUID in `repo` and boolean `force` or `resolve` flags. Choose explicit selectors. Local paths, wildcard selections, arbitrary command options and the compiler's `--install`, `--backup`, `--repository` and `--powers-repository` options are outside the MCP input contract.

If a job becomes `uncertain`, inspect the Joomla and repository effects before
resuming writes. The [job storage and recovery runbook](JCB_JOB_OPERATIONS.md)
shows how to inspect the exact claim, reconcile an interrupted command, and
archive a verified ZIP while preserving its idempotency receipt.

For remote MCP clients, grant the site scope and matching toolset scopes in addition to the normal connection, permission and apply scopes documented in [HTTP authorization](REMOTE_HTTP.md). For API writes the caller needs both `jcb.read` and `jcb.write` scopes. The Joomla API identity and the companion's actor each retain their own Joomla permissions.

## What the fixture checks

The [installed JCB test](../scripts/fixtures/verify-jcb.mjs) runs in the dedicated **Joomla 6.1 / JCB 6.2.1 integration** CI job. Build the companion with `php companion/build.php` and run `npm run test:fixture:joomengine -- --jcb-only` to start the same isolated Docker Compose fixture locally. The run installs JCB 6.2.1 with its published routing and console plugins and writes results to `jcb-evidence.json`.

| Surface | Installed checks |
| --- | --- |
| JCB Web Services | Compare all 320 method/path/controller registrations with the server catalogue, read all 53 collections, and compare numeric/GUID item reads for two resources. The report records each collection’s result, including the compiler and extrusion display resources. |
| Language definitions | Use an API-only site alias over stdio and Streamable HTTP. Preview a create, check denial without a grant, create and read a record, prove native Joomla ACL denial for another authenticated user, then update, delete and verify absence. |
| Form and relationship writes | Exercise [fixture-owned definitions](../scripts/fixtures/jcb-write-fixture.mjs) across multiple resource families, including class/group relationships, conditional admin view inputs and a nested subform. Report the outcome separately for each of the 51 writable families, including updates to an independently seeded translation and its immutable source. |
| Installed commands | Compare the names, argument and option definitions in Joomla's JCB registry with the actor's executable MCP schemas. The report distinguishes available commands and options from native registrations without an executable MCP binding. |
| Compilation and package jobs | Compile Demo J6 over Streamable HTTP with a signed JWT. The submitting principal lists its job, retrieves the archive in chunks, and verifies its digest and Joomla extension manifest. A second authenticated principal with the same site and toolset grants cannot list that job or read its status or archive. Exercise package push/get/init/pull/reset against a disposable loopback repository and check both the component and its linked update definition in Joomla and the repository. A rejected push must retain its uncertain job receipt and leave remote bytes unchanged even when the same key is replayed. The test reuses the [sibling implementation's repository fixture](https://github.com/joomengine/mcp_component/blob/aedd96a7be89d54b5dae10a70067aeb7e191e123/tests/golden-image/package-roundtrip.php). |

The [API source metadata](../src/jcb/api-catalog.json) records the reviewed routes and forms. A registered route or command establishes its contract. Use the fixture's per-resource and per-job results to identify which operations completed with independent verification. Production repository credentials, other package areas and site-specific permission combinations need their own checks.
