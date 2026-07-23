# Joomla action coverage and release status

This is the release truth table. It distinguishes eight independent facts for
every endpoint or native command:

- **Source-backed:** the Joomla route, command, service/model, form, ACL, and
  lifecycle have been identified in supported Joomla source.
- **Catalogued:** the semantic action and source reference exist.
- **Routable:** the selected site has an implementation and configured
  transport; source-only gates are excluded.
- **Input-contracted:** route inputs and mutation fields have reviewed schemas.
- **Live-success:** a supported Joomla fixture accepted the action.
- **Denial-verified:** a least-privilege actor lacking the required permission
  was rejected.
- **Postcondition-verified:** independent readback proves the documented result.
- **Recovery-verified:** cleanup, rollback, or restore passed the required
  interruption/failure matrix.
- **Gated:** code may exist, but execution or production use remains disabled or
  restricted until its permission, recovery, scaling, or live evidence passes.

No action family is currently live-verified across the required matrix. The
repository must not yet be described as fully production-ready or as complete
API/CLI parity.

`Implemented` below never means live-verified. `Native local` means the
companion calls a fixed Joomla-native model/service/runtime capability; it does
not mean arbitrary stock CLI execution.

## Coverage summary

- The Web Services catalogue contains 36 core CRUD bases: 72 list/get reads and
  108 create/update/delete writes.
- It also contains 29 special reads and 27 special writes, for 101 reads and 135
  writes (236 API semantic descriptors total).
- Five registered routes are explicitly source-only: component configuration
  read/update, language-package install, and both language-override PATCH
  routes. The remaining 231 descriptors are eligible for API routing when their
  site toolset and Joomla credential permit them.
- All 108 CRUD writes reject fields outside reviewed per-family allowlists.
  Special writes contain 22 exact body/no-body contracts, one typed core plus
  runtime-extension contract for contact submission, and four source-gated
  generic contracts.
- The companion allowlist contains 231 fixed native actions: 180 CRUD, 28 core
  model state actions, and 23 supplemental/alias actions.
- The edge companion catalogue contains 12 reads and 39 writes (51 descriptors):
  selected native operations, cache clean, and 28 core model-state actions.
- Generic MCP search/read and plan/apply expose the effective API actions, all
  shared companion CRUD IDs, all 51 edge companion descriptors, and the
  companion's live effective actor permission catalogue. `joomla_action_describe`
  reports exact configured transports and source-only reasons.
- Offline TypeScript and companion tests exist. The current live API contract is
  a read smoke test, not a complete action matrix.
- The reviewed Joomla CLI target map covers all 38 stock commands: 19 are
  implemented, six expose a bounded subset, and 13 remain non-executable and
  recovery-gated. Live inventory/help also records the fixture's 111 optional
  Joomla Component Builder commands separately.

## Action-family matrix

