import { appendFileSync, readFileSync } from 'node:fs';

const event = requiredEnvironment('RELEASE_EVENT');
const ref = requiredEnvironment('RELEASE_REF');
const refName = requiredEnvironment('RELEASE_REF_NAME');
const inputVersion = process.env['RELEASE_INPUT_VERSION']?.trim() ?? '';
const inputPrerelease = process.env['RELEASE_INPUT_PRERELEASE'] === 'true';

if (event !== 'push' && event !== 'workflow_dispatch') {
  throw new Error(`Unsupported release event: ${event}.`);
}
if (event === 'workflow_dispatch' && ref !== 'refs/heads/main') {
  throw new Error('Manual releases must be dispatched from the main branch.');
}

const version = event === 'workflow_dispatch'
  ? inputVersion
  : refName.startsWith('v')
    ? refName.slice(1)
    : '';

if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error(`Release version is not valid SemVer: ${version || '(empty)'}.`);
}

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const manifestVersions = [
  manifestVersion('companion/pkg_joomlamcp.xml'),
  manifestVersion('companion/plugin/joomlamcp.xml'),
];

if (packageVersion !== version || manifestVersions.some((candidate) => candidate !== version)) {
  throw new Error(
    `Release version ${version} must match package.json and both Joomla companion manifests `
    + `(found ${[packageVersion, ...manifestVersions].join(', ')}).`,
  );
}

const tag = `v${version}`;
const prerelease = event === 'workflow_dispatch' ? inputPrerelease : version.includes('-');
const output = process.env['GITHUB_OUTPUT'];

if (output !== undefined && output !== '') {
  appendFileSync(output, `version=${version}\ntag=${tag}\nprerelease=${String(prerelease)}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify({ version, tag, prerelease })}\n`);

function manifestVersion(path) {
  const match = readFileSync(path, 'utf8').match(/<version>([^<]+)<\/version>/);
  if (match === null) {
    throw new Error(`Unable to read a version from ${path}.`);
  }
  return match[1];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}
