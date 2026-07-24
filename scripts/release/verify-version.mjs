import { appendFileSync } from 'node:fs';

import { checkSynchronizedVersion } from './version-targets.mjs';
import { parseVersion } from './versioning.mjs';

const version = parseVersion(requiredEnvironment('RELEASE_VERSION')).raw;
const synchronized = checkSynchronizedVersion(process.cwd(), version);
const prerelease = parseVersion(version).prerelease.length !== 0;
const result = {
  version,
  tag: `v${version}`,
  prerelease,
  npmTag: prerelease ? 'next' : 'latest',
  synchronizedFiles: synchronized.files.length,
};
const output = process.env['GITHUB_OUTPUT'];

if (output !== undefined && output !== '') {
  appendFileSync(output, [
    `version=${result.version}`,
    `tag=${result.tag}`,
    `prerelease=${String(result.prerelease)}`,
    `npm_tag=${result.npmTag}`,
    '',
  ].join('\n'), 'utf8');
}

process.stdout.write(`${JSON.stringify(result)}\n`);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}
