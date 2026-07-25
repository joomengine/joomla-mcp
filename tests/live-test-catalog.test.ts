import { describe, expect, it } from 'vitest';

import { sourceOnlyActionGates } from '../src/catalog/action-gates.js';
import { joomlaActions } from '../src/catalog/action-catalog.js';
import { companionActions } from '../src/catalog/companion-actions.js';
import { liveScenarioCatalog } from '../src/live-test/catalog.js';
import {
  assertCompleteCrudFixtures,
  crudFixtureDefinitions,
  crudFixtureOrder,
  type LiveFixtureRecord,
} from '../src/live-test/fixtures.js';

describe('live-test catalogue', () => {
  it('covers every Joomla API and companion action from the authoritative catalogues', () => {
    const scenarios = liveScenarioCatalog();
    const ids = new Set(scenarios.map((scenario) => scenario.id));

    expect(joomlaActions.every((action) => ids.has(action.id))).toBe(true);
    expect(companionActions.every((action) => ids.has(action.id))).toBe(true);
    expect(ids.size).toBe(scenarios.length);
    expect(scenarios.filter((scenario) => scenario.sourceOnlyReason !== undefined).map((scenario) => scenario.id).sort())
      .toEqual(Object.keys(sourceOnlyActionGates).sort());
    expect(scenarios.every((scenario) =>
      scenario.sourceOnlyReason !== undefined || scenario.joomlaPaths.length > 0)).toBe(true);
  });

  it('provides deterministic create and update fixtures for every CRUD family', () => {
    expect(assertCompleteCrudFixtures).not.toThrow();
    expect(crudFixtureOrder).toHaveLength(crudFixtureDefinitions.size);

    const records = new Map<string, LiveFixtureRecord>();
    const references = new Map<string, LiveFixtureRecord>([
      ['templates.site-styles', {
        id: 1, attributes: { template: 'cassiopeia' }, label: 'Cassiopeia',
      }],
      ['templates.administrator-styles', {
        id: 2, attributes: { template: 'atum' }, label: 'Atum',
      }],
      ['users.users', {
        id: 3, attributes: { name: 'Fixture administrator' }, label: 'Fixture administrator',
      }],
    ]);
    for (const baseId of crudFixtureOrder) {
      const definition = crudFixtureDefinitions.get(baseId)!;
      const context = {
        lane: 'test-api',
        seed: 'deterministic',
        get: (id: string) => records.get(id),
        reference: (id: string) => references.get(id),
        actor: () => references.get('users.users'),
      };
      const showcase = definition.create(context, 'showcase');
      const deletion = definition.create(context, 'deletion');
      const update = definition.update(context, { id: 100, attributes: showcase, label: baseId });

      expect(Object.keys(showcase).length).toBeGreaterThan(0);
      expect(Object.keys(deletion).length).toBeGreaterThan(0);
      expect(Object.keys(update).length).toBeGreaterThan(0);
      expect(showcase).not.toEqual(deletion);
      records.set(baseId, { id: records.size + 100, attributes: showcase, label: baseId });
    }
  });

  it('uses values accepted by both the API and companion fixture lanes', () => {
    const existingUser: LiveFixtureRecord = {
      id: 42,
      attributes: { name: 'Fixture administrator' },
      label: 'Fixture administrator',
    };
    const context = {
      lane: 'test-cli',
      seed: 'accepted-values',
      get: (_id: string) => undefined,
      reference: (id: string) => id === 'users.users' ? existingUser : undefined,
      actor: () => existingUser,
    };

    expect(crudFixtureDefinitions.get('content.articles')?.create({
      ...context,
      get: () => ({ id: 7, attributes: {}, label: 'Category' }),
    }, 'showcase')).toMatchObject({ introtext: expect.any(String), fulltext: '' });
    expect(crudFixtureDefinitions.get('messages.messages')?.create(context, 'showcase'))
      .toMatchObject({ user_id_to: 42 });
    expect(crudFixtureDefinitions.get('banners.clients')?.create(context, 'showcase'))
      .toHaveProperty('extrainfo', '');
    const showcaseLanguage = crudFixtureDefinitions.get('languages.content')?.create(context, 'showcase');
    const deletionLanguage = crudFixtureDefinitions.get('languages.content')?.create(context, 'deletion');
    expect(showcaseLanguage).toMatchObject({ sef: expect.stringMatching(/^x[a-z]{4}$/u), image: '' });
    expect(deletionLanguage).toMatchObject({ sef: expect.stringMatching(/^x[a-z]{4}$/u), image: '' });
    expect(showcaseLanguage?.['sef']).not.toBe(deletionLanguage?.['sef']);
    expect(crudFixtureDefinitions.get('modules.site')?.create(context, 'showcase'))
      .toMatchObject({ params: { prepare_content: 0, layout: '_:default' } });
    expect(crudFixtureDefinitions.get('modules.site')?.update(context, {
      id: 7,
      attributes: {},
      label: 'Module',
    })).toMatchObject({ params: { layout: '_:default' } });
  });
});
