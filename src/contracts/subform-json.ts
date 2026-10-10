const maximumBytes = 1_048_576;
const maximumDepth = 64;

/** Compare decoded subform JSON without coercing nested text or losing list order. */
export function equalSubformJson(desired: unknown, observed: unknown): boolean {
  // An explicit empty string is Joomla's supported field clear operation.
  if (desired === '' || observed === '') return desired === '' && observed === '';
  try {
    const expected = decode(desired);
    const actual = decode(observed);
    return isStructure(expected) && isStructure(actual) && equalValue(expected, actual, 0);
  } catch {
    return false;
  }
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string' && !validValue(value, 0)) {
    throw new Error('Subform JSON contains an unsupported value.');
  }
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new Error('Subform JSON exceeds its bounded value contract.');
  }
  const decoded = JSON.parse(encoded) as unknown;
  // Refuse raw numeric spellings that native parsing rounds or underflows.
  // Quoted numbers remain text, and equivalent exact spellings such as 1.0
  // and 1e3 remain comparable without expanding arbitrary exponents.
  for (let offset = 0; offset < encoded.length; offset += 1) {
    if (encoded[offset] === '"') {
      for (offset += 1; offset < encoded.length; offset += 1) {
        if (encoded[offset] === '\\') offset += 1;
        else if (encoded[offset] === '"') break;
      }
      continue;
    }
    if (!/[-0-9]/.test(encoded[offset]!)) continue;
    const start = offset;
    while (offset + 1 < encoded.length && /[-0-9.eE+]/.test(encoded[offset + 1]!)) offset += 1;
    const token = encoded.slice(start, offset + 1);
    const normalized = normalizeNumber(token);
    if (normalized === undefined || normalized !== normalizeNumber(JSON.stringify(Number(token)))) {
      throw new Error('Subform JSON contains a number that cannot round-trip safely.');
    }
  }
  return decoded;
}

function normalizeNumber(token: string): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return undefined;
  const exponentText = (match[4] ?? '0').replace(/^[+-]?0*/, '');
  if (exponentText.replace(/^[+-]/, '').length > 6) return undefined;
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (digits === '') return '0';
  let exponent = Number(match[4] ?? '0') - (match[3]?.length ?? 0);
  const trailingZeros = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailingZeros);
  exponent += trailingZeros;
  return `${match[1]}${digits}e${exponent}`;
}

function validValue(value: unknown, depth: number): boolean {
  if (depth >= maximumDepth) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (!isStructure(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) return false;
  return Object.values(value).every((child) => validValue(child, depth + 1));
}

function equalValue(expected: unknown, actual: unknown, depth: number): boolean {
  if (depth >= maximumDepth) return false;
  if (typeof expected === 'number' || typeof actual === 'number') {
    // JSON.parse rounds oversized integers and converts overflowing exponents to
    // Infinity. Neither can establish a reliable match against persisted values.
    return typeof expected === 'number' && typeof actual === 'number'
      && Number.isFinite(expected) && Number.isFinite(actual)
      && Math.abs(expected) <= Number.MAX_SAFE_INTEGER && Math.abs(actual) <= Number.MAX_SAFE_INTEGER
      && expected === actual;
  }
  if (!isStructure(expected) || !isStructure(actual)) return expected === actual;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (expectedKeys.length !== actualKeys.length) return false;
  return expectedKeys.every((key) => Object.hasOwn(actual, key)
    && equalValue((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], depth + 1));
}

function isStructure(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  return typeof value === 'object' && value !== null;
}
