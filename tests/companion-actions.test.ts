import { describe, expect, it } from 'vitest';

import {
  companionActions,
  companionReadActions,
  companionStateActions,
  companionWriteActions,
  getCompanionReadAction,
  getCompanionWriteAction,
  normalizeCompanionReadInput,
  normalizeCompanionWriteInput,
} from '../src/catalog/companion-actions.js';

describe('Joomla-native companion action catalogue', () => {
  it('contains only fixed, unique, native capability descriptors', () => {
    expect(companionReadActions).toHaveLength(12);
    expect(companionStateActions).toHaveLength(28);
    expect(companionWriteActions).toHaveLength(39);
    expect(companionActions).toHaveLength(51);
    expect(new Set(companionActions.map((action) => action.id)).size).toBe(companionActions.length);

    for (const action of companionActions) {
      expect(action.inputSchema.additionalProperties).toBe(false);
      expect(['joomla-runtime', 'administrator-model', 'console-command']).toContain(action.native.kind);
      expect(action.native.method).not.toHaveLength(0);
    }
  });

  it('maps operational reads to least-privilege toolsets', () => {
    expect(getCompanionReadAction('cache.groups.list')?.toolset).toBe('maintenance.read');
    expect(getCompanionReadAction('extensions.updates.list')?.toolset).toBe('extensions.read');
    expect(getCompanionReadAction('scheduler.tasks.list')?.toolset).toBe('maintenance.read');
    expect(getCompanionReadAction('core.update.status')?.toolset).toBe('maintenance.read');
    expect(getCompanionReadAction('extensions.update-sites.list')?.toolset).toBe('extensions.read');
    expect(getCompanionReadAction('site.state.get')?.toolset).toBe('maintenance.read');
    expect(getCompanionWriteAction('cache.clean')?.toolset).toBe('maintenance.admin');
    expect(getCompanionWriteAction('scheduler.tasks.run')).toMatchObject({ toolset: 'maintenance.admin', risk: 'high' });
    expect(getCompanionWriteAction('extensions.state.set')).toMatchObject({ toolset: 'extensions.admin', risk: 'high' });
    expect(getCompanionWriteAction('users.users.state')).toBeUndefined();
  });

  it('normalizes bounded read inputs and rejects escape fields', () => {
    expect(normalizeCompanionReadInput('system.info', {})).toEqual({});
    expect(normalizeCompanionReadInput('cache.groups.list', {})).toEqual({ offset: 0, limit: 20 });
    expect(normalizeCompanionReadInput('scheduler.tasks.list', { offset: 20, limit: 5, search: 'daily' }))
      .toEqual({ offset: 20, limit: 5, search: 'daily' });
    expect(normalizeCompanionReadInput('content.articles.get', { id: 7 })).toEqual({ id: 7 });

    expect(() => normalizeCompanionReadInput('cache.groups.list', { component: 'com_users' })).toThrow('Unsupported');
    expect(() => normalizeCompanionReadInput('cache.groups.list', { limit: 101 })).toThrow('between 1 and 100');
    expect(() => normalizeCompanionReadInput('content.articles.get', { id: '../configuration.php' })).toThrow('integer');
    expect(() => normalizeCompanionReadInput('shell.run', {})).toThrow('Unknown');
  });

  it('normalizes only fixed cache and state mutations', () => {
    expect(normalizeCompanionWriteInput('cache.clean', { groups: ['com_content', 'mod_menu'] }))
      .toEqual({ groups: ['com_content', 'mod_menu'] });
    expect(normalizeCompanionWriteInput('content.articles.state', { id: 4, state: 0 }))
      .toEqual({ id: 4, state: 0 });
    expect(normalizeCompanionWriteInput('cache.expired.purge', {})).toEqual({});
    expect(normalizeCompanionWriteInput('extensions.state.set', { id: 12, enabled: false }))
      .toEqual({ id: 12, enabled: false });
    expect(normalizeCompanionWriteInput('scheduler.tasks.state.set', { id: 7, state: -2 }))
      .toEqual({ id: 7, state: -2 });
    expect(normalizeCompanionWriteInput('scheduler.tasks.run', { id: 7 })).toEqual({ id: 7 });
    expect(normalizeCompanionWriteInput('site.state.set', { offline: true })).toEqual({ offline: true });
    expect(normalizeCompanionWriteInput('sessions.data.gc', {})).toEqual({ application: 'site' });

    expect(() => normalizeCompanionWriteInput('cache.clean', { groups: ['../system'] })).toThrow('safe name');
    expect(() => normalizeCompanionWriteInput('cache.clean', { groups: ['same', 'same'] })).toThrow('unique');
    expect(() => normalizeCompanionWriteInput('content.articles.state', { id: 4, state: 3 })).toThrow('between -2 and 2');
    expect(() => normalizeCompanionWriteInput('content.articles.state', { id: 4, state: 1, model: 'Users' }))
      .toThrow('Unsupported');
    expect(() => normalizeCompanionWriteInput('extensions.state.set', { id: 2, enabled: 1 })).toThrow('boolean');
    expect(() => normalizeCompanionWriteInput('scheduler.tasks.run', { id: 2, all: true })).toThrow('Unsupported');
    expect(() => normalizeCompanionWriteInput('sessions.data.gc', { application: 'api' })).toThrow('site or administrator');
    expect(() => normalizeCompanionWriteInput('database.import', {})).toThrow('Unknown');
  });
});
