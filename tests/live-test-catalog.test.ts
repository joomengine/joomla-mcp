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
    ]);
    for (const baseId of crudFixtureOrder) {
      const definition = crudFixtureDefinitions.get(baseId)!;
      const context = {
        lane: 'test-api',
        seed: 'deterministic',
        get: (id: string) => records.get(id),
        reference: (id: string) => references.get(id),
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
});
