import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveReleaseState } from '../scripts/release/release-state.mjs';
import {
  incrementPrerelease,
  incrementStable,
  parseVersion,
  promotePrerelease,
} from '../scripts/release/versioning.mjs';

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const stableVersion = '1.2.3';
const validGitSha = 'a'.repeat(40);
const validNpmIntegrity = `sha512-${'A'.repeat(86)}==`;
const validOciDigest = `sha256:${'a'.repeat(64)}`;

describe('release version planning', () => {
  it('suggests the current version until its first release is complete', () => {
    expect(plan({ currentVersion: stableVersion, currentState: 'unreleased' })).toMatchObject({
      current: stableVersion,
      target: stableVersion,
      needsBump: false,
      alreadyReleased: false,
      prerelease: false,
      npmTag: 'latest',
    });
    expect(plan({
      currentVersion: stableVersion,
      currentState: 'partial',
      currentTagSha: 'abc123',
    })).toMatchObject({
      target: stableVersion,
      sourceSha: 'abc123',
      needsBump: false,
    });
  });

  it('suggests the next patch after the current stable release is public', () => {
    const target = increment(stableVersion, 'patch');
    expect(plan({
      currentVersion: stableVersion,
      currentState: 'released',
      existingVersions: [stableVersion],
    })).toMatchObject({
      target,
      tag: `v${target}`,
      needsBump: true,
      npmTag: 'latest',
    });
  });

  it.each([
    ['patch', increment(stableVersion, 'patch')],
    ['minor', increment(stableVersion, 'minor')],
    ['major', increment(stableVersion, 'major')],
  ] as const)('resolves the %s strategy', (strategy, target) => {
    expect(plan({ currentVersion: stableVersion, strategy }))
      .toMatchObject({ strategy, target, needsBump: true });
  });

  it('derives prerelease channels from SemVer instead of an independent checkbox', () => {
    const result = plan({
      currentVersion: stableVersion,
      strategy: 'prerelease',
      prereleaseId: 'rc',
    });
    expect(result.target).toMatch(/-rc\.1$/);
    expect(result).toMatchObject({ prerelease: true, npmTag: 'next' });
  });

  it('continues the existing prerelease channel during auto planning', () => {
    expect(plan({
      currentVersion: '1.3.0-beta.2',
      currentState: 'released',
      currentTagSha: 'beta123',
      existingVersions: ['1.2.3', '1.3.0-beta.2'],
    })).toMatchObject({
      target: '1.3.0-beta.3',
      prerelease: true,
      npmTag: 'next',
    });
    expect(plan({
      currentVersion: '1.3.0-rc.4',
      strategy: 'promote',
      currentState: 'partial',
      currentTagSha: 'rc123',
      existingVersions: ['1.3.0-rc.4'],
    })).toMatchObject({ target: '1.3.0', prerelease: false, npmTag: 'latest' });
  });

  it('rejects contradictory exact input and version regressions', () => {
    expect(() => plan({
      currentVersion: stableVersion,
      strategy: 'patch',
      exactVersion: '9.9.9',
    }))
      .toThrow('only be supplied');
    expect(() => plan({
      currentVersion: stableVersion,
      strategy: 'exact',
      exactVersion: '0.0.1',
    })).toThrow('older than repository version');
  });

  it('advances numeric prereleases and rejects numeric overflow', () => {
    expect(incrementPrerelease('1.2.3-1', '1')).toBe('1.2.3-2');
    expect(() => incrementStable('9007199254740991.0.0', 'major'))
      .toThrow('must not exceed');
    expect(() => incrementPrerelease('1.2.3-rc.9007199254740991', 'rc'))
      .toThrow('must not exceed');
  });
});

