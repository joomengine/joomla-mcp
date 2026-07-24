import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { compareVersions, parseVersion } from './versioning.mjs';

const STRUCTURED_TARGETS = Object.freeze([
  {
    path: 'src/version.ts',
    pattern: /JOOMLA_MCP_VERSION = '([^']+)'/,
  },
  {
    path: 'companion/pkg_joomlamcp.xml',
    pattern: /<version>([^<]+)<\/version>/,
  },
  {
    path: 'companion/plugin/joomlamcp.xml',
    pattern: /<version>([^<]+)<\/version>/,
  },
  {
    path: 'companion/build.php',
    pattern: /\$version = '([^']+)'/,
  },
  {
    path: 'companion/plugin/src/Protocol/DescriptionService.php',
    pattern: /'version' => '([^']+)'/,
  },
]);

const LITERAL_TARGETS = Object.freeze([
  'companion/tests/run.php',
  'companion/README.md',
  'scripts/fixtures/run-joomengine.sh',
  'tests/library-api.test.ts',
  'README.md',
  'docs/LIBRARY.md',
  'docs/COVERAGE.md',
  'docs/FIXTURES.md',
  'docs/PHP_COMPANION.md',
  'docs/SINGLE_SITE.md',
  'docs/TROUBLESHOOTING.md',
  'examples/embedded-host/package.json',
]);

export const VERSION_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
  ...STRUCTURED_TARGETS.map(({ path }) => path),
  ...LITERAL_TARGETS,
]);

export function checkSynchronizedVersion(root = process.cwd(), expectedVersion) {
  const packagePath = absolute(root, 'package.json');
  const manifest = readJson(packagePath);
  const version = parseVersion(expectedVersion ?? manifest.version).raw;
  const mismatches = [];

  if (manifest.version !== version) {
    mismatches.push(`package.json contains ${String(manifest.version)}, expected ${version}`);
  }

  const lock = readJson(absolute(root, 'package-lock.json'));
  if (lock.version !== version) {
    mismatches.push(`package-lock.json root contains ${String(lock.version)}, expected ${version}`);
  }
  if (lock.packages?.['']?.version !== version) {
    mismatches.push(
      `package-lock.json packages[""] contains ${String(lock.packages?.['']?.version)}, `
      + `expected ${version}`,
    );
  }

  for (const target of STRUCTURED_TARGETS) {
    const content = readRequired(root, target.path);
    const matches = capturedMatches(content, target.pattern);
    if (matches.length !== 1) {
      mismatches.push(
        `${target.path} contains ${matches.length} required version fields, expected exactly 1`,
      );
    } else if (matches[0] !== version) {
      mismatches.push(`${target.path} contains ${matches[0]}, expected ${version}`);
    }
  }

  for (const path of LITERAL_TARGETS) {
    const content = readRequired(root, path);
    if (!content.includes(version)) {
      mismatches.push(`${path} does not contain current version ${version}`);
    }
  }

  const changelog = readRequired(root, 'CHANGELOG.md');
  const changelogVersion = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
  if (changelogVersion !== version) {
    mismatches.push(
      `CHANGELOG.md first release is ${String(changelogVersion)}, expected ${version}`,
    );
  }

  if (mismatches.length !== 0) {
    throw new Error(`Version synchronization failed:\n- ${mismatches.join('\n- ')}`);
  }

  return Object.freeze({ version, files: VERSION_FILES });
}

