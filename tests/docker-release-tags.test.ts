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
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/publish-release.yml', 'utf8');
const imageRepository = 'ghcr.io/joomengine/joomla-mcp';
const sourceDigest = `sha256:${'a'.repeat(64)}`;
const previousDigest = `sha256:${'b'.repeat(64)}`;
const temporaryDirectories: string[] = [];
const immutableStep = 'Publish or verify the versioned image coordinate';
const channelStep = 'Promote and verify the Docker release channel';

interface RegistryImage {
  digest: string;
  version: string;
}

interface Fixture {
  directory: string;
  registryPath: string;
  creationsPath: string;
  outputPath: string;
  version: string;
}

describe('Docker release tag publication', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['1.2.3', 'latest', 'next'],
    ['1.3.0-rc.1', 'next', 'latest'],
  ])('publishes %s aliases and its %s channel from one digest', (version, channel, untouched) => {
    const fixture = createFixture(version, {
      [untouched]: { digest: previousDigest, version: '1.2.0' },
    });

    expectSuccess(runStep(fixture, immutableStep));
    expectSuccess(runStep(fixture, channelStep));

    const registry = readRegistry(fixture);
    for (const tag of [`v${version}`, version, channel]) {
      expect(registry[`${imageRepository}:${tag}`]?.digest).toBe(sourceDigest);
    }
    expect(registry[`${imageRepository}:${untouched}`]?.digest).toBe(previousDigest);
    expect(readCreations(fixture)).toEqual([
      `${imageRepository}:v${version}`,
      `${imageRepository}:${version}`,
      `${imageRepository}:${channel}`,
    ]);
    expect(readFileSync(fixture.outputPath, 'utf8')).toBe(`digest=${sourceDigest}\n`);
  });

  it('recovers a public release with only its v-prefixed alias and is idempotent', () => {
    const fixture = createFixture('1.2.3', {
      'v1.2.3': { digest: sourceDigest, version: '1.2.3' },
      latest: { digest: previousDigest, version: '1.2.2' },
    });

    expectSuccess(runStep(fixture, immutableStep, true));
    expectSuccess(runStep(fixture, channelStep, true));
    expectSuccess(runStep(fixture, immutableStep, true));
    expectSuccess(runStep(fixture, channelStep, true));

    expect(readCreations(fixture)).toEqual([
      `${imageRepository}:1.2.3`,
      `${imageRepository}:latest`,
    ]);
    expect(readRegistry(fixture)[`${imageRepository}:v1.2.3`]?.digest).toBe(sourceDigest);
  });

  it.each(['v1.2.3', '1.2.3'])('refuses to overwrite conflicting immutable alias %s', (tag) => {
    const fixture = createFixture('1.2.3', {
      'v1.2.3': { digest: sourceDigest, version: '1.2.3' },
      [tag]: { digest: previousDigest, version: '1.2.3' },
    });

    expect(runStep(fixture, immutableStep).status).not.toBe(0);
    expect(readCreations(fixture)).toEqual([]);
    expect(readRegistry(fixture)[`${imageRepository}:${tag}`]?.digest).toBe(previousDigest);
  });

  it('refuses a public release source that disagrees with its sealed manifest', () => {
    const fixture = createFixture('1.2.3');
    writeFileSync(
      join(fixture.directory, 'release-assets/release-manifest.json'),
      JSON.stringify({ oci: { digest: previousDigest } }),
    );

    expect(runStep(fixture, immutableStep, true).status).not.toBe(0);
    expect(readCreations(fixture)).toEqual([]);
  });

  it.each([
    ['1.2.3', 'latest', '1.3.0'],
    ['1.3.0-rc.2', 'next', '1.3.0-rc.10'],
  ])('refuses to move %s backwards from %s at %s', (version, channel, publishedVersion) => {
    const fixture = createFixture(version, {
      [channel]: { digest: previousDigest, version: publishedVersion },
    });

    const result = runStep(fixture, channelStep);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to move the Docker channel backwards');
    expect(readCreations(fixture)).toEqual([]);
    expect(readRegistry(fixture)[`${imageRepository}:${channel}`]?.digest).toBe(previousDigest);
  });

  it('refuses a channel with the target version but a different digest', () => {
    const fixture = createFixture('1.2.3', {
      latest: { digest: previousDigest, version: '1.2.3' },
    });

    expect(runStep(fixture, channelStep).status).not.toBe(0);
    expect(readCreations(fixture)).toEqual([]);
  });

  it('rejects an existing channel without a valid version label', () => {
    const fixture = createFixture('1.2.3', {
      latest: { digest: previousDigest, version: 'unversioned' },
    });

    const result = runStep(fixture, channelStep);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid release SemVer');
    expect(readCreations(fixture)).toEqual([]);
  });
});