| Family | Joomla API implementation | Native local implementation | MCP exposure | Release status |
|---|---|---|---|---|
| Articles | CRUD; history read/keep/delete | CRUD and model state | CRUD/state/history | Implemented; live verification pending |
| Banners, clients, categories | CRUD; banner history | CRUD and supported model state | CRUD/state/history | Implemented; live verification pending |
| Users, groups, access levels | CRUD | CRUD with fixed fields; no generic password command | CRUD | Implemented and privilege-gated; password/reset lifecycle incomplete |
| Content/contact/banner/newsfeed categories | CRUD | CRUD and supported model state | CRUD/state | Implemented; live verification pending |
| Contacts | CRUD, history, authenticated form submission | CRUD and model state | CRUD/state/history/submission | Implemented; live verification pending |
| Media | File/directory reads and file create/update/delete | None | API actions | Source-backed API implementation; local path missing; live verification pending |
| Menus and menu items | Site/administrator CRUD and type discovery | CRUD; supported item state | CRUD/state/type reads | Implemented; model-specific state verification pending |
| Modules | Site/administrator CRUD and type discovery | CRUD and model state | CRUD/state/type reads | Implemented; live verification pending |
| Tags and redirects | CRUD | CRUD and model state | CRUD/state | Implemented; live verification pending |
| Privacy | Request create/list/get/export and consent list/get | None | API subset | Source-backed partial implementation; local/full lifecycle missing |
| Fields and field groups | CRUD for fixed content/contact/user contexts | CRUD and supported model state for the same fixed contexts | CRUD/state | Implemented; user contexts privilege-gated; live verification pending |
| Template styles | Site/administrator CRUD | CRUD; no assumed generic state | CRUD | Implemented; live verification pending |
| Content languages and overrides | Language CRUD; override list/get/create/delete/search/refresh; registered package install and override PATCH retained source-only because Joomla 6.1 controller paths are defective | Content-language CRUD and supported state | Effective API operations plus local CRUD/state | Implemented subset; three source-only route defects and live verification pending |
| Messages and newsfeeds | CRUD | CRUD; newsfeed state where supported | CRUD/state where supported | Implemented; messages privilege-gated; live verification pending |
| Safe configuration | Strict safe application read; 103-field core application write schema; component read/write source-only until runtime schema/secret discovery exists | Strict safe application read | Safe read and guarded application write | Application path implemented but high-risk/live-gated; component paths source-only |
| Plugins and extensions | Installed/plugin reads and bounded plugin update | Installed/cached-update/discovered/update-site reads; native enable/disable and refresh adapters | API subset and native read/plan/apply actions | Partial; connected but live/recovery-gated; install/remove/discover-install missing |
| Cache | No general Web Services lifecycle | Group list, selected-group clean, expired-cache purge | Native read/plan/apply actions | Implemented; live/recovery verification pending |
| Scheduler | No core Web Services lifecycle | Task list, single-task state, single-task run | Native read/plan/apply actions | Implemented and gated; live/recovery verification pending |
| Site state and sessions | No core Web Services lifecycle | Site read/up/down and site/administrator session GC | Native read/plan/apply actions | Implemented and gated; live/recovery verification pending |
| Joomla core update | Health/status plus typed prepare/finalize/success/failed notification routes using the separate update token | Cached status only | API lifecycle descriptors and local status | Implemented but high-risk and not live/recovery verified; channel/autoupdate/cleanup incomplete |
| Database/search/global maintenance | No general Web Services lifecycle | Stock Joomla commands identified; native help/contracts captured | Discovery/target map only | Source-backed gap; not executable |

## Companion 0.6.0 native operational actions

These actions are fixed adapters over native Joomla capabilities, are described
by the TypeScript edge, and route through generic read or guarded plan/apply.
They remain gated pending the live Joomla success/denial/recovery matrix:

| Action | Native capability |
|---|---|
| `cache.expired.purge` | Cache model purge |
| `extensions.discovered.refresh` | Installer Discover model discovery |
| `extensions.updates.refresh` | Installer Update model purge/find updates |
| `extensions.update-sites.list` | Installer Update Sites model list |
| `extensions.update-sites.state.set` | Installer Update Sites model publish |
| `extensions.state.set` | Installer Manage model publish |
| `scheduler.tasks.state.set` | Native single-task scheduler state command |
| `scheduler.tasks.run` | Native single-task scheduler run command |
| `site.state.get`, `site.state.set` | Joomla configuration and native site up/down |
| `sessions.data.gc` | Native site/administrator session garbage collection |
| `sessions.metadata.gc` | Native session-metadata garbage collection |

The edge enforces matching schemas/toolsets, principal-bound plan/apply for
writes, a fresh planned site/toolset scope check before token consumption, and
audit. The local companion trusts its `_edgeConfirmed` stdin marker; it does
not verify the edge HMAC. Operating-system access capable of invoking Joomla CLI
is therefore a trusted administrative boundary and must be tightly restricted.
Production MCP writes must go through edge plan/apply.

## Stock Joomla CLI capability status

