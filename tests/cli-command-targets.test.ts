import { describe, expect, it } from 'vitest';

import { getJoomlaCliCommandTarget, joomlaCliCommandTargets } from '../src/catalog/cli-command-targets.js';

describe('Joomla CLI command target catalogue', () => {
  it('classifies every stock Joomla 6.1 command exactly once', () => {
    expect(joomlaCliCommandTargets).toHaveLength(38);
    expect(new Set(joomlaCliCommandTargets.map((target) => target.command)).size).toBe(38);
    expect(joomlaCliCommandTargets.filter((target) => target.status === 'implemented')).toHaveLength(19);
    expect(joomlaCliCommandTargets.filter((target) => target.status === 'partial')).toHaveLength(6);
    expect(joomlaCliCommandTargets.filter((target) => target.status === 'gated')).toHaveLength(13);

    for (const target of joomlaCliCommandTargets) {
      expect(target.command).toMatch(/^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/);
      expect(target.owner).toBe('joomla-core');
      expect(target.note.length).toBeGreaterThan(10);
      if (target.status === 'implemented') expect(target.semanticActions.length).toBeGreaterThan(0);
      if (target.status === 'gated') expect(target.semanticActions).toHaveLength(0);
    }
  });

  it('exposes the exact semantic target and never invents arbitrary commands', () => {
    expect(getJoomlaCliCommandTarget('scheduler:run')).toMatchObject({
      status: 'implemented', semanticActions: ['scheduler.tasks.run'],
    });
    expect(getJoomlaCliCommandTarget('database:import')).toMatchObject({ status: 'gated' });
    expect(getJoomlaCliCommandTarget('componentbuilder:push:power')).toBeUndefined();
    expect(getJoomlaCliCommandTarget('shell:run')).toBeUndefined();
  });
});
