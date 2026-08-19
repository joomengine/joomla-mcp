# Changelog

All notable changes to the published packages are documented here. Releases
follow Semantic Versioning.

## Unreleased

### Added

- Consume [joomla-mcp-spec](https://github.com/joomengine/joomla-mcp-spec) as
  the shared catalogue source when `JOOMLA_MCP_SPEC` or `specRoot` is set.
  The loader reads `catalog/meta.json`, `catalog/toolsets.json`,
  `catalog/write-fields.json`, `catalog/actions/*.json`, and
  `contracts/mcp-public-tools.json` fail-closed, then maps family documents
  into the existing TypeScript action-descriptor shape.
- Spec overlay prefers extracted spec families while the in-repo catalogue
  remains the fallback for anything the spec has not published yet.
- Spec consumption tests now cover a representative fixture subset
  (`content.articles`, `content.categories`, `tags.tags`, `users.users`,
  `media`) plus every extracted family from a canonical spec checkout when
  present.
- Spec list filters such as `search`, `featured`, and `category` are mapped
  onto Joomla `filter[]` / `list[]` query keys for spec-backed read actions.

### Changed

- Package `homepage`, `bugs`, and `repository` URLs now point at
  `https://github.com/joomengine/joomla-mcp-ts`.
- `@modelcontextprotocol/sdk` is pinned to `1.30.0`.
- npm `overrides` pin `fast-uri@3.1.5`, `ip-address@10.5.0`, `hono@4.13.3`,
  and `@hono/node-server@1.19.17`. `ip-address@10.5.0` clears
  GHSA-mwp4-54f8-5fhr (high; affected range `<=10.3.0`).

### Compatibility

- Existing library, CLI, HTTP, Docker, systemd, API, companion, catalogue,
  permission, plan/apply, deployment, and release behavior is retained when
  no spec root is configured.

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
