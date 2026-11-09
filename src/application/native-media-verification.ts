import { equalSubformJson } from '../contracts/subform-json.js';

export interface NativeMediaVerification {
  readonly scope: 'native-media-fields';
  readonly status: 'verified' | 'partial' | 'uncertain';
  readonly matchedFields: readonly string[];
  readonly differentFields: readonly string[];
  readonly unobservableFields: readonly string[];
}

/** Compare reviewed media bags without changing the approved input or API response. */
export function verifyNativeMedia(
  action: string,
  desired: Readonly<Record<string, unknown>>,
  observed: Readonly<Record<string, unknown>>,
  identified: boolean,
  baseUrl: string,
): NativeMediaVerification | undefined {
  const contract = /^content\.articles\.(?:create|update)$/.test(action)
    ? { field: 'images', media: ['image_intro', 'image_fulltext'] }
    : /^(?:content|banners|contacts|newsfeeds)\.categories\.(?:create|update)$/.test(action)
      ? { field: 'params', media: ['image'] } : undefined;
  if (contract === undefined || !Object.hasOwn(desired, contract.field)) return undefined;
  const matchedFields: string[] = [];
  const differentFields: string[] = [];
  const unobservableFields: string[] = [];
  if (!identified || !Object.hasOwn(observed, contract.field)) {
    unobservableFields.push(contract.field);
  } else {
    const expected = mediaBag(desired[contract.field], contract.media, baseUrl);
    const actual = mediaBag(observed[contract.field], contract.media, baseUrl);
    (expected !== undefined && actual !== undefined && equalSubformJson(expected, actual)
      ? matchedFields : differentFields).push(contract.field);
  }
  return {
    scope: 'native-media-fields',
    status: !identified || differentFields.length > 0 ? 'uncertain' : unobservableFields.length > 0 ? 'partial' : 'verified',
    matchedFields, differentFields, unobservableFields,
  };
}

function mediaBag(value: unknown, media: readonly string[], baseUrl: string): Record<string, unknown> | undefined {
  let decoded = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value) as unknown;
      // Keep the bounded, lossless JSON contract even for numeric fields that
      // happen to share a Registry with a media URL.
      if (!equalSubformJson(value, decoded)) return undefined;
    } catch {
      return undefined;
    }
  }
  // The native empty Registry is serialized as [] rather than {}.
  if (Array.isArray(decoded) && decoded.length === 0) return {};
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
  const result = { ...decoded } as Record<string, unknown>;
  const root = `${baseUrl.replace(/\/$/, '')}/`;
  for (const field of media) {
    const path = result[field];
    // Exact trusted prefix and trailing slash preserve scheme, origin, port,
    // installation directory, query and fragment. Never infer a root from data.
    if (typeof path !== 'string' || !path.startsWith(root)) continue;
    const relative = path.slice(root.length);
    if (relative !== '' && !/^[\/#?]|^[a-z][a-z0-9+.-]*:|[\\\u0000-\u0020\u007f]/i.test(relative)
      && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(relative.split(/[?#]/, 1)[0]!)) {
      result[field] = relative;
    }
  }
  return result;
}
