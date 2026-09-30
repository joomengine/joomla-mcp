# Changelog

All notable changes to the published packages are documented here. Releases
follow Semantic Versioning.

## Unreleased

### Fixed

- Publish and normalize the native `extensions.list` type filter in the Node
  companion catalogue, allowing safe plugin selection through both MCP transports
  while rejecting unsupported types and unknown properties.
- Select a disabled, unprotected optional plugin from bounded explicit plugin pages in live extension-state validation, preserving its identity and original state for restoration when deterministic native ordering puts components on the first page.
- Preserve object-valued native companion inputs and schema mappings, reject
  arrays/null/scalars where objects are required, and retain nested empty values.
  Keep exact zero-based native list pagination at partial/end boundaries and map
  content-language `id` ordering to Joomla's real `lang_id` field
  ([#44](https://github.com/joomengine/joomla-mcp/issues/44),
  [PHP PR #16](https://github.com/joomengine/mcp_component/pull/16)).
- Preserve stored empty and numeric-key JSON mappings in native item reads and
  saved read-back, including article metadata and attributes that Joomla models
  convert from Registry objects to arrays. Keep stored lists distinct and retain
  strict write verification ([#44](https://github.com/joomengine/joomla-mcp/issues/44)).
- Supply Joomla's empty-string `default_value` when a `fields.*.create` call
  omits it, through both API and companion transports. Preserve caller-supplied
  defaults and leave partial updates unchanged
  ([#42](https://github.com/joomengine/joomla-mcp/issues/42)).
- Resolve site-specific published custom fields for API article, content-category,
  contact and user create/update plans, including the typed article tools,
  while rejecting unrecognized keys and retaining approved field snapshots
  ([#38](https://github.com/joomengine/joomla-mcp/issues/38)).

- Preserve installed template inheritance when creating site or administrator
  styles through the API or companion. Derive hidden `parent` and `inheritable`
  fields from an existing style's native manifest before confirmation; refuse
  missing, ambiguous, invalid, or changed metadata ([#40](https://github.com/joomengine/joomla-mcp/issues/40)).
- Persist and verify native menu component IDs for API creates and updates,
  including cross-component link changes. Approved corrective PATCHes and
  stored-list verification retain honest partial/uncertain outcomes and prevent
  same-key duplicate creates ([#39](https://github.com/joomengine/joomla-mcp/issues/39)).
- Normalize combined article text to Joomla's native `introtext` and `fulltext`
  before planning API or companion creates and updates, fixing silently unchanged
  article bodies on Joomla 6 PATCH requests ([#31](https://github.com/joomengine/joomla-mcp/issues/31)).
- Preserve Joomla Read More splitting, clear old full text on complete body
  replacement, and reject ambiguous combined/native text inputs. Native partial
  text updates and title-only updates retain omitted content.

## [0.7.0] - 2026-07-24

### Added

- Packaged `joomla-mcp-live-test` interactive and unattended runner with
  selectable read, CRUD, and full profiles across Joomla API/companion paths
  and stdio/Streamable HTTP MCP transports.
- Deterministic, dependency-aware dummy data for every one of the 36 CRUD
  families, including create, read-back, update, deletion-candidate,
  verification, retention, and cleanup behavior.
- Catalogue coverage gates for every Joomla API and companion action, with the
  five source-only routes reported explicitly instead of silently skipped.
- Redacted Markdown, JSON, JUnit, and per-action evidence with failure codes,
  source references, expected/actual results, dependency/root-cause links,
  exact reproduction commands, fixture identities, and transport diagnostics.
- Complete live-validation documentation for interactive demos, unattended
  sites, CI, safety, cleanup, and failure investigation.

### Changed

- The disposable JoomEngine Joomla 6.1 job now creates an ephemeral API actor
  token, configures the companion actor, and runs the full packaged live suite
  through all four MCP/Joomla path combinations before teardown.
- Template-style CRUD accepts Joomla's required `template` field consistently
  in the API and companion allowlists.
- Insecure Joomla API origins remain rejected except for an explicit
  loopback-only fixture opt-in.

### Compatibility

- Existing library, CLI, HTTP, Docker, systemd, API, companion, catalogue,
  permission, plan/apply, deployment, and release behavior is retained.

## [0.6.0] - 2026-07-23

### Added

- Public `@joomengine/joomla-mcp` ESM library package with TypeScript
  declarations and documented root, configuration, catalogue, adapter, HTTP,
  and security exports.
- Transport-neutral `createJoomlaMcp` application factory with shared runtime
  semantics for stdio, embedded transports, and authenticated HTTP sessions.
- Host injection contracts for audit, Joomla API, and Joomla companion CLI
  adapters.
- Programmatic configuration resolution with asynchronous host-owned secret
  lookup.
- Principal selection for embedded transports without MCP `AuthInfo`.
- Clean-tarball JavaScript import and strict TypeScript consumer tests.
- Coordinated npm, Joomla companion, OCI image, deployment bundle, SBOM,
  checksum, and provenance release workflow.
- Complete library integration, executable host examples, compatibility
  policy, and release documentation.

### Changed

- The existing stdio and HTTP binaries now use the same public application
  factory exported to package consumers.
- Package, companion, fixture, documentation, and release versions are
  synchronized through one version command and release gate.

### Compatibility

- Existing command-line, container, systemd, Joomla API, Joomla companion,
  catalogue, permission, plan, apply, audit, and deployment capabilities are
  retained.

[0.6.0]: https://github.com/joomengine/joomla-mcp/releases/tag/v0.6.0
[0.7.0]: https://github.com/joomengine/joomla-mcp/releases/tag/v0.7.0
