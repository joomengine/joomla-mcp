import { describe, expect, it } from 'vitest';

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
