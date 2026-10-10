import { describe, expect, it } from 'vitest';

import {
  completeJoomlaApiPatchBody,
  getJoomlaWriteAction,
  requiresJoomlaApiPatchCompletion,
  resolveJoomlaWriteRequest,
} from '../src/catalog/action-catalog.js';
import { joomlaCrudBases } from '../src/catalog/crud-bases.js';

const fields = joomlaCrudBases.filter((base) => base.id.startsWith('fields.'));

describe('native field category assignment contracts', () => {
  it('covers all six contexts without exposing assignments on field groups', () => {
    expect(fields).toHaveLength(6);
    for (const base of joomlaCrudBases.filter((candidate) => candidate.id.startsWith('field-groups.'))) {
      expect(() => resolveJoomlaWriteRequest(base.id + '.create', { data: { assigned_cat_ids: [8] } })).toThrow();
    }
  });

  for (const base of fields) {
    for (const operation of ['create', 'update'] as const) {
      it(base.id + '.' + operation + ' accepts bounded native selections with fixed context', () => {
        const action = base.id + '.' + operation;
        const properties = getJoomlaWriteAction(action)?.inputSchema.properties['data']?.['properties'] as Record<string, unknown>;
        expect(properties['assigned_cat_ids']).toMatchObject({ type: 'array', maxItems: 1_000 });
        for (const assigned of [[8], [12, 8], [], [0], [-1], [0, 8], [-1, 8]]) {
          const request = resolveJoomlaWriteRequest(action, {
            ...(operation === 'update' ? { id: 41 } : {}),
            data: { title: 'Assigned field', assigned_cat_ids: assigned },
          });
          expect(request.body).toMatchObject({ context: base.controllerDefaults['context'], assigned_cat_ids: assigned });
        }
        for (const bad of [null, 8, '8', ['8'], [true], [-2], [2_147_483_648], { a: 8 }, Array(1_001).fill(8)]) {
          expect(() => resolveJoomlaWriteRequest(action, {
            ...(operation === 'update' ? { id: 41 } : {}),
            data: { assigned_cat_ids: bad },
          })).toThrow();
        }
      });
    }
    it(base.id + '.update preserves omitted assignments and honours explicit replacements', () => {
      const action = base.id + '.update';
      expect(requiresJoomlaApiPatchCompletion(action)).toBe(true);
      const current = { assigned_cat_ids: ['12', '8'], unknown: 'hidden' };
      expect(completeJoomlaApiPatchBody(action, current, { title: 'Renamed' })).toMatchObject({
        assigned_cat_ids: [12, 8], title: 'Renamed', context: base.controllerDefaults['context'],
      });
      for (const assigned of [[29], [], [0], [-1]]) {
        expect(completeJoomlaApiPatchBody(action, current, { assigned_cat_ids: assigned })['assigned_cat_ids']).toEqual(assigned);
      }
      expect(completeJoomlaApiPatchBody(action, current, { title: 'Renamed' })).not.toHaveProperty('unknown');
      expect(() => completeJoomlaApiPatchBody(action, { assigned_cat_ids: ['invalid'] }, { title: 'Renamed' })).toThrow();
    });
  }
});
