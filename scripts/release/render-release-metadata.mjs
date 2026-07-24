import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { parseVersion } from './versioning.mjs';

const directory = resolve(process.argv[2] ?? 'release-assets');
const parsedVersion = parseVersion(requiredEnvironment('RELEASE_VERSION'));
const version = parsedVersion.raw;
const tag = requiredEnvironment('RELEASE_TAG');
const commit = requiredEnvironment('RELEASE_COMMIT');
const prereleaseInput = requiredEnvironment('RELEASE_PRERELEASE');
if (prereleaseInput !== 'true' && prereleaseInput !== 'false') {
  throw new Error('RELEASE_PRERELEASE must be exactly true or false.');
}
const prerelease = prereleaseInput === 'true';
const npmIntegrity = optionalEnvironment('RELEASE_NPM_INTEGRITY');
const ociDigest = optionalEnvironment('RELEASE_OCI_DIGEST');
if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match version ${version}.`);
}
if (prerelease !== (parsedVersion.prerelease.length !== 0)) {
  throw new Error(`Prerelease flag does not match SemVer ${version}.`);
}
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
  throw new Error(`Release commit is not a full Git object ID: ${commit}.`);
}
if ((npmIntegrity === null) !== (ociDigest === null)) {
  throw new Error('Sealed release metadata requires both npm integrity and OCI digest.');
}
if (npmIntegrity !== null && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(npmIntegrity)) {
  throw new Error('RELEASE_NPM_INTEGRITY is not a canonical SHA-512 SRI value.');
}
if (ociDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(ociDigest)) {
  throw new Error('RELEASE_OCI_DIGEST is not a canonical OCI SHA-256 digest.');
}
const expected = [
  `joomengine-mcp-for-joomla-${tag}.tgz`,
  `joomengine-mcp-for-joomla-deployment-${tag}.tar.gz`,
  `joomengine-mcp-for-joomla-${tag}.spdx.json`,
  `pkg_joomlamcp-${version}.zip`,
].sort();
const actual = readdirSync(directory)
  .filter((name) => !name.startsWith('.'))
  .filter((name) => name !== 'release-manifest.json' && name !== 'SHA256SUMS')
  .sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `Release input assets differ from the exact contract.\n`
    + `Expected: ${expected.join(', ')}\nActual: ${actual.join(', ')}`,
  );
}

const artifacts = expected.map((name) => {
  const path = join(directory, name);
  const content = readFileSync(path);
  return {
    name,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
});
const metadata = {
  schema: 'joomengine.joomla-mcp.release/v1',
  version,
  tag,
  commit,
  prerelease,
  npm: {
    package: '@joomengine/joomla-mcp',
    version,
    tarball: `joomengine-mcp-for-joomla-${tag}.tgz`,
    integrity: npmIntegrity,
  },
  oci: {
    image: `ghcr.io/joomengine/joomla-mcp:${tag}`,
    digest: ociDigest,
  },
  companion: {
    package: `pkg_joomlamcp-${version}.zip`,
    joomla: '6.x',
  },
  artifacts,
};

writeFileSync(
  join(directory, 'release-manifest.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
  'utf8',
);
process.stdout.write(`${JSON.stringify(metadata)}\n`);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function optionalEnvironment(name) {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}
