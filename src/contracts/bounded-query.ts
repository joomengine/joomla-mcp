import type { JsonSchema } from './action-catalog.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAXIMUM_PAGE_SIZE = 100;
export const MAXIMUM_PAGE_OFFSET = 100_000;

export interface BoundedListQuery {
  readonly offset?: number;
  readonly limit?: number;
}

export const boundedListQueryProperties = Object.freeze({
  offset: Object.freeze({
    type: 'integer',
    minimum: 0,
    maximum: MAXIMUM_PAGE_OFFSET,
    default: 0,
    description: 'Zero-based Joomla collection offset.',
  }),
  limit: Object.freeze({
    type: 'integer',
    minimum: 1,
    maximum: MAXIMUM_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    description: 'Maximum number of resources to return.',
  }),
}) satisfies JsonSchema['properties'];

export const boundedListQuerySchema: JsonSchema = Object.freeze({
  type: 'object',
  properties: boundedListQueryProperties,
  additionalProperties: false,
});

export function normalizeBoundedListQuery(
  input: unknown,
  configuredMaximum = MAXIMUM_PAGE_SIZE,
): Readonly<Record<string, number>> {
  if (!Number.isSafeInteger(configuredMaximum) || configuredMaximum < 1 || configuredMaximum > 500) {
    throw new Error('Configured maximum page size must be an integer between 1 and 500.');
  }

  if (input === undefined) {
    return {
      'page[offset]': 0,
      'page[limit]': Math.min(DEFAULT_PAGE_SIZE, configuredMaximum),
    };
  }

  if (!isPlainObject(input)) {
    throw new Error('List query must be an object.');
  }

  const unknownKeys = Object.keys(input).filter((key) => key !== 'offset' && key !== 'limit');

  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported list query properties: ${unknownKeys.sort().join(', ')}.`);
  }

  const offset = input['offset'] ?? 0;
  const limit = input['limit'] ?? Math.min(DEFAULT_PAGE_SIZE, configuredMaximum);
  assertBoundedInteger(offset, 'offset', 0, MAXIMUM_PAGE_OFFSET);
  assertBoundedInteger(limit, 'limit', 1, Math.min(MAXIMUM_PAGE_SIZE, configuredMaximum));

  return {
    'page[offset]': offset,
    'page[limit]': limit,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertBoundedInteger(value: unknown, name: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
