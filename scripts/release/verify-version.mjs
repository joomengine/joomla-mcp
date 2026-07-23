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
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const synchronizedVersions = [
  packageVersion,
  lock.version,
  lock.packages?.['']?.version,
  sourceVersion('src/version.ts', /JOOMLA_MCP_VERSION = '([^']+)'/),
  sourceVersion('CHANGELOG.md', /## \[([^\]]+)\]/),
  manifestVersion('companion/pkg_joomlamcp.xml'),
  manifestVersion('companion/plugin/joomlamcp.xml'),
  sourceVersion('companion/build.php', /\$version = '([^']+)'/),
  sourceVersion(
    'companion/plugin/src/Protocol/DescriptionService.php',
    /'version' => '([^']+)'/,
  ),
];

if (synchronizedVersions.some((candidate) => candidate !== version)) {
  throw new Error(
    `Release version ${version} must match every package and companion version `
    + `(found ${synchronizedVersions.join(', ')}).`,
  );
}

const tag = `v${version}`;
const prerelease = version.includes('-');
if (event === 'workflow_dispatch' && inputPrerelease !== prerelease) {
  throw new Error(
    `The prerelease input must be ${String(prerelease)} for SemVer version ${version}.`,
  );
}
const npmTag = prerelease ? 'next' : 'latest';
const output = process.env['GITHUB_OUTPUT'];

if (output !== undefined && output !== '') {
  appendFileSync(
    output,
    `version=${version}\ntag=${tag}\nprerelease=${String(prerelease)}\nnpm_tag=${npmTag}\n`,
    'utf8',
  );
}

process.stdout.write(`${JSON.stringify({ version, tag, prerelease, npmTag })}\n`);

function manifestVersion(path) {
  return sourceVersion(path, /<version>([^<]+)<\/version>/);
}

function sourceVersion(path, pattern) {
  const match = readFileSync(path, 'utf8').match(pattern);
  if (match?.[1] === undefined) {
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
