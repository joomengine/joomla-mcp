import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  VERSION_FILES,
  checkSynchronizedVersion,
  synchronizeVersion,
} from './version-targets.mjs';

export { VERSION_FILES, checkSynchronizedVersion, synchronizeVersion };

function run() {
  const arguments_ = process.argv.slice(2);

  if (arguments_.length === 1 && arguments_[0] === '--list-files') {
    process.stdout.write(`${VERSION_FILES.join('\n')}\n`);
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === '--check') {
    const result = checkSynchronizedVersion();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const nextVersion = arguments_[0];
  if (nextVersion === undefined || nextVersion.startsWith('--')) {
    throw new Error(
      'Usage: sync-version.mjs --check | --list-files | <version> '
      + '--notes-file <path> [--date YYYY-MM-DD]',
    );
  }

  const options = parseOptions(arguments_.slice(1));
  const notesPath = options.get('--notes-file');
  const releaseDate = options.get('--date') ?? new Date().toISOString().slice(0, 10);
  if (notesPath === undefined) {
    throw new Error('--notes-file is required when setting a new version.');
  }

  const result = synchronizeVersion({
    nextVersion,
    notes: readFileSync(notesPath, 'utf8'),
    releaseDate,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseOptions(arguments_) {
  const allowed = new Set(['--notes-file', '--date']);
  const parsed = new Map();

  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name)) {
      throw new Error(`Unknown version synchronization option: ${name ?? '(empty)'}.`);
    }
    if (parsed.has(name)) {
      throw new Error(`Duplicate version synchronization option: ${name}.`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value.`);
    }
    parsed.set(name, value);
  }

  return parsed;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
