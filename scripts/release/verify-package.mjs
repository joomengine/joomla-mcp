import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const requiredExports = ['.', './adapters', './catalog', './config', './http', './security', './package.json'];

assert(manifest.name === '@joomengine/joomla-mcp', 'Unexpected npm package name.');
assert(manifest.private !== true, 'The npm package must not be marked private.');
assert(manifest.type === 'module', 'The npm package must remain ESM.');
assert(manifest.types === './dist/index.d.ts', 'The root declaration entry point is missing.');
assert(manifest.main === './dist/index.js', 'The root JavaScript entry point is missing.');
assert(manifest.publishConfig?.access === 'public', 'Scoped package publication must be explicitly public.');
assert(manifest.publishConfig?.provenance === true, 'npm provenance must remain enabled.');

for (const entry of requiredExports) {
  assert(manifest.exports?.[entry] !== undefined, `Missing package export ${entry}.`);
}

const packed = spawnSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: process.cwd(), encoding: 'utf8', env: process.env },
);

if (packed.status !== 0) {
  throw new Error(`npm pack dry run failed:\n${packed.stderr || packed.stdout}`);
}

const report = JSON.parse(packed.stdout)[0];
const files = new Set(report.files.map((file) => file.path));
const requiredFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/bin/joomla-mcp.js',
  'dist/bin/joomla-mcp-http.js',
  'dist/catalog/index.js',
  'dist/config/index.js',
  'dist/http/index.js',
  'dist/infrastructure/index.js',
  'dist/security/index.js',
  'docs/LIBRARY.md',
  'docs/RELEASING.md',
  'examples/embedded-host/README.md',
  'examples/embedded-host/http.mjs',
  'examples/embedded-host/stdio.mjs',
  'package.json',
];

for (const path of requiredFiles) {
  assert(files.has(path), `Published package is missing ${path}.`);
}

for (const [name, target] of Object.entries(manifest.exports)) {
  if (typeof target === 'string') {
    assert(files.has(stripPrefix(target)), `Export ${name} points to missing file ${target}.`);
    continue;
  }
  for (const [condition, path] of Object.entries(target)) {
    assert(files.has(stripPrefix(path)), `Export ${name} (${condition}) points to missing file ${path}.`);
  }
}

for (const [name, path] of Object.entries(manifest.bin)) {
  assert(files.has(path), `Binary ${name} points to missing file ${path}.`);
}

for (const path of files) {
  assert(!path.startsWith('src/'), `TypeScript source leaked into the package: ${path}.`);
  assert(!path.startsWith('tests/'), `Tests leaked into the package: ${path}.`);
  assert(!path.startsWith('.github/'), `GitHub automation leaked into the package: ${path}.`);
  assert(path !== 'config/sites.json', 'A live site configuration leaked into the package.');
}

assert(report.name === manifest.name, 'Packed package name does not match package.json.');
assert(report.version === manifest.version, 'Packed package version does not match package.json.');
assert(report.unpackedSize < 10_000_000, 'The unpacked npm package unexpectedly exceeds 10 MB.');

process.stdout.write(
  `${JSON.stringify({
    name: report.name,
    version: report.version,
    files: files.size,
    size: report.size,
    unpackedSize: report.unpackedSize,
  })}\n`,
);

function stripPrefix(path) {
  return path.startsWith('./') ? path.slice(2) : path;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
