import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { JoomlaWriteService } from '../src/application/joomla-write-service.js';
import { verifyNativeMedia } from '../src/application/native-media-verification.js';
import { SiteRegistry } from '../src/application/site-registry.js';
import type { ApiConfig, Configuration } from '../src/config/schema.js';
import type { JoomlaApiRequest } from '../src/infrastructure/api/joomla-api-client.js';

const root = 'https://example.test/joomla/';
const image = 'images/news/file.jpg#joomlaImage://local-images/news/file.jpg?width=1601&height=701';
const imageBag = { image_intro: image, image_fulltext: 'images/full.jpg', image_intro_alt: 'The heading' };
const actualBag = { ...imageBag, image_intro: `${root}${image}`, image_fulltext: `${root}images/full.jpg` };

function compare(desired: unknown, observed: unknown, baseUrl = root) {
  return verifyNativeMedia('content.articles.update', { images: desired }, { images: observed }, true, baseUrl);
}

describe('native media representation contract', () => {
  it.each([root, root.slice(0, -1)])('uses the configured installation root %s and retains all source values', (baseUrl) => {
    const desired = Object.freeze({ ...imageBag });
    const observed = Object.freeze({ ...actualBag });
    expect(compare(desired, observed, baseUrl)).toMatchObject({ status: 'verified', matchedFields: ['images'] });
    expect(desired).toEqual(imageBag);
    expect(observed).toEqual(actualBag);
  });

  it.each(['content', 'banners', 'contacts', 'newsfeeds'])('compares %s category images with all other params unchanged', (domain) => {
    expect(verifyNativeMedia(`${domain}.categories.create`, { params: { image, image_alt: 'Heading', nested: { order: [1, 2] } } },
      { params: { nested: { order: [1, 2] }, image: `${root}${image}`, image_alt: 'Heading' } }, true, root))
      .toMatchObject({ status: 'verified', matchedFields: ['params'] });
    expect(verifyNativeMedia(`${domain}.categories.update`, { params: { image, image_alt: 'Heading' } },
      { params: { image: `${root}${image}`, image_alt: 'Changed' } }, true, root))
      .toMatchObject({ status: 'uncertain', differentFields: ['params'] });
  });

  it.each([
    ['external origin', `https://cdn.test/joomla/${image}`],
    ['hostname prefix', `https://example.test.evil.test/joomla/${image}`],
    ['different port', `https://example.test:8443/joomla/${image}`],
    ['different scheme', `http://example.test/joomla/${image}`],
    ['sibling installation', `https://example.test/joomla-other/${image}`],
    ['root outside installation', `https://example.test/${image}`],
    ['different file', `${root}images/changed.jpg#joomlaImage://local-images/news/file.jpg?width=1601&height=701`],
    ['different fragment', `${root}images/news/file.jpg#joomlaImage://local-images/news/file.jpg?width=1602&height=701`],
    ['different query', `${root}images/news/file.jpg?download=1#joomlaImage://local-images/news/file.jpg?width=1601&height=701`],
    ['protocol-relative URL', `//example.test/joomla/${image}`],
  ])('does not hide %s differences', (_name, value) => {
    expect(compare(imageBag, { ...actualBag, image_intro: value })).toMatchObject({ status: 'uncertain', differentFields: ['images'] });
  });

  it.each(['', '/images/a.jpg', '//cdn.test/a.jpg', 'https://cdn.test/a.jpg', 'data:image/png;base64,AA',
    '../images/a.jpg', 'images/../a.jpg', './images/a.jpg', 'images/./a.jpg', 'images\\a.jpg'])
    ('does not strip the site root before an ambiguous value %j', (path) => {
      expect(compare({ image_intro: path }, { image_intro: root + path })).toMatchObject({ status: 'uncertain' });
    });

  it('keeps external URLs unchanged and checks non-media strings, shape and ordering strictly', () => {
    expect(compare({ image_intro: 'https://cdn.test/file.jpg' }, { image_intro: 'https://cdn.test/file.jpg' }))
      .toMatchObject({ status: 'verified' });
    expect(compare(imageBag, { ...actualBag, image_intro_alt: root + imageBag.image_intro_alt })).toMatchObject({ status: 'uncertain' });
    expect(compare({ ...imageBag, values: [1, 2] }, { ...actualBag, values: [2, 1] })).toMatchObject({ status: 'uncertain' });
    expect(compare(imageBag, { ...actualBag, extra: true })).toMatchObject({ status: 'uncertain' });
    expect(compare(imageBag, [actualBag])).toMatchObject({ status: 'uncertain' });
  });

  it('accepts ordinary spaces in native media filenames without URL decoding', () => {
    expect(compare({ image_intro: 'images/a b.jpg' }, { image_intro: `${root}images/a b.jpg` }))
      .toMatchObject({ status: 'verified', matchedFields: ['images'] });
    expect(compare({ image_intro: 'images/a b.jpg' }, { image_intro: `${root}images/a%20b.jpg` }))
      .toMatchObject({ status: 'uncertain', differentFields: ['images'] });
  });

  it('accepts native JSON registries and empty registry representation without numeric rounding', () => {
    expect(compare(JSON.stringify(imageBag), actualBag)).toMatchObject({ status: 'verified' });
    expect(compare({}, [])).toMatchObject({ status: 'verified' });
    expect(compare('{"image_intro":"images/a.jpg","count":1.00000000000000001}',
      { image_intro: `${root}images/a.jpg`, count: 1 })).toMatchObject({ status: 'uncertain' });
    expect(compare('{invalid', actualBag)).toMatchObject({ status: 'uncertain' });
  });

  it('limits evidence to reviewed fields and independently identified records', () => {
    expect(verifyNativeMedia('content.articles.update', { title: 'Heading' }, {}, true, root)).toBeUndefined();
    expect(verifyNativeMedia('custom.articles.update', { images: imageBag }, { images: actualBag }, true, root)).toBeUndefined();
    expect(verifyNativeMedia('content.articles.update', { images: imageBag }, {}, true, root))
      .toMatchObject({ status: 'partial', unobservableFields: ['images'] });
    expect(verifyNativeMedia('content.articles.update', { images: imageBag }, { images: actualBag }, false, root))
      .toMatchObject({ status: 'uncertain', matchedFields: [], unobservableFields: ['images'] });
  });
});

