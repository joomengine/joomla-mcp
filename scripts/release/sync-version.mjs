import { readFileSync, writeFileSync } from 'node:fs';

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const manifest = readJson('package.json');
const current = manifest.version;
const next = process.argv[2]?.trim() || current;

if (!semver.test(next)) {
  throw new Error(`Invalid SemVer version: ${next || '(empty)'}.`);
}
if (!semver.test(current)) {
  throw new Error(`package.json contains an invalid version: ${current}.`);
}

manifest.version = next;
writeJson('package.json', manifest);

const lock = readJson('package-lock.json');
lock.version = next;
if (lock.packages?.[''] === undefined) {
  throw new Error('package-lock.json is missing the root package record.');
}
lock.packages[''].version = next;
writeJson('package-lock.json', lock);

const synchronizedFiles = [
  'src/version.ts',
  'companion/pkg_joomlamcp.xml',
  'companion/plugin/joomlamcp.xml',
  'companion/build.php',
  'companion/plugin/src/Protocol/DescriptionService.php',
  'companion/tests/run.php',
  'companion/README.md',
  'scripts/fixtures/run-joomengine.sh',
  'tests/release-workflow.test.ts',
  'README.md',
  'docs/LIBRARY.md',
  'docs/RELEASING.md',
  'docs/COVERAGE.md',
  'docs/FIXTURES.md',
  'docs/PHP_COMPANION.md',
  'docs/SINGLE_SITE.md',
  'docs/TROUBLESHOOTING.md',
  'examples/embedded-host/package.json',
];

for (const path of synchronizedFiles) {
  const before = readFileSync(path, 'utf8');
  if (!before.includes(current)) {
    throw new Error(`${path} does not contain the current package version ${current}.`);
  }
  writeFileSync(path, before.replaceAll(current, next));
}

process.stdout.write(`${JSON.stringify({ previous: current, version: next })}\n`);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
