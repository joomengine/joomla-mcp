# Changelog

All notable changes to the published packages are documented here. Releases
follow Semantic Versioning.

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