export function synchronizeVersion({
  root = process.cwd(),
  nextVersion,
  notes,
  releaseDate = new Date().toISOString().slice(0, 10),
}) {
  const manifest = readJson(absolute(root, 'package.json'));
  const current = parseVersion(manifest.version).raw;
  const next = parseVersion(nextVersion).raw;

  checkSynchronizedVersion(root, current);
  if (compareVersions(next, current) < 0) {
    throw new Error(`Refusing to move version backwards from ${current} to ${next}.`);
  }
  if (next === current) {
    return Object.freeze({ previous: current, version: next, changed: [] });
  }
  if (typeof notes !== 'string' || notes.trim() === '') {
    throw new Error('Generated release notes are required when changing the release version.');
  }
  if (!isCalendarDate(releaseDate)) {
    throw new Error(`Invalid release date: ${releaseDate}.`);
  }

  const updates = new Map();
  const nextManifest = { ...manifest, version: next };
  updates.set('package.json', formatJson(nextManifest));

  const lock = readJson(absolute(root, 'package-lock.json'));
  if (lock.packages?.[''] === undefined) {
    throw new Error('package-lock.json is missing the root package record.');
  }
  lock.version = next;
  lock.packages[''].version = next;
  updates.set('package-lock.json', formatJson(lock));

  for (const target of STRUCTURED_TARGETS) {
    const before = readRequired(root, target.path);
    const matches = capturedMatches(before, target.pattern);
    if (matches.length !== 1 || matches[0] !== current) {
      throw new Error(`${target.path} is not synchronized with ${current}.`);
    }
    updates.set(target.path, before.replace(target.pattern, (whole, found) =>
      whole.replace(found, next)));
  }

  for (const path of LITERAL_TARGETS) {
    const before = readRequired(root, path);
    if (!before.includes(current)) {
      throw new Error(`${path} does not contain the current package version ${current}.`);
    }
    updates.set(path, before.replaceAll(current, next));
  }

  const changelog = readRequired(root, 'CHANGELOG.md');
  if (changelog.includes(`## [${next}]`)) {
    throw new Error(`CHANGELOG.md already contains release ${next}.`);
  }
  const currentHeading = `## [${current}]`;
  const headingIndex = changelog.indexOf(currentHeading);
  if (headingIndex < 0) {
    throw new Error(`CHANGELOG.md does not contain current release heading ${currentHeading}.`);
  }
  const normalizedNotes = demoteHeadings(notes.replace(/\r\n?/g, '\n').trim());
  const releaseSection = `## [${next}] - ${releaseDate}\n\n${normalizedNotes}\n\n`;
  const releaseLink = `[${next}]: https://github.com/joomengine/joomla-mcp/releases/tag/v${next}`;
  if (new RegExp(`^\\[${escapeRegExp(next)}\\]:`, 'm').test(changelog)) {
    throw new Error(`CHANGELOG.md already defines a link for release ${next}.`);
  }
  updates.set(
    'CHANGELOG.md',
    `${changelog.slice(0, headingIndex)}${releaseSection}${changelog.slice(headingIndex).trimEnd()}`
      + `\n${releaseLink}\n`,
  );

  const changed = [];
  for (const [path, content] of updates) {
    const before = readRequired(root, path);
    if (before === content) {
      continue;
    }
    changed.push(path);
  }

  commitUpdates(root, changed, updates, () => checkSynchronizedVersion(root, next));
  return Object.freeze({ previous: current, version: next, changed: Object.freeze(changed) });
}

function demoteHeadings(notes) {
  return notes.replace(/^(#{2,5}) /gm, '#$1 ');
}

function absolute(root, path) {
  return resolve(root, path);
}

function readRequired(root, path) {
  const location = absolute(root, path);
  if (!existsSync(location)) {
    throw new Error(`Required version target is missing: ${path}.`);
  }
  return readFileSync(location, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function capturedMatches(content, pattern) {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  return [...content.matchAll(global)].map((match) => match[1]);
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commitUpdates(root, changed, updates, validate) {
  const transaction = randomUUID();
  let committed = false;
  const entries = changed.map((path) => {
    const destination = absolute(root, path);
    return {
      path,
      destination,
      temporary: `${destination}.release-tmp-${transaction}`,
      backup: `${destination}.release-backup-${transaction}`,
      backupCreated: false,
      installed: false,
    };
  });

  try {
    for (const entry of entries) {
      writeFileSync(entry.temporary, updates.get(entry.path), {
        encoding: 'utf8',
        mode: statSync(entry.destination).mode,
        flag: 'wx',
      });
    }

    for (const entry of entries) {
      renameSync(entry.destination, entry.backup);
      entry.backupCreated = true;
      renameSync(entry.temporary, entry.destination);
      entry.installed = true;
    }

    validate();
    committed = true;

    for (const entry of entries) {
      unlinkSync(entry.backup);
      entry.backupCreated = false;
    }
  } catch (error) {
    if (committed) {
      throw error;
    }
    const rollbackErrors = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed && existsSync(entry.destination)) {
          unlinkSync(entry.destination);
        }
        if (entry.backupCreated && existsSync(entry.backup)) {
          renameSync(entry.backup, entry.destination);
          entry.backupCreated = false;
        }
        if (existsSync(entry.temporary)) {
          unlinkSync(entry.temporary);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length !== 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Version synchronization failed and rollback was incomplete.',
      );
    }
    throw error;
  } finally {
    for (const entry of entries) {
      if (existsSync(entry.temporary)) {
        unlinkSync(entry.temporary);
      }
      if (existsSync(entry.backup) && !entry.backupCreated) {
        unlinkSync(entry.backup);
      }
    }
  }
}
