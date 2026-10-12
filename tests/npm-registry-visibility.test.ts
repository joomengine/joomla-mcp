import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/publish-release.yml', 'utf8');
const temporaryDirectories: string[] = [];

interface RegistryFixture {
  directory: string;
  counter: string;
  helper: string;
  sleepLog: string;
  argumentsLog: string;
}

interface RetryOptions {
  attempts?: number;
  initialDelay?: number;
  maximumDelay?: number;
}

describe('npm registry publication visibility', () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses one bounded registry reader for preflight and publication', () => {
    expect(workflow.match(/\$\{RUNNER_TEMP\}\/npm-registry-view/g)).toHaveLength(6);
    expect(workflow.match(/NPM_REGISTRY_ATTEMPTS=4/g)).toHaveLength(2);
    expect(workflow.match(/NPM_REGISTRY_ATTEMPTS=8/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /test "\$\(\s*npm view "@joomengine\/joomla-mcp@\$\{RELEASE_VERSION\}"/,
    );
  });

  it('retries 404, timeout, and 5xx reads until exact integrity is visible', () => {
    const fixture = createFixture([
      ['1', 'npm error code E404'],
      ['1', 'npm error code ETIMEDOUT'],
      ['1', 'npm error 503 Service Unavailable'],
      ['0', 'sha512-correct'],
    ]);

    const result = runHelper(fixture, 'sha512-correct', 'integrity', {
      attempts: 6,
      initialDelay: 2,
      maximumDelay: 5,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sha512-correct');
    expect(result.stderr).toContain('attempt 1/6');
    expect(result.stderr).toContain('E404');
    expect(result.stderr).toContain('ETIMEDOUT');
    expect(result.stderr).toContain('503 Service Unavailable');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('4');
    expect(readFileSync(fixture.sleepLog, 'utf8')).toBe('2\n4\n5\n');
  });

  it('waits for a stale dist-tag to reach the requested version', () => {
    const fixture = createFixture([
      ['0', '0.6.0'],
      ['0', '0.6.0'],
      ['0', '0.7.0'],
    ]);

    const result = runHelper(fixture, '0.7.0', 'eventual', { attempts: 4 });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.7.0');
    expect(result.stderr).toContain('waiting for 0.7.0');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('3');
  });

  it('fails immediately when a published version has different integrity', () => {
    const fixture = createFixture([
      ['0', 'sha512-different'],
      ['0', 'sha512-correct'],
    ]);

    const result = runHelper(fixture, 'sha512-correct', 'integrity', { attempts: 4 });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unexpected dist.integrity');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('1');
  });

  it('stops after the configured number of unavailable registry reads', () => {
    const fixture = createFixture([
      ['1', 'npm error 504 Gateway Timeout'],
    ]);

    const result = runHelper(fixture, '0.7.0', 'eventual', { attempts: 3 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('after 3 attempts');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('3');
  });

  it('waits beyond five minutes for npm publication with the default retry budget', () => {
    const fixture = createFixture([
      ...Array.from({ length: 14 }, (): [string, string] => ['1', 'npm error code E404']),
      ['0', 'sha512-correct'],
    ]);

    const result = runHelper(fixture, 'sha512-correct', 'integrity');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sha512-correct');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('15');
    const delays = readFileSync(fixture.sleepLog, 'utf8').trim().split('\n').map(Number);
    expect(delays).toEqual([2, 4, 8, 16, ...Array<number>(10).fill(30)]);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(330);
  }, 30_000);

  it('exhausts the default ten-minute delay budget with bounded individual npm reads', () => {
    const fixture = createFixture([['1', 'npm error code ETIMEDOUT']]);

    const result = runHelper(fixture, 'sha512-correct', 'integrity');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('after 24 attempts');
    expect(result.stderr).toContain('npm may still be processing an accepted publication');
    expect(result.stderr).toContain('dispatch Release with strategy=current and exact_version blank');
    expect(result.stdout).toBe('');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('24');
    const delays = readFileSync(fixture.sleepLog, 'utf8').trim().split('\n').map(Number);
    expect(delays).toEqual([2, 4, 8, 16, ...Array<number>(19).fill(30)]);
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(600);

    const invocations = readFileSync(fixture.argumentsLog, 'utf8').trim().split('\n');
    expect(invocations).toHaveLength(24);
    for (const invocation of invocations) {
      expect(invocation.split(' ')).toEqual(expect.arrayContaining([
        'view',
        '@joomengine/joomla-mcp@0.7.0',
        'dist.integrity',
        '--registry=https://registry.npmjs.org',
        '--fetch-retries=0',
        '--fetch-timeout=15000',
      ]));
    }
  }, 30_000);

  it('retries an empty successful response when no expected value was supplied', () => {
    const fixture = createFixture([
      ['0', ''],
      ['0', '0.7.0'],
    ]);

    const result = runHelper(fixture, '', 'eventual', { attempts: 3 });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0.7.0');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('2');
  });

  it('retries empty integrity responses without treating them as immutable mismatches', () => {
    const fixture = createFixture([
      ['0', ''],
      ['0', 'sha512-correct'],
    ]);

    const result = runHelper(fixture, 'sha512-correct', 'integrity', { attempts: 3 });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sha512-correct');
    expect(readFileSync(fixture.counter, 'utf8')).toBe('2');
  });
});

function createFixture(
  responses: Array<[status: string, output: string]>,
): RegistryFixture {
  const directory = mkdtempSync(join(tmpdir(), 'npm-registry-visibility-'));
  temporaryDirectories.push(directory);

  const helper = join(directory, 'npm-registry-view');
  const counter = join(directory, 'counter');
  const responseFile = join(directory, 'responses');
  const fakeNpm = join(directory, 'npm');
  const fakeSleep = join(directory, 'sleep');
  const sleepLog = join(directory, 'sleep.log');
  const argumentsLog = join(directory, 'arguments.log');
  writeFileSync(helper, extractHelper(), { mode: 0o755 });
  writeFileSync(counter, '0');
  writeFileSync(sleepLog, '');
  writeFileSync(argumentsLog, '');
  writeFileSync(
    responseFile,
    responses.map(([status, output]) => `${status}\t${output}`).join('\n'),
  );
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${*}" >> "\${NPM_TEST_ARGUMENTS_LOG}"
count="$(<"\${NPM_TEST_COUNTER}")"
count="$((count + 1))"
printf '%s' "\${count}" > "\${NPM_TEST_COUNTER}"
mapfile -t responses < "\${NPM_TEST_RESPONSES}"
line="\${responses[$((count - 1))]:-\${responses[-1]}}"
status="\${line%%$'\\t'*}"
output="\${line#*$'\\t'}"
if [[ "\${status}" == '0' ]]; then
  printf '%s\\n' "\${output}"
else
  printf '%s\\n' "\${output}" >&2
fi
exit "\${status}"
`);
  chmodSync(fakeNpm, 0o755);
  writeFileSync(fakeSleep, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${1:?delay is required}" >> "\${NPM_TEST_SLEEP_LOG}"
`);
  chmodSync(fakeSleep, 0o755);

  return { directory, counter, helper, sleepLog, argumentsLog };
}

function extractHelper(): string {
  const match = workflow.match(
    /          cat > "\$\{helper\}" <<'NPM_REGISTRY_VIEW'\n([\s\S]*?)\n          NPM_REGISTRY_VIEW/,
  );
  if (!match) {
    throw new Error('Unable to extract npm registry visibility helper.');
  }
  return `${match[1].replace(/^ {10}/gm, '')}\n`;
}

function runHelper(
  fixture: RegistryFixture,
  expected: string,
  mode: 'eventual' | 'integrity',
  options: RetryOptions = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.directory}${delimiter}${process.env.PATH ?? ''}`,
    NPM_TEST_COUNTER: fixture.counter,
    NPM_TEST_RESPONSES: join(fixture.directory, 'responses'),
    NPM_TEST_SLEEP_LOG: fixture.sleepLog,
    NPM_TEST_ARGUMENTS_LOG: fixture.argumentsLog,
    RUNNER_TEMP: fixture.directory,
  };
  // Omitted options exercise the helper's own defaults, regardless of the test runner's environment.
  for (const name of [
    'NPM_REGISTRY_ATTEMPTS',
    'NPM_REGISTRY_INITIAL_DELAY_SECONDS',
    'NPM_REGISTRY_MAX_DELAY_SECONDS',
    'NPM_REGISTRY_URL',
  ]) {
    delete env[name];
  }
  if (options.attempts !== undefined) {
    env.NPM_REGISTRY_ATTEMPTS = String(options.attempts);
  }
  if (options.initialDelay !== undefined) {
    env.NPM_REGISTRY_INITIAL_DELAY_SECONDS = String(options.initialDelay);
  }
  if (options.maximumDelay !== undefined) {
    env.NPM_REGISTRY_MAX_DELAY_SECONDS = String(options.maximumDelay);
  }

  return spawnSync(
    fixture.helper,
    [
      '@joomengine/joomla-mcp@0.7.0',
      mode === 'integrity' ? 'dist.integrity' : 'version',
      expected,
      mode,
    ],
    {
      encoding: 'utf8',
      env,
    },
  );
}
