const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(value) {
  const normalized = String(value ?? '').trim();
  const match = normalized.match(SEMVER_PATTERN);

  if (match === null) {
    throw new Error(`Invalid release SemVer: ${normalized || '(empty)'}.`);
  }

  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  for (const identifier of match.slice(1, 4)) {
    if (Number(identifier) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Release numeric identifiers must not exceed ${Number.MAX_SAFE_INTEGER}: ${normalized}.`);
    }
  }
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`Numeric prerelease identifiers must not contain leading zeroes: ${normalized}.`);
    }
    if (/^\d+$/.test(identifier) && Number(identifier) > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Numeric prerelease identifiers must not exceed ${Number.MAX_SAFE_INTEGER}: ${normalized}.`,
      );
    }
  }

  return Object.freeze({
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: Object.freeze(prerelease),
  });
}

export function compareVersions(leftValue, rightValue) {
  const left = typeof leftValue === 'string' ? parseVersion(leftValue) : leftValue;
  const right = typeof rightValue === 'string' ? parseVersion(rightValue) : rightValue;

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];

    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      if (leftIdentifier === rightIdentifier) {
        return 0;
      }
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function incrementStable(value, strategy) {
  const current = parseVersion(value);
  if (current.prerelease.length !== 0) {
    throw new Error(
      `Cannot apply ${strategy} to prerelease ${current.raw}; use prerelease, promote, or exact.`,
    );
  }

  if (strategy === 'patch') {
    return parseVersion(`${current.major}.${current.minor}.${current.patch + 1}`).raw;
  }
  if (strategy === 'minor') {
    return parseVersion(`${current.major}.${current.minor + 1}.0`).raw;
  }
  if (strategy === 'major') {
    return parseVersion(`${current.major + 1}.0.0`).raw;
  }

  throw new Error(`Unsupported stable increment strategy: ${strategy}.`);
}

export function incrementPrerelease(value, prereleaseId = 'rc') {
  const current = parseVersion(value);
  if (current.prerelease.length === 0) {
    validateNamedPrereleaseId(prereleaseId);
    return parseVersion(`${current.major}.${current.minor + 1}.0-${prereleaseId}.1`).raw;
  }

  const identifiers = [...current.prerelease];
  if (identifiers[0] !== prereleaseId) {
    validateNamedPrereleaseId(prereleaseId);
    const candidate =
      `${current.major}.${current.minor}.${current.patch}-${prereleaseId}.1`;
    if (compareVersions(candidate, current) <= 0) {
      throw new Error(
        `Changing prerelease channel from ${identifiers[0]} to ${prereleaseId} would not advance `
        + `${current.raw}; use exact.`,
      );
    }
    return candidate;
  }

  const last = identifiers.at(-1);
  if (last !== undefined && /^\d+$/.test(last)) {
    identifiers[identifiers.length - 1] = String(Number(last) + 1);
  } else {
    identifiers.push('1');
  }

  return parseVersion(
    `${current.major}.${current.minor}.${current.patch}-${identifiers.join('.')}`,
  ).raw;
}

export function promotePrerelease(value) {
  const current = parseVersion(value);
  if (current.prerelease.length === 0) {
    throw new Error(`Version ${current.raw} is already stable.`);
  }
  return `${current.major}.${current.minor}.${current.patch}`;
}

export function latestVersion(values) {
  const parsed = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
    .map((value) => parseVersion(value).raw);
  parsed.sort(compareVersions);
  return parsed.at(-1);
}

function validateNamedPrereleaseId(value) {
  if (!/^[0-9A-Za-z-]+$/.test(value) || /^\d+$/.test(value)) {
    throw new Error(`Invalid prerelease identifier: ${value || '(empty)'}.`);
  }
}