function createFixture(version: string, tags: Record<string, RegistryImage> = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'docker-release-tags-'));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, 'release-assets'));
  mkdirSync(join(directory, 'scripts/release'), { recursive: true });
  cpSync('scripts/release/versioning.mjs', join(directory, 'scripts/release/versioning.mjs'));
  writeFileSync(
    join(directory, 'release-assets/release-manifest.json'),
    JSON.stringify({ oci: { digest: sourceDigest } }),
  );
  const registryPath = join(directory, 'registry.json');
  const creationsPath = join(directory, 'creations.json');
  const outputPath = join(directory, 'output');
  const registry: Record<string, RegistryImage> = {
    [`${imageRepository}@${sourceDigest}`]: { digest: sourceDigest, version },
  };
  for (const [tag, image] of Object.entries(tags)) {
    registry[`${imageRepository}:${tag}`] = image;
    registry[`${imageRepository}@${image.digest}`] = image;
  }
  writeFileSync(registryPath, JSON.stringify(registry));
  writeFileSync(creationsPath, '[]');
  writeFileSync(outputPath, '');
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const registryPath = process.env.DOCKER_TEST_REGISTRY;
const creationsPath = process.env.DOCKER_TEST_CREATIONS;
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
if (args[0] !== 'buildx' || args[1] !== 'imagetools') process.exit(2);
if (args[2] === 'inspect') {
  const image = registry[args.at(-1)];
  if (!image) process.exit(1);
  if (args[3] === '--format') {
    process.stdout.write(JSON.stringify({ config: { Labels: {
      'org.opencontainers.image.version': image.version,
    } } }));
  } else {
    process.stdout.write('Name: ' + args.at(-1) + '\\nDigest: ' + image.digest + '\\n');
  }
} else if (args[2] === 'create') {
  if (!args.includes('--prefer-index=false')) process.exit(2);
  const source = registry[args.at(-1)];
  const target = args[args.indexOf('--tag') + 1];
  if (!source || !target) process.exit(2);
  registry[target] = source;
  writeFileSync(registryPath, JSON.stringify(registry));
  const creations = JSON.parse(readFileSync(creationsPath, 'utf8'));
  creations.push(target);
  writeFileSync(creationsPath, JSON.stringify(creations));
} else {
  process.exit(2);
}
`, { mode: 0o755 });

  return { directory, registryPath, creationsPath, outputPath, version };
}

function extractStep(name: string): string {
  const marker = `        name: ${name}\n`;
  const simpleMarker = `      - name: ${name}\n`;
  const index = workflow.includes(marker) ? workflow.indexOf(marker) : workflow.indexOf(simpleMarker);
  if (index === -1) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  const end = workflow.indexOf('\n      - ', index);
  const step = workflow.slice(index, end === -1 ? undefined : end);
  const run = step.match(/        run: \|\n([\s\S]*)/);
  if (!run) {
    throw new Error(`Missing workflow Bash: ${name}`);
  }
  return `${run[1].replace(/^ {10}/gm, '')}\n`;
}

function runStep(fixture: Fixture, name: string, releasePublic = false) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', extractStep(name)], {
    cwd: fixture.directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.directory}${delimiter}${process.env.PATH ?? ''}`,
      IMAGE_REPOSITORY: imageRepository,
      RELEASE_VERSION: fixture.version,
      RELEASE_TAG: `v${fixture.version}`,
      SOURCE_DIGEST: sourceDigest,
      RELEASE_PUBLIC: String(releasePublic),
      GITHUB_OUTPUT: fixture.outputPath,
      DOCKER_TEST_REGISTRY: fixture.registryPath,
      DOCKER_TEST_CREATIONS: fixture.creationsPath,
    },
  });
}

function expectSuccess(result: ReturnType<typeof runStep>) {
  expect(result.status, result.stderr).toBe(0);
}

function readRegistry(fixture: Fixture): Record<string, RegistryImage> {
  return JSON.parse(readFileSync(fixture.registryPath, 'utf8'));
}

function readCreations(fixture: Fixture): string[] {
  return JSON.parse(readFileSync(fixture.creationsPath, 'utf8'));
}