describe('native media write execution', () => {
  it.each(['create', 'update'] as const)('verifies article %s through independent GET without rewriting approved data', async (operation) => {
    const { writes, api, audit } = harness();
    const result = await apply(writes, `content.articles.${operation}`, { title: 'Heading', catid: 2, images: imageBag });
    expect(api.request.mock.calls[0]?.[1].body?.['images']).toEqual(imageBag);
    expect(api.get.mock.calls.at(-1)?.[1]).toBe('v1/content/articles/41');
    expect(result['verification']).toMatchObject({ data: { data: { attributes: { images: actualBag } } },
      nativeMediaVerification: { scope: 'native-media-fields', status: 'verified', matchedFields: ['images'] } });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ event: 'write.applied' }));
  });

  it.each(['different-file', 'different-alt', 'wrong-id', 'missing'] as const)('retains %s evidence and does not replay the mutation', async (mode) => {
    const { writes, api, audit } = harness(mode);
    const idempotencyKey = randomUUID();
    const result = await apply(writes, 'content.articles.update', { images: imageBag }, idempotencyKey);
    expect(result['verification']).toMatchObject({ nativeMediaVerification: { status: mode === 'missing' ? 'partial' : 'uncertain' } });
    const replay = await apply(writes, 'content.articles.update', { images: imageBag }, idempotencyKey);
    expect(replay['idempotentReplay']).toBe(true);
    expect(replay['verification']).toEqual(result['verification']);
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ event: mode === 'missing' ? 'write.applied' : 'write.failed' }));
  });
});

function harness(mode = 'match') {
  const configuration: Configuration = {
    defaultSite: 'test', approval: { secret: 'a-secret-that-is-at-least-32-bytes-long', ttlMs: 60_000 },
    sites: new Map([['test', { id: 'test', toolsets: new Set(['content.read', 'content.write']),
      api: { baseUrl: root, tokenEnv: 'TOKEN', token: 'secret', timeoutMs: 30_000, maxResponseBytes: 1_000_000, maxPageSize: 100 } }]]),
  };
  const api = {
    request: vi.fn(async (_config: ApiConfig, _request: JoomlaApiRequest) => ({ status: 200, headers: {}, data: { data: { id: '41' } } })),
    get: vi.fn(async (_config: ApiConfig, _path: string) => ({ status: 200, headers: {}, data: { data: { id: mode === 'wrong-id' ? '99' : '41',
      attributes: mode === 'missing' ? {} : { images: { ...actualBag,
        ...(mode === 'different-file' ? { image_intro: `${root}images/another.jpg` } : {}),
        ...(mode === 'different-alt' ? { image_intro_alt: 'Changed' } : {}),
      } } } } })),
  };
  const audit = { write: vi.fn() };
  return { api, audit, writes: new JoomlaWriteService(configuration, new SiteRegistry(configuration), api, audit) };
}

async function apply(writes: JoomlaWriteService, action: string, data: Record<string, unknown>, idempotencyKey = randomUUID()) {
  const request = await writes.requestPermission({ toolsets: ['content.write'], duration: '30-minutes', reason: 'Verify article media persistence.' });
  await writes.approvePermission(request.requestId, request.acknowledgement);
  const planned = await writes.planAction({ action, input: { ...(action.endsWith('.update') ? { id: 41 } : {}), data }, transport: 'api', idempotencyKey });
  if (!('confirmationToken' in planned)) throw new Error('Expected executable write plan.');
  return writes.apply(planned.confirmationToken);
}
