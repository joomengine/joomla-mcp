# Versioning and releases

One release version identifies every deliverable produced from a single
commit:

| Deliverable | Coordinate |
|---|---|
| Node.js library and CLI | `@joomengine/joomla-mcp@<version>` |
| Installable npm tarball | `joomengine-mcp-for-joomla-v<version>.tgz` |
| Joomla companion | `pkg_joomlamcp-<version>.zip` |
| OCI image | `ghcr.io/joomengine/joomla-mcp:v<version>` |
| Self-hosted deployment bundle | `joomengine-mcp-for-joomla-deployment-v<version>.tar.gz` |
| Source SBOM | `joomengine-mcp-for-joomla-v<version>.spdx.json` |
| Integrity manifest | `SHA256SUMS` |

The package version, root lockfile, TypeScript package identity, Joomla
manifests, companion-reported version, build filename, tests, fixture, and
versioned documentation must agree. The release workflow rejects drift.

## Semantic Versioning

- Patch: compatible security, correctness, documentation, and packaging fixes.
- Minor: additive tools, actions, exports, configuration fields, and
  capabilities.
- Major: removal or incompatible modification of a documented package export,
  MCP tool contract, configuration contract, or supported runtime behavior.
- Prerelease: use a SemVer suffix such as `0.7.0-rc.1`. Prereleases publish to
  the npm `next` tag and are marked as GitHub prereleases.

## Prepare a version

From a clean branch based on `main`:

```bash
npm ci
npm run version:sync -- 0.6.0
npm run validate
php companion/tests/run.php
php companion/build.php
```

Add the new release section at the top of `CHANGELOG.md`. Review every
synchronized change and commit it through the normal pull request process.
`version:sync` does not create changelog prose, commits, or tags.

The validation suite:

- type-checks the public declarations;
- runs the complete offline behavior and security suite;
- checks generated Joomla action documentation;
- builds every JavaScript and declaration entry point;
- inspects the exact npm packlist;
- installs the produced tarball in a clean consumer;
- imports every public subpath from JavaScript;
- compiles a strict TypeScript consumer against the packed declarations.

CI additionally builds the container, validates deployment and rollback
artifacts, tests the PHP companion, installs it in disposable Joomla 6.1, and
runs configured Joomla contract jobs.

## npm registry bootstrap

The package is public and published to npmjs as
`@joomengine/joomla-mcp`. Before the first release:

1. Ensure the `joomengine` organization exists on npm and the release operator
   may publish public scoped packages.
2. Create the package's first public version using the protected `npm`
   GitHub environment and a short-lived granular `NPM_TOKEN` environment
   secret with package publish permission.
3. On the npm package settings, configure the trusted GitHub Actions publisher:
   organization `joomengine`, repository `joomla-mcp`, workflow
   `release.yml`, environment `npm`, action `npm publish`.
4. Remove the `NPM_TOKEN` after trusted publishing succeeds. Later releases
   use GitHub OIDC and npm provenance without a long-lived publishing token.

The package must exist before npm can attach a trusted publisher. The workflow
supports the bootstrap token and the final OIDC configuration without source
changes.

## Publish

After the version pull request is merged, use one of the two equivalent
release entry points:

- push the annotated tag `v<version>` at the version commit; or
- dispatch the **Release** workflow from `main` with the exact version.

The workflow validates the source ref and version before creating anything.
It then builds and attests the npm/deployment artifacts, publishes the exact
tested npm tarball, publishes and attests the OCI image, builds and attests
the Joomla companion, generates the SBOM, creates checksums, and creates the
immutable GitHub release.

Stable versions publish to npm `latest`; SemVer prereleases publish to `next`.
Registry publication is idempotent only when the existing registry integrity
matches the exact tarball produced by the release.

## Recovery

Published npm versions and release assets are immutable. Never replace a
published version:

1. Stop the release if any artifact or registry integrity differs.
2. Correct the source on a new branch.
3. increment the version;
4. run the complete validation suite;
5. publish a new release.

Container and deployment rollback procedures are documented in
[DEPLOYMENT.md](DEPLOYMENT.md).
