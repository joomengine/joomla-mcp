import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseVersion } from './versioning.mjs';

const RELEASE_STATUSES = new Set(['none', 'draft', 'public']);

export function resolveReleaseState({
  currentVersion,
  tagSha = '',
  releaseStatus = 'none',
  githubPrerelease = false,
  assetsValid = false,
  npmIntegrity = '',
  expectedNpmIntegrity = '',
  npmChannelVersion = '',
  ociDigest = '',
  expectedOciDigest = '',
}) {
  const parsedCurrent = parseVersion(currentVersion);
  const current = parsedCurrent.raw;
  const normalizedTagSha = String(tagSha).trim();
  const normalizedStatus = String(releaseStatus).trim();
  const normalizedIntegrity = String(npmIntegrity).trim();
  const normalizedExpectedIntegrity = String(expectedNpmIntegrity).trim();
  const normalizedChannel = String(npmChannelVersion).trim();
  const normalizedDigest = String(ociDigest).trim();
  const normalizedExpectedDigest = String(expectedOciDigest).trim();

  if (!RELEASE_STATUSES.has(normalizedStatus)) {
    throw new Error(`Unsupported GitHub release state: ${normalizedStatus || '(empty)'}.`);
  }
  if (normalizedStatus !== 'none' && normalizedTagSha === '') {
    throw new Error(`GitHub ${normalizedStatus} release exists without its immutable tag.`);
  }
  if (
    normalizedStatus !== 'none'
    && githubPrerelease !== (parsedCurrent.prerelease.length !== 0)
  ) {
    throw new Error('GitHub prerelease state does not match the repository SemVer.');
  }
  if (
    normalizedTagSha === ''
    && (normalizedIntegrity !== '' || normalizedDigest !== '')
  ) {
    throw new Error(
      'External npm or OCI coordinates exist without an immutable source tag; '
      + 'refusing to create a release anchor for unverifiable artifacts.',
    );
  }
  if (normalizedStatus === 'public' && assetsValid !== true) {
    throw new Error('Public GitHub release assets do not satisfy the immutable release contract.');
  }
  validateCoordinates({
    tagSha: normalizedTagSha,
    npmIntegrity: normalizedIntegrity,
    expectedNpmIntegrity: normalizedExpectedIntegrity,
    npmChannelVersion: normalizedChannel,
    ociDigest: normalizedDigest,
    expectedOciDigest: normalizedExpectedDigest,
  });

  const released = normalizedTagSha !== ''
    && normalizedStatus === 'public'
    && assetsValid
    && normalizedIntegrity !== ''
    && normalizedIntegrity === normalizedExpectedIntegrity
    && normalizedChannel === current
    && normalizedDigest !== ''
    && normalizedDigest === normalizedExpectedDigest;
  if (released) {
    return 'released';
  }

  const partial = normalizedTagSha !== '' || normalizedStatus !== 'none';
  return partial ? 'partial' : 'unreleased';
}

function run() {
  const state = resolveReleaseState({
    currentVersion: requiredEnvironment('RELEASE_CURRENT_VERSION'),
    tagSha: process.env['RELEASE_TAG_SHA'] ?? '',
    releaseStatus: process.env['RELEASE_GITHUB_STATUS'] ?? 'none',
    githubPrerelease: process.env['RELEASE_GITHUB_PRERELEASE'] === 'true',
    assetsValid: process.env['RELEASE_ASSETS_VALID'] === 'true',
    npmIntegrity: process.env['RELEASE_NPM_INTEGRITY'] ?? '',
    expectedNpmIntegrity: process.env['RELEASE_EXPECTED_NPM_INTEGRITY'] ?? '',
    npmChannelVersion: process.env['RELEASE_NPM_CHANNEL_VERSION'] ?? '',
    ociDigest: process.env['RELEASE_OCI_DIGEST'] ?? '',
    expectedOciDigest: process.env['RELEASE_EXPECTED_OCI_DIGEST'] ?? '',
  });
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    appendFileSync(output, `current_state=${state}\n`, 'utf8');
  }
  process.stdout.write(`${state}\n`);
}

function validateCoordinates({
  tagSha,
  npmIntegrity,
  expectedNpmIntegrity,
  npmChannelVersion,
  ociDigest,
  expectedOciDigest,
}) {
  if (tagSha !== '' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(tagSha)) {
    throw new Error('Release tag SHA is not a full Git object ID.');
  }
  for (const [label, value] of [
    ['Observed npm integrity', npmIntegrity],
    ['Expected npm integrity', expectedNpmIntegrity],
  ]) {
    if (value !== '' && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) {
      throw new Error(`${label} is not a canonical SHA-512 SRI value.`);
    }
  }
  if (npmChannelVersion !== '') {
    parseVersion(npmChannelVersion);
  }
  for (const [label, value] of [
    ['Observed OCI digest', ociDigest],
    ['Expected OCI digest', expectedOciDigest],
  ]) {
    if (value !== '' && !/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${label} is not a canonical OCI SHA-256 digest.`);
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