describe('transactional version synchronization', () => {
  it('checks the repository version and performs an idempotent update in a fixture', () => {
    expect(runSync(process.cwd(), ['--check']).status).toBe(0);

    const fixture = copyVersionFixture();
    try {
      const next = nextSynchronizedVersion(packageVersion);
      const notes = join(fixture, 'release-notes.md');
      writeFileSync(notes, '## What changed\n\n- Verified automated release.\n', 'utf8');

      const first = runSync(fixture, [next, '--notes-file', notes, '--date', '2026-07-24']);
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        previous: packageVersion,
        version: next,
      });
      expect(runSync(fixture, ['--check']).status).toBe(0);

      const second = runSync(fixture, [next, '--notes-file', notes, '--date', '2026-07-24']);
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout).changed).toEqual([]);

      const changelog = readFileSync(join(fixture, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain(`## [${next}] - 2026-07-24`);
      expect(changelog).toContain(`## [${packageVersion}]`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('continues to validate after synchronizing a prerelease version', () => {
    const fixture = copyVersionFixture();
    try {
      const parsed = parseVersion(packageVersion);
      const prerelease = parsed.prerelease.length === 0
        ? `${parsed.major}.${parsed.minor + 1}.0-rc.1`
        : incrementPrerelease(packageVersion, parsed.prerelease[0]);
      const notes = join(fixture, 'release-notes.md');
      writeFileSync(notes, '- Verified prerelease transition.\n', 'utf8');

      const prereleaseResult = runSync(fixture, [
        prerelease,
        '--notes-file',
        notes,
        '--date',
        '2026-07-24',
      ]);
      expect(prereleaseResult.status, prereleaseResult.stderr).toBe(0);
      expect(runSync(fixture, ['--check']).status).toBe(0);

      const promotion = promotePrerelease(prerelease);
      const promotionResult = runSync(fixture, [
        promotion,
        '--notes-file',
        notes,
        '--date',
        '2026-07-25',
      ]);
      expect(promotionResult.status, promotionResult.stderr).toBe(0);
      expect(runSync(fixture, ['--check']).status).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('preflights every target before writing any file', () => {
    const fixture = copyVersionFixture();
    try {
      const packagePath = join(fixture, 'package.json');
      const before = readFileSync(packagePath, 'utf8');
      const broken = join(fixture, 'companion/build.php');
      writeFileSync(
        broken,
        readFileSync(broken, 'utf8').replace(packageVersion, '9.9.9'),
        'utf8',
      );
      const notes = join(fixture, 'release-notes.md');
      writeFileSync(notes, '- This update must fail.\n', 'utf8');

      const result = runSync(fixture, [
        nextSynchronizedVersion(packageVersion),
        '--notes-file',
        notes,
      ]);
      expect(result.status).not.toBe(0);
      expect(readFileSync(packagePath, 'utf8')).toBe(before);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('release recovery state', () => {
  const complete = {
    currentVersion: stableVersion,
    tagSha: validGitSha,
    releaseStatus: 'public',
    githubPrerelease: false,
    assetsValid: true,
    npmIntegrity: validNpmIntegrity,
    expectedNpmIntegrity: validNpmIntegrity,
    npmChannelVersion: stableVersion,
    ociDigest: validOciDigest,
    expectedOciDigest: validOciDigest,
  };

  it('marks only the globally complete release as released', () => {
    expect(resolveReleaseState(complete)).toBe('released');
    expect(resolveReleaseState({ ...complete, releaseStatus: 'draft' })).toBe('partial');
    expect(resolveReleaseState({ ...complete, npmIntegrity: '' })).toBe('partial');
    expect(resolveReleaseState({ ...complete, npmChannelVersion: '1.2.2' })).toBe('partial');
    expect(resolveReleaseState({ ...complete, ociDigest: '' })).toBe('partial');
  });

  it('recovers tag-only and draft progress from the immutable source anchor', () => {
    expect(resolveReleaseState({ currentVersion: stableVersion, tagSha: validGitSha }))
      .toBe('partial');
    expect(resolveReleaseState({
      currentVersion: stableVersion,
      tagSha: validGitSha,
      releaseStatus: 'draft',
    })).toBe('partial');
  });

  it('fails closed for external-only state, a release without a tag, or corrupt assets', () => {
    expect(() => resolveReleaseState({
      currentVersion: stableVersion,
      releaseStatus: 'draft',
    })).toThrow('without its immutable tag');
    expect(() => resolveReleaseState({
      currentVersion: stableVersion,
      npmIntegrity: validNpmIntegrity,
    })).toThrow('without an immutable source tag');
    expect(() => resolveReleaseState({
      currentVersion: stableVersion,
      ociDigest: validOciDigest,
    })).toThrow('without an immutable source tag');
    expect(() => resolveReleaseState({ ...complete, assetsValid: false }))
      .toThrow('do not satisfy');
    expect(() => resolveReleaseState({ ...complete, githubPrerelease: true }))
      .toThrow('does not match');
  });
});

describe('release metadata sealing', () => {
  it('requires canonical npm and OCI coordinates together', () => {
    const fixture = createAssetFixture(stableVersion);
    try {
      const common = {
        ...process.env,
        RELEASE_VERSION: stableVersion,
        RELEASE_TAG: `v${stableVersion}`,
        RELEASE_COMMIT: validGitSha,
        RELEASE_PRERELEASE: 'false',
      };
      const sealed = spawnSync(
        process.execPath,
        [resolve('scripts/release/render-release-metadata.mjs'), fixture],
        {
          encoding: 'utf8',
          env: {
            ...common,
            RELEASE_NPM_INTEGRITY: validNpmIntegrity,
            RELEASE_OCI_DIGEST: validOciDigest,
          },
        },
      );
      expect(sealed.status, sealed.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(fixture, 'release-manifest.json'), 'utf8')))
        .toMatchObject({
          version: stableVersion,
          commit: validGitSha,
          npm: { integrity: validNpmIntegrity },
          oci: { digest: validOciDigest },
        });

      const partial = spawnSync(
        process.execPath,
        [resolve('scripts/release/render-release-metadata.mjs'), fixture],
        {
          encoding: 'utf8',
          env: { ...common, RELEASE_NPM_INTEGRITY: validNpmIntegrity },
        },
      );
      expect(partial.status).not.toBe(0);
      expect(partial.stderr).toContain('requires both');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('release workflow contract', () => {
  it('uses current publication logic with an immutable tagged source', () => {
    const orchestrator = readFileSync('.github/workflows/release.yml', 'utf8');
    const publication = readFileSync('.github/workflows/publish-release.yml', 'utf8');

    expect(orchestrator).toContain('strategy:');
    expect(orchestrator).toContain('exact_version:');
    expect(orchestrator).not.toContain('Mark the GitHub release as a prerelease');
    expect(orchestrator).toContain('release-${{ github.repository_id }}');
    expect(orchestrator).toContain('environment: release');
    expect(orchestrator).toContain('/collaborators/${actor}/permission');
    expect(orchestrator).toContain('.role_name // .permission');
    expect(orchestrator).toContain("github.run_attempt }}\" != '1'");
    expect(orchestrator).toContain('push --atomic origin');
    expect(orchestrator).toContain('gh workflow run publish-release.yml');
    expect(orchestrator).toContain('--ref main');
    expect(orchestrator).toContain('-f "release_commit=${RELEASE_COMMIT}"');
    expect(orchestrator).not.toContain('--ref "${RELEASE_TAG}"');
    expect(orchestrator).not.toContain('attest-build-provenance');
    expect(publication).toContain('release_commit:');
    expect(publication).toContain("test \"${GITHUB_REF}\" = 'refs/heads/main'");
    expect(publication).toContain('[[ "${RELEASE_COMMIT}" =~ ^[0-9a-f]{40}$ ]]');
    expect(publication).toContain('test "${tag_commit}" = "${RELEASE_COMMIT}"');
    expect(publication).toContain('ref: ${{ needs.verify.outputs.release_commit }}');
    expect(publication).toContain("path <<< \"${source_run}\")\" = '.github/workflows/release.yml'");
  });

  it('stages, seals, and verifies every coordinate before final publication', () => {
    const workflow = readFileSync('.github/workflows/publish-release.yml', 'utf8');
    const npmPublishStepStart = workflow.indexOf(
      '- name: Publish or verify the exact npm package and channel',
    );
    const githubPublishStepStart = workflow.indexOf(
      '- name: Publish the verified GitHub draft last',
    );

    expect(workflow).toContain('release-manifest.json');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('actions/attest-build-provenance@');
    expect(workflow).not.toMatch(/uses:\s+[^#\n]+@v\d/);
    expect(workflow).toContain('--draft');
    expect(workflow).toContain('--tag "${NPM_TAG}"');
    expect(workflow).not.toContain('--tag candidate');
    expect(workflow).toContain('dist.integrity');
    expect(workflow).toContain(':sha-${{ needs.verify.outputs.release_commit }}');
    expect(workflow).toContain('imagetools create');
    expect(workflow).toContain('RELEASE_OCI_DIGEST');
    expect(workflow).toContain('RELEASE_NPM_INTEGRITY');
    expect(workflow).toContain('npm dist-tag add');
    expect(workflow).toContain('gh attestation verify');
    expect(workflow).toContain("steps.image-before.outputs.attested != 'true'");
    expect(workflow).toContain('--prefer-index=false');
    expect(workflow).toContain("release_public == 'true'");
    expect(npmPublishStepStart).toBeGreaterThan(-1);
    expect(githubPublishStepStart).toBeGreaterThan(npmPublishStepStart);
    expect(workflow.indexOf('npm publish "${asset}"'))
      .toBeLessThan(githubPublishStepStart);
    const npmPublishStep = workflow.slice(npmPublishStepStart, githubPublishStepStart);
    expect(npmPublishStep).toContain(
      'asset="${GITHUB_WORKSPACE}/release-assets/joomengine-mcp-for-joomla-${RELEASE_TAG}.tgz"',
    );
    expect(npmPublishStep).toContain('test -f "${asset}"');
    expect(npmPublishStep).not.toContain('asset="release-assets/');
    expect(npmPublishStep).toContain(
      '"${RUNNER_TEMP}/npm-registry-view" \\\n'
      + '            "@joomengine/joomla-mcp@${RELEASE_VERSION}"',
    );
    expect(npmPublishStep).toContain(
      '"${RUNNER_TEMP}/npm-registry-view" \\\n'
      + '            "@joomengine/joomla-mcp@${NPM_TAG}"',
    );
    expect(workflow.indexOf('Verify commit-addressed image provenance'))
      .toBeLessThan(workflow.indexOf('Publish or verify the versioned image coordinate'));
  });
});

function plan(overrides: {
  currentVersion?: string;
  strategy?: string;
  exactVersion?: string;
  prereleaseId?: string;
  currentState?: string;
  existingVersions?: string[];
  currentTagSha?: string;
} = {}) {
  const environment = {
    RELEASE_CURRENT_VERSION: overrides.currentVersion ?? packageVersion,
    RELEASE_STRATEGY: overrides.strategy ?? 'auto',
    RELEASE_EXACT_VERSION: overrides.exactVersion ?? '',
    RELEASE_PRERELEASE_ID: overrides.prereleaseId ?? 'rc',
    RELEASE_CURRENT_STATE: overrides.currentState ?? 'unreleased',
    RELEASE_EXISTING_VERSIONS: (overrides.existingVersions ?? []).join('\n'),
    RELEASE_BASE_SHA: 'base123',
    RELEASE_CURRENT_TAG_SHA: overrides.currentTagSha ?? '',
  };
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/release/plan-version.mjs')],
    { encoding: 'utf8', env: { ...process.env, ...environment } },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim());
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function copyVersionFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'joomla-mcp-version-'));
  const files = runSync(process.cwd(), ['--list-files']).stdout.trim().split('\n');
  for (const path of files) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(path), destination);
  }
  return fixture;
}

function createAssetFixture(version: string) {
  const fixture = mkdtempSync(join(tmpdir(), 'joomla-mcp-assets-'));
  for (const name of [
    `joomengine-mcp-for-joomla-v${version}.tgz`,
    `joomengine-mcp-for-joomla-deployment-v${version}.tar.gz`,
    `joomengine-mcp-for-joomla-v${version}.spdx.json`,
    `pkg_joomlamcp-${version}.zip`,
  ]) {
    writeFileSync(join(fixture, name), `${name}\n`, 'utf8');
  }
  return fixture;
}

function increment(version: string, strategy: 'patch' | 'minor' | 'major') {
  const parts = version.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (strategy === 'patch') {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (strategy === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major + 1}.0.0`;
}

function nextSynchronizedVersion(version: string) {
  return parseVersion(version).prerelease.length === 0
    ? incrementStable(version, 'patch')
    : promotePrerelease(version);
}

function runSync(cwd: string, arguments_: string[]) {
  return spawnSync(
    process.execPath,
    [resolve('scripts/release/sync-version.mjs'), ...arguments_],
    { cwd, encoding: 'utf8' },
  );
}
