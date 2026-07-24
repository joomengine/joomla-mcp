import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  incrementPrerelease,
  incrementStable,
  latestVersion,
  parseVersion,
  promotePrerelease,
} from './versioning.mjs';

const STRATEGIES = new Set([
  'auto',
  'current',
  'patch',
  'minor',
  'major',
  'prerelease',
  'promote',
  'exact',
]);
const STATES = new Set(['unreleased', 'partial', 'released']);

export function resolveReleasePlan({
  currentVersion,
  strategy = 'auto',
  exactVersion = '',
  prereleaseId = 'rc',
  currentState = 'unreleased',
  existingVersions = [],
  baseSha = '',
  currentTagSha = '',
}) {
  const current = parseVersion(currentVersion).raw;
  const normalizedStrategy = String(strategy).trim();
  const normalizedExact = String(exactVersion).trim();

  if (!STRATEGIES.has(normalizedStrategy)) {
    throw new Error(`Unsupported release strategy: ${normalizedStrategy || '(empty)'}.`);
  }
  if (!STATES.has(currentState)) {
    throw new Error(`Unsupported current release state: ${currentState || '(empty)'}.`);
  }
  if (normalizedStrategy !== 'exact' && normalizedExact !== '') {
    throw new Error('exact_version may only be supplied when strategy is exact.');
  }

  let target;
  if (normalizedStrategy === 'auto') {
    if (currentState !== 'released') {
      target = current;
    } else if (parseVersion(current).prerelease.length === 0) {
      target = incrementStable(current, 'patch');
    } else {
      target = incrementPrerelease(current, parseVersion(current).prerelease[0]);
    }
  } else if (normalizedStrategy === 'current') {
    target = current;
  } else if (normalizedStrategy === 'patch'
    || normalizedStrategy === 'minor'
    || normalizedStrategy === 'major') {
    target = incrementStable(current, normalizedStrategy);
  } else if (normalizedStrategy === 'prerelease') {
    target = incrementPrerelease(current, prereleaseId);
  } else if (normalizedStrategy === 'promote') {
    target = promotePrerelease(current);
  } else {
    target = parseVersion(normalizedExact).raw;
  }

  if (compareVersions(target, current) < 0) {
    throw new Error(`Release target ${target} is older than repository version ${current}.`);
  }

  const latest = latestVersion(existingVersions);
  if (latest !== undefined && compareVersions(target, latest) < 0) {
    throw new Error(`Release target ${target} is older than immutable tag version ${latest}.`);
  }
  if (
    latest !== undefined
    && compareVersions(target, latest) === 0
    && !(target === current && currentState !== 'unreleased')
  ) {
    throw new Error(`Release target ${target} already has an immutable tag.`);
  }

  const prerelease = parseVersion(target).prerelease.length !== 0;
  const needsBump = target !== current;
  const alreadyReleased = !needsBump && currentState === 'released';
  const sourceSha = !needsBump && currentTagSha !== '' ? currentTagSha : baseSha;

  return Object.freeze({
    current,
    target,
    tag: `v${target}`,
    strategy: normalizedStrategy,
    state: currentState,
    needsBump,
    alreadyReleased,
    prerelease,
    npmTag: prerelease ? 'next' : 'latest',
    latest: latest ?? null,
    baseSha,
    sourceSha,
  });
}

function run() {
  const currentVersion = process.env['RELEASE_CURRENT_VERSION']
    ?? JSON.parse(readFileSync('package.json', 'utf8')).version;
  const plan = resolveReleasePlan({
    currentVersion,
    strategy: process.env['RELEASE_STRATEGY'] ?? 'auto',
    exactVersion: process.env['RELEASE_EXACT_VERSION'] ?? '',
    prereleaseId: process.env['RELEASE_PRERELEASE_ID'] ?? 'rc',
    currentState: process.env['RELEASE_CURRENT_STATE'] ?? 'unreleased',
    existingVersions: (process.env['RELEASE_EXISTING_VERSIONS'] ?? '')
      .split(/\r?\n|,/)
      .map((value) => value.replace(/^v/, '').trim())
      .filter(Boolean),
    baseSha: process.env['RELEASE_BASE_SHA'] ?? '',
    currentTagSha: process.env['RELEASE_CURRENT_TAG_SHA'] ?? '',
  });

  writeOutputs(plan);
  writeSummary(plan);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

function writeOutputs(plan) {
  const output = process.env['GITHUB_OUTPUT'];
  if (output === undefined || output === '') {
    return;
  }

  appendFileSync(output, [
    `current=${plan.current}`,
    `version=${plan.target}`,
    `tag=${plan.tag}`,
    `strategy=${plan.strategy}`,
    `current_state=${plan.state}`,
    `needs_bump=${String(plan.needsBump)}`,
    `already_released=${String(plan.alreadyReleased)}`,
    `prerelease=${String(plan.prerelease)}`,
    `npm_tag=${plan.npmTag}`,
    `latest=${plan.latest ?? ''}`,
    `base_sha=${plan.baseSha}`,
    `source_sha=${plan.sourceSha}`,
    '',
  ].join('\n'), 'utf8');
}

function writeSummary(plan) {
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary === undefined || summary === '') {
    return;
  }

  appendFileSync(summary, [
    '## Release plan',
    '',
    '| Item | Value |',
    '|---|---|',
    `| Strategy | \`${plan.strategy}\` |`,
    `| Repository version | \`${plan.current}\` |`,
    `| Suggested release | \`${plan.target}\` |`,
    `| Git tag | \`${plan.tag}\` |`,
    `| npm channel | \`${plan.npmTag}\` |`,
    `| Current state | \`${plan.state}\` |`,
    `| Version commit needed | \`${String(plan.needsBump)}\` |`,
    `| Source commit | \`${plan.sourceSha || plan.baseSha}\` |`,
    '',
    plan.alreadyReleased
      ? 'This exact release is already public; the workflow will finish as a verified no-op.'
      : 'No mutation occurs until the protected `release` environment is approved.',
    '',
  ].join('\n'), 'utf8');
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
