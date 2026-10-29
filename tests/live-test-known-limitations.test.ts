import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';
import { JoomlaApiError } from '../src/infrastructure/api/joomla-api-error.js';

import {
  knownUpstreamLimitation,
  verifiedDeletionLimitation,
  verifiedPartialMutationLimitation,
} from '../src/live-test/known-limitations.js';
import type { LiveTestOptions } from '../src/live-test/types.js';

const pinnedImage =
  'octoleo/joomengine:6@sha256:5fbcccb6275cc8336d22cad563082e09824bd04e0035bc1837787be8f16b2372';

const options: LiveTestOptions = {
  configurationFile: 'config/sites.json',
  outputDirectory: 'live-test-results',
  nonInteractive: true,
  confirmMutations: true,
  disposable: true,
  cleanup: true,
  retainDemo: false,
  failFast: false,
  seed: 'fixture',
  profile: 'full',
  joomlaPaths: ['api', 'cli'],
  mcpTransports: ['stdio', 'http'],
  families: [],
  fixtureDigests: { 'joomla-image': pinnedImage },
};

afterEach(() => vi.unstubAllGlobals());

describe('reviewed live-test limitations', () => {
  it.each([
    { scenarioId: 'messages.messages.create', phase: 'create-primary', status: 404, title: 'Resource not found', shape: 'array', matcher: verifiedPartialMutationLimitation, code: 'joomla-6.1.2-message-create-response-404' },
    { scenarioId: 'contacts.contacts.get', phase: 'verify-deleted', status: 500, title: 'Internal server error', shape: 'object', matcher: verifiedDeletionLimitation, code: 'joomla-6.1.2-contact-get-after-delete-500' },
    { scenarioId: 'newsfeeds.feeds.get', phase: 'verify-deleted', status: 500, title: 'Internal server error', shape: 'object', matcher: verifiedDeletionLimitation, code: 'joomla-6.1.2-newsfeed-get-after-delete-500' },
    { scenarioId: 'content.categories.get', phase: 'verify-deleted', status: 500, title: 'Internal server error', shape: 'object', matcher: verifiedDeletionLimitation, code: 'joomla-6.1.2-category-get-after-delete-500' },
    { scenarioId: 'languages.overrides.refresh', phase: 'write', status: 500, title: 'Internal server error', shape: 'array', matcher: knownUpstreamLimitation, code: 'joomla-6.1.2-language-override-refresh-500' },
    { scenarioId: 'languages.overrides.site.delete', phase: 'write', status: 500, title: 'Internal server error', shape: 'object', matcher: knownUpstreamLimitation, code: 'joomla-6.1.2-language-override-delete-500' },
  ])('recognizes actual bounded API diagnostics only within the reviewed $scenarioId contract', async ({ scenarioId, phase, status, title, shape, matcher, code }) => {
    const nativeError = { code: status, title };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ errors: shape === 'array' ? [nativeError] : nativeError }), {
      status, headers: { 'content-type': 'application/vnd.api+json' },
    })));
    const failure = await new JoomlaApiClient().get({
      baseUrl: 'https://example.test', tokenEnv: 'TOKEN', token: 'test-credential',
      timeoutMs: 30_000, maxResponseBytes: 1024, maxPageSize: 100,
    }, 'v1/extensions').catch((error: unknown) => error) as Error;
    const context = { options, joomlaPath: 'api' as const, scenarioId, phase, error: `MCP tool failed: ${failure.message}` };
    expect(matcher(context)?.code).toBe(code);
    expect(matcher({ ...context, joomlaPath: 'cli' })).toBeUndefined();
    expect(matcher({ ...context, phase: 'unreviewed' })).toBeUndefined();
    expect(matcher({ ...context, scenarioId: 'content.articles.create' })).toBeUndefined();
    expect(matcher({ ...context, options: { ...options, fixtureDigests: {} } })).toBeUndefined();
    for (const error of [
      'Joomla API returned HTTP 500',
      'Joomla API returned HTTP 500: No public JSON:API error details were returned.',
      'Joomla API returned HTTP 500: Invalid field: Source String',
      `Joomla API returned HTTP ${status}: ${title}; another independent error`,
    ]) expect(matcher({ ...context, error })).toBeUndefined();
    if (matcher !== knownUpstreamLimitation) expect(knownUpstreamLimitation(context)).toBeUndefined();
    const privateDetail = new JoomlaApiError(status, { errors: { ...nativeError, detail: 'SQLSTATE[23000]: private query' } });
    expect(matcher({ ...context, error: privateDetail.message })).toBeUndefined();
    for (const nativeError of [
      { code: 409, title: 'Unexpected conflicting mutation', detail: title },
      { code: 409, title },
      { code: status, detail: title },
      { code: status, title, detail: title },
      { title },
    ]) {
      const different = new JoomlaApiError(status, { errors: nativeError });
      expect(matcher({ ...context, error: different.message })).toBeUndefined();
    }
  });

  it('matches only an exact pinned action, phase, path, and error signature', () => {
    const exact = {
      options,
      joomlaPath: 'api' as const,
      scenarioId: 'modules.site.create',
      phase: 'create-showcase',
      error:
        'MCP tool failed: Joomla API returned HTTP 400: {"errors":[{"title":"Save failed with the following error: Field \'params\' doesn\'t have a default value","code":400}]}',
    };
    expect(knownUpstreamLimitation(exact)?.code)
      .toBe('joomla-6.1.2-module-api-create-model-state');
    expect(knownUpstreamLimitation({ ...exact, joomlaPath: 'cli' })).toBeUndefined();
    expect(knownUpstreamLimitation({ ...exact, phase: 'write' })).toBeUndefined();
    expect(knownUpstreamLimitation({ ...exact, error: 'Joomla API returned HTTP 500' }))
      .toBeUndefined();
    expect(knownUpstreamLimitation({ ...exact, error: `${exact.error} [additional diagnostics omitted]` }))
      .toBeUndefined();
    expect(knownUpstreamLimitation({
      ...exact,
      options: {
        ...options,
        fixtureDigests: { 'joomla-image': 'octoleo/joomengine:6' },
      },
    })).toBeUndefined();
  });

  it('requires independent read-back before classifying partial mutations', () => {
    const context = {
      options,
      joomlaPath: 'api' as const,
      scenarioId: 'messages.messages.create',
      phase: 'create-showcase',
      error:
        'Joomla API returned HTTP 404: {"errors":[{"title":"Resource not found","code":404}]}',
    };
    expect(knownUpstreamLimitation(context)).toBeUndefined();
    expect(verifiedPartialMutationLimitation(context)?.code)
      .toBe('joomla-6.1.2-message-create-response-404');

    const replacementContext = {
      ...context,
      scenarioId: 'messages.messages.get',
      phase: 'read-back-updated',
      error: 'Updated messages.messages did not return the expected changed fields.',
    };
    expect(knownUpstreamLimitation(replacementContext)).toBeUndefined();
    expect(verifiedPartialMutationLimitation(replacementContext)?.code)
      .toBe('joomla-6.1.2-message-update-creates-replacement');
  });

  it('requires collection verification before classifying a post-delete item error', () => {
    const context = {
      options,
      joomlaPath: 'api' as const,
      scenarioId: 'messages.messages.get',
      phase: 'verify-deleted',
      error:
        'MCP tool failed: Joomla API returned HTTP 500: {"errors":{"code":500,"title":"Internal server error"}}',
    };
    expect(knownUpstreamLimitation(context)).toBeUndefined();
    expect(verifiedPartialMutationLimitation(context)).toBeUndefined();
    expect(verifiedDeletionLimitation(context)?.code)
      .toBe('joomla-6.1.2-message-get-after-delete-500');
    expect(verifiedDeletionLimitation({ ...context, phase: 'read' })).toBeUndefined();
    expect(verifiedDeletionLimitation({ ...context, scenarioId: 'messages.messages.list' }))
      .toBeUndefined();
  });

  it('matches the pinned Joomla scheduler checkout defect only on the CLI path', () => {
    const context = {
      options,
      joomlaPath: 'cli' as const,
      scenarioId: 'scheduler.tasks.state.set',
      phase: 'write',
      error:
        'Joomla companion NATIVE_COMMAND_FAILED: Joomla command "scheduler:state" exited 1. Output: Change Task State ================= [ERROR] Task ID \'2\' is checked out!',
    };
    expect(knownUpstreamLimitation(context)?.code)
      .toBe('joomla-6.1.2-scheduler-state-null-checkout');
    expect(knownUpstreamLimitation({ ...context, joomlaPath: 'api' })).toBeUndefined();
    expect(knownUpstreamLimitation({ ...context, phase: 'read' })).toBeUndefined();
    expect(knownUpstreamLimitation({
      ...context,
      error: 'Joomla command "scheduler:state" exited 1. Output: permission denied',
    })).toBeUndefined();
  });
});