See [Joomla CLI integration](CLI.md) for the installed-registry discovery
contract and the command-by-command core mapping.

| Native command group | Structured semantic status |
|---|---|
| `cache:clean` | Selected-group clean and expired purge connected; live recovery pending |
| `config:get`, `config:set` | Strict safe read implemented; raw get prohibited; controlled writes API-only and gated |
| `site:down`, `site:up` | Native local adapter connected; live recovery pending |
| `site:create-public-folder` | Source-backed only; missing |
| `core:update:*`, `update:joomla:remove-old-files` | Status subset only; execution/channel/autoupdate/cleanup missing and gated |
| `update:extensions:check` | Native refresh adapter connected; live recovery pending |
| `extension:list` | Implemented through native model and API reads |
| `extension:enable`, `extension:disable` | Native model adapter connected; live recovery pending |
| `extension:discover`, `extension:discover:list` | Native refresh/list connected; discover-install remains missing |
| `extension:install`, `extension:remove`, `extension:discover:install` | Missing and recovery-gated |
| `user:list`, add/group/reset/delete commands | Entity CRUD exists through API/companion models; command-specific password/reset and recovery contracts incomplete |
| `scheduler:list` | Connected native list |
| `scheduler:state`, `scheduler:run` | Native single-task adapters connected and live/recovery-gated |
| `finder:index`, `maintenance:database` | Source-backed only; missing |
| `session:gc`, `session:metadata:gc` | Native adapters connected and live/recovery-gated |
| `database:export`, `database:import` | Source-backed only; missing and recovery-gated |

Generic stock-command execution is intentionally not planned. Each useful
command becomes a separate typed semantic action that retains Joomla's native
implementation and adds the missing authorization, schema, result, and recovery
contract.

## Known production gaps

- Every generic CRUD mutation has a reviewed field allowlist, but many field
  value types and create-required combinations still rely on Joomla form/model
  validation and need per-version live proof.
- Delete, state, history, media-path, language-override, password, and extension
  lifecycle semantics need action-specific live postconditions.
- Special API routes do not all have useful or implemented local equivalents.
  The goal is safe native availability, not artificial path parity.
- Extension install/remove, core update, database import/export/repair, public
  folder creation, finder indexing, global check-in, password/reset workflows,
  and other recovery-sensitive operations remain missing or gated.
- There is no completed MySQL/MariaDB and PostgreSQL fixture matrix, package
  install/upgrade/rollback matrix, load/fuzz/failure-injection evidence, or
  disaster-recovery evidence.
- A blocking JoomEngine `:6` lane proves a fresh Joomla 6.1.2/PHP 8.4/MariaDB
  installation, exact companion package install/activation, catalogue describe,
  `system.info` dispatch as `www-data`, all 153 installed command contracts via
  bounded native list/help, fixed bootstrap CLI commands, and the unauthenticated
  API boundary. It is a smoke gate, not family-level
  live-verification or the required database/permission/recovery matrix.
- Permission requests, confirmation plans, principal-scoped idempotency
  results, and per-site locks are shared across HTTP MCP sessions within one
  process. Active permission grants may persist in the signed local grant
  store, but coordination remains single-process; write-enabled deployment is
  still single-replica.

The generated [Joomla API action reference](API_ACTIONS.md) lists all 236
semantic actions and is checked for drift in CI.

## Production release gate

1. Provision and retain resettable Joomla 6.1/6.2 fixtures as described in
   [Fixtures](FIXTURES.md).
2. Prove every implemented family across API/local paths that Joomla actually
   provides, including least-privilege denial, schema, native events,
   postcondition, cleanup, and rollback.
3. Prove the connected native operations through their guarded MCP flows and
   retain recovery evidence.
4. Complete resource-specific schemas and high-risk recovery contracts.
5. Add shared coordination before write-enabled horizontal scaling.
6. Pass database, packaging, upgrade/rollback, signed-release, load, fuzz,
   failure-injection, and disaster-recovery matrices.
