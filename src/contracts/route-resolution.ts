import type { ReadActionDescriptor, RouteParameterDescriptor } from './action-catalog.js';

const PLACEHOLDER_PATTERN = /:([A-Za-z][A-Za-z0-9_]*)/g;

export function resolveReadActionRoute(
  action: Pick<ReadActionDescriptor, 'routeTemplate' | 'routeParameters'>,
  input: Readonly<Record<string, unknown>> = {},
): `v1/${string}` {
  const expected = new Set(action.routeParameters.map((parameter) => parameter.name));
  const supplied = Object.keys(input);
  const unexpected = supplied.filter((name) => !expected.has(name));

  if (unexpected.length > 0) {
    throw new Error(`Unexpected route parameters: ${unexpected.sort().join(', ')}.`);
  }

  let resolved: string = action.routeTemplate;

  for (const parameter of action.routeParameters) {
    if (!(parameter.name in input)) {
      throw new Error(`Missing required route parameter: ${parameter.name}.`);
    }

    const encoded = encodeRouteParameter(parameter, input[parameter.name]);
    resolved = resolved.replace(`:${parameter.name}`, encoded);
  }

  if (PLACEHOLDER_PATTERN.test(resolved)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    throw new Error('Route template contains an unresolved parameter.');
  }

  PLACEHOLDER_PATTERN.lastIndex = 0;

  if (!/^v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(resolved) || resolved.includes('..')) {
    throw new Error('Resolved Joomla route is unsafe.');
  }

  return resolved as `v1/${string}`;
}

function encodeRouteParameter(parameter: RouteParameterDescriptor, value: unknown): string {
  switch (parameter.kind) {
    case 'positive-integer':
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`${parameter.name} must be a positive integer.`);
      }

      return String(value);
    case 'component-name':
      return encodeValidatedString(parameter, value, /^com_[A-Za-z0-9_]+$/, 'a Joomla component name');
    case 'language-code':
      return encodeValidatedString(parameter, value, /^[a-z]{2,3}-[A-Z]{2}$/, 'a Joomla language code');
    case 'override-constant':
      return encodeValidatedString(parameter, value, /^[A-Z][A-Z0-9_]*$/, 'an uppercase language constant');
    case 'adapter-id':
      return encodeValidatedString(parameter, value, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a media adapter identifier');
    case 'media-path':
      return encodeMediaPath(parameter, value);
  }
}

function encodeValidatedString(
  parameter: RouteParameterDescriptor,
  value: unknown,
  pattern: RegExp,
  expected: string,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > (parameter.maximumLength ?? 255) || !pattern.test(value)) {
    throw new Error(`${parameter.name} must be ${expected}.`);
  }

  return encodeURIComponent(value);
}

function encodeMediaPath(parameter: RouteParameterDescriptor, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > (parameter.maximumLength ?? 1_024)) {
    throw new Error(`${parameter.name} must be a non-empty bounded media path.`);
  }

  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('%') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\0')
  ) {
    throw new Error(`${parameter.name} contains unsafe path syntax.`);
  }

  const segments = value.split('/');

  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${parameter.name} contains an unsafe path segment.`);
  }

  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}
