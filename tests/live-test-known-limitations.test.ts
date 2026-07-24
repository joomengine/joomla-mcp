import { describe, expect, it } from 'vitest';

import {
  knownUpstreamLimitation,
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

describe('reviewed live-test limitations', () => {
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
  });
});
