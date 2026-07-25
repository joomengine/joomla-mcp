import { describe, expect, it } from 'vitest';

import {
  crudFixtureDefinitions,
  type LiveFixtureContext,
  type LiveFixtureRecord,
} from '../src/live-test/fixtures.js';
import {
  knownUpstreamLimitation,
  verifiedDeletionLimitation,
  verifiedPartialMutationLimitation,
} from '../src/live-test/known-limitations.js';
import type { LiveTestOptions } from '../src/live-test/types.js';

const pinnedFixture =
  'octoleo/joomengine:6@sha256:5fbcccb6275cc8336d22cad563082e09824bd04e0035bc1837787be8f16b2372';

describe('live fixture Joomla regressions', () => {
  it('generates collision-safe update values for each configured record', () => {
    const fixture = crudFixtureDefinitions.get('users.levels');
    expect(fixture).toBeDefined();
    const context = fixtureContext();
    const record: LiveFixtureRecord = {
      id: 41,
      label: 'Existing access level',
      attributes: { id: 41, title: 'Existing access level' },
    };
    const updates = ['primary', 'secondary', 'deletion'].map((purpose) =>
      fixture!.update(context, record, `configured-${purpose}-updated`));

    expect(new Set(updates.map((update) => update['title'])).size).toBe(3);
  });

  it('uses Joomla-canonical field names and created user ids', () => {
    const records = new Map<string, LiveFixtureRecord>([
      ['field-groups.content-articles', {
        id: 51,
        label: 'Created field group',
        attributes: { id: 51 },
      }],
      ['users.users', {
        id: 61,
        label: 'Created user',
        attributes: { id: 61 },
      }],
    ]);
    const references = new Map<string, LiveFixtureRecord>([
      ['users.users', {
        id: 6,
        label: 'Pre-existing user',
        attributes: { id: 6 },
      }],
    ]);
    const context = fixtureContext(records, references);
    const field = crudFixtureDefinitions.get('fields.content-articles')!.create(context, 'primary');
    const message = crudFixtureDefinitions.get('messages.messages')!.create(context, 'primary');

    expect(field['name']).toMatch(/^jmcp-[a-z0-9-]+$/u);
    expect(String(field['name'])).not.toContain('_');
    expect(message['user_id_to']).toBe(61);
  });

  it('keeps generated language titles within Joomla limits and generated message recipients authorized', () => {
    const context = fixtureContext();
    const language = crudFixtureDefinitions.get('languages.content')!;
    const user = crudFixtureDefinitions.get('users.users')!;
    const record: LiveFixtureRecord = {
      id: 71,
      label: 'Content language',
      attributes: { id: 71 },
    };

    expect(String(language.update(context, record, 'configured-primary-updated')['title']).length)
      .toBeLessThanOrEqual(20);
    expect(user.create(context, 'primary')['groups']).toEqual([7]);
  });

  it('pins the Joomla administrator-menu collection state-key mismatch', () => {
    const limitation = knownUpstreamLimitation({
      options: liveOptions(),
      joomlaPath: 'api',
      scenarioId: 'menus.administrator.list',
      phase: 'verify-created-visible-primary',
      error:
        'menus.administrator.primary (4) is readable by item ID but is absent from menus.administrator.list; it is not certified as visible in Joomla collection/GUI models.',
    });

    expect(limitation?.code).toBe('joomla-6.1.2-administrator-menu-list-state-key');
  });

  it('accepts pinned Joomla deletion errors only after strict collection absence', () => {
    const limitation = verifiedDeletionLimitation({
      options: liveOptions(),
      joomlaPath: 'api',
      scenarioId: 'content.categories.get',
      phase: 'verify-deleted',
      error: 'Joomla API returned HTTP 500: {"errors":{"code":500,"title":"Internal server error"}}',
    });

    expect(limitation?.code).toBe('joomla-6.1.2-category-get-after-delete-500');
    expect(verifiedDeletionLimitation({
      options: liveOptions(),
      joomlaPath: 'cli',
      scenarioId: 'content.categories.get',
      phase: 'verify-deleted',
      error: 'Joomla API returned HTTP 500: {"errors":{"code":500,"title":"Internal server error"}}',
    })).toBeUndefined();
  });

  it('recognizes verified language trash persistence in configured cleanup phases', () => {
    const limitation = verifiedPartialMutationLimitation({
      options: liveOptions(),
      joomlaPath: 'api',
      scenarioId: 'languages.content.update',
      phase: 'cleanup-trash-languages.content.primary',
      error: 'Joomla API returned HTTP 400: Check-in failed with the following error:',
    });

    expect(limitation?.code).toBe('joomla-6.1.2-content-language-update-response-400');
  });
});

function fixtureContext(
  records: ReadonlyMap<string, LiveFixtureRecord> = new Map(),
  references: ReadonlyMap<string, LiveFixtureRecord> = new Map(),
): LiveFixtureContext {
  return {
    lane: 'http-api',
    seed: 'regression',
    get: (baseId) => records.get(baseId),
    reference: (baseId) => references.get(baseId),
  };
}

function liveOptions(): LiveTestOptions {
  return {
    configurationFile: 'config/sites.json',
    site: 'fixture',
    outputDirectory: 'evidence',
    profile: 'crud',
    joomlaPaths: ['api'],
    mcpTransports: ['http'],
    families: [],
    nonInteractive: true,
    confirmMutations: true,
    disposable: true,
    cleanup: true,
    retainDemo: false,
    failFast: false,
    seed: 'regression',
    fixtureDigests: { 'joomla-image': pinnedFixture },
  };
}
