# Versioning and releases

One release version identifies every deliverable produced from one immutable
source commit:

| Deliverable | Coordinate |
|---|---|
| Node.js library and CLI | `@joomengine/joomla-mcp@<version>` |
| Installable npm tarball | `joomengine-mcp-for-joomla-v<version>.tgz` |
| Joomla companion | `pkg_joomlamcp-<version>.zip` |
| OCI image | `ghcr.io/joomengine/joomla-mcp:v<version>` |
| Self-hosted deployment bundle | `joomengine-mcp-for-joomla-deployment-v<version>.tar.gz` |
| Source SBOM | `joomengine-mcp-for-joomla-v<version>.spdx.json` |
| Machine-readable release contract | `release-manifest.json` |
| Integrity manifest | `SHA256SUMS` |

`package.json` is the release-version authority. The lockfile, TypeScript
package identity, Joomla manifests, companion-reported version, build filename,
tests, fixture, examples, changelog, and versioned documentation are verified
mirrors. `npm run version:check` fails on drift.

## Maintainer release

Open **Actions → Release → Run workflow** on `main`.

For the normal path, leave **strategy** as `auto` and run the workflow:

- if the repository version has no completed release, `auto` proposes that
  current version;
- if the current stable version is already released, `auto` proposes its next
  patch;
- if the current version is a published prerelease, `auto` proposes its next
  prerelease.

For an initialized but unpublished repository, the first `auto` run therefore
proposes the exact value already present in `package.json` instead of skipping
ahead to a patch version.

GitHub cannot put a dynamically calculated value in the workflow-dispatch
form. The read-only **Plan and authorize** job supplies the dynamic suggestion:
it writes the repository version, exact proposed version, tag, npm channel,
release state, and source commit to the run summary. No mutation occurs until
an authorized reviewer approves the protected `release` environment.

The form deliberately has no independent prerelease checkbox. Prerelease state
is derived from SemVer:

- `1.2.3` → normal GitHub release and npm `latest`;
- `1.3.0-rc.1` → GitHub prerelease and npm `next`.

Use **plan only** to calculate and review the same plan without changing Git,
npm, GHCR, or GitHub Releases.

## Strategies

| Strategy | Result |
|---|---|
| `auto` | Current unpublished version; otherwise next patch/prerelease |
| `current` | Release or reconcile the exact version already in `package.json` |
| `patch` | Increment `x.y.z` to `x.y.(z+1)` |
| `minor` | Increment `x.y.z` to `x.(y+1).0` |
| `major` | Increment `x.y.z` to `(x+1).0.0` |
| `prerelease` | Start the next minor prerelease or increment the current prerelease |
| `promote` | Remove the prerelease suffix from the current version |
| `exact` | Use the supplied `exact_version` after monotonic SemVer validation |

`exact_version` is rejected for every strategy except `exact`. Release
versions use SemVer without build metadata, and numeric identifiers may not
exceed JavaScript's safe-integer limit. A release can never move behind either
the repository version or an immutable version tag.

## Release state machine

The one-click path uses two globally serialized workflows. `release.yml`
plans and anchors the source. It then dispatches `publish-release.yml` with
the new tag as that workflow's Git ref. This separation is important:
GitHub OIDC, npm provenance, and artifact attestations therefore name the
actual release commit rather than the pre-bump dispatch commit.

The workflows run these phases:

1. **Plan** — require both the dispatching and triggering actors to have
   `maintain` or `admin`, inspect tags/releases, calculate the suggestion, and
   report the exact proposed release without mutating anything.
2. **Approve source** — pause before mutation at the protected `release`
   environment, then generate authoritative release notes.
3. **Version** — preflight every version target, update all targets in memory,
   prepend the generated changelog entry, run the complete Node and PHP
   validation, then create a release commit when required.
4. **Anchor** — push a bumped main commit and annotated tag together with
   `git push --atomic`. If `main` advanced, neither ref is pushed. An
   unpublished current version only needs the tag.
5. **Dispatch tag publication** — start `publish-release.yml` on the immutable
   tag. The publication workflow independently verifies the source run,
   maintainer, tag, commit, and synchronized version.
6. **Build** — check out the tag commit explicitly and build the
   npm/deployment packages, Joomla companion, and SPDX SBOM with provenance
   rooted in that exact commit.
7. **Stage** — enforce the exact asset allowlist, generate
   `release-manifest.json` and `SHA256SUMS`, and upload the exact set to a
   durable draft GitHub release.
8. **Approve publication** — require the protected `release` environment
   again immediately before any registry publication.
9. **Seal** — publish or verify a commit-addressed OCI image, bind the
   versioned OCI tag to that registry digest, and seal both the OCI digest and
   expected npm SHA-512 integrity into the final release manifest and
   checksums.
10. **Publish** — upload and byte-verify the final draft assets, publish npm
   directly to SemVer-derived `latest` or `next`, verify the registry
   integrity/channel, and make the GitHub release public last.

Git, npm, GHCR, and GitHub Releases cannot participate in one cross-service
transaction. The draft-first, integrity-checked, resumable workflow provides
transaction-like safety without pretending that a distributed atomic commit is
possible.

## One-time repository setup

### Protected environment

Create an environment named `release` and configure:

- required reviewers from the release-maintainer or system-administrator team;
- prevent self-review when at least two maintainers are available;
- deployment refs restricted to branch `main` and tags matching `v*`;
- `NPM_TOKEN` only for the first npm bootstrap release, if required;
- optional `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` for the dedicated
  release GitHub App.

The actor permission check is defense in depth. Environment reviewers are the
human authorization boundary. A normal release asks for approval twice: first
for the version commit/tag and later for external registry publication. The
build and draft-staging work between those gates does not require another
approval.

### Branch and tag rules

Normal development should continue through pull requests. To support the
intentional no-PR release bump:

1. Create a narrowly scoped GitHub App installed only on this repository.
2. Grant it repository contents write permission.
3. Make that App the only bypass actor for the `main` release commit and `v*`
   tag-creation rules.
4. Keep force-push, tag update, and tag deletion disabled.
5. Store its App ID and private key in the protected `release` environment.

When the App secrets are absent, the workflow falls back to `GITHUB_TOKEN`.
That is sufficient only when the repository rules permit Actions to create the
release commit and tag. A protected branch rejection is a configuration
failure; do not weaken the rules for all maintainers to work around it.

Enable immutable GitHub releases for the repository after confirming that the
draft reconciliation path works.

### npm bootstrap and trusted publishing

The package is public as `@joomengine/joomla-mcp`.

For the first publication:

1. Ensure the `joomengine` npm organization exists and the operator may publish
   public scoped packages.
2. Put a short-lived granular bootstrap token in the protected environment as
   `NPM_TOKEN`.
3. Run the release. It publishes directly to `latest` or `next`, as derived
   from SemVer, verifies the exact integrity and channel, then makes the
   already-sealed GitHub release public.
4. Configure npm trusted publishing for organization `joomengine`, repository
   `joomla-mcp`, workflow `publish-release.yml`, environment `release`.
5. Remove `NPM_TOKEN`. Later releases use GitHub OIDC with npm provenance.

Keeping the bootstrap token permanently defeats the purpose of trusted
publishing. A token is needed again only for exceptional repair of a legacy
partial release whose immutable npm version exists but whose dist-tag is
wrong; trusted publishing intentionally cannot edit dist-tags.

## Local version verification

Check the current tree without modifying it:

```bash
npm run version:check
```

Preview the default plan locally:

```bash
RELEASE_CURRENT_STATE=unreleased npm run version:plan
```

The workflow owns normal version updates. For exceptional local preparation,
generate reviewed release notes and run:

```bash
npm run version:sync -- <version> --notes-file /path/to/release-notes.md
npm run validate
php companion/tests/run.php
php companion/build.php
```

The synchronizer preflights every target before its first write, rejects
backward versions, preserves historical changelog entries, and is idempotent
when the requested version is already current.

## Recovery

Dispatch a new run with `auto` or `current` while the current version is
partial. Do not use GitHub's **Re-run jobs** button: every dispatch persists a
fresh release intent and artifact namespace. The workflow resumes from the
immutable source/tag and reconciles each boundary. Recovery executes the
current, reviewed publication workflow from `main`, while all packages and
images are checked out and built from the exact commit anchored by the
immutable release tag. This allows workflow defects to be repaired without
moving a release tag or changing the released source:

- a tag must resolve to the same release commit;
- external npm or OCI state without that source tag is rejected as
  unverifiable rather than retroactively anchored;
- a draft may be updated only for that tag and exact asset allowlist;
- an existing npm version must have the same SHA-512 integrity;
- an existing OCI version tag must have the same manifest digest;
- a public GitHub release must contain the exact byte-for-byte asset set;
- public-release recovery reuses those immutable assets and skips rebuilding
  timestamp-sensitive artifacts such as the SBOM;
- the npm channel must point at the exact version before GitHub publication.

Any identity, integrity, digest, prerelease-state, or asset-contract mismatch
fails closed with the conflicting coordinate. Never delete and recreate a
published npm version, overwrite an OCI version tag, move a release tag, or
replace public release assets. Correct the source and publish a new version.

The machine-readable `release-manifest.json` is the downstream authority for
the version, commit, npm coordinate, OCI coordinate, Joomla compatibility, and
per-artifact SHA-256 hashes. Consumers such as the SaaS layer should pin an
exact released version and promote upgrades only after their own compatibility
canary succeeds.
