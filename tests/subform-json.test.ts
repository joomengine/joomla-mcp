import { describe, expect, it } from 'vitest';

import { compareSubformCustomField, type ResolvedCustomField } from '../src/application/custom-fields.js';
import { equalSubformJson } from '../src/contracts/subform-json.js';
import { assertChangedFields } from '../src/live-test/runner.js';

const field: ResolvedCustomField = { name: 'modals', type: 'subform', context: 'com_content.article' };
const matches = [
  ['{"row0": {"text": "équipe / 团队", "url": "https://askv.nl"}}', '{"row0":{"url":"https:\\/\\/askv.nl","text":"\\u00e9quipe \\/ \\u56e2\\u961f"}}'],
  ['{"row0":{"items":[1,true,null,"1"]},"row1":{}}', '{"row1":{},"row0":{"items":[1.0,true,null,"1"]}}'],
  [{ row0: { text: '{"literal": "do not parse this text"}' } }, '{"row0":{"text":"{\\"literal\\": \\"do not parse this text\\"}"}}'],
  [[], '[]'], [{}, '{}'], ['', ''],
  ['{"values":[0.1,1e3,1.0,0,-0]}', '{"values":[0.10,1000,1,-0,0]}'],
  ['{"text":"1e-400 9007199254740990.1"}', '{"text":"1e-400 9007199254740990.1"}'],
] as const;
const differences: readonly (readonly [unknown, unknown])[] = [
  ['{"row0":{"text":"approved"}}', '{"row0":{"text":"changed"}}'],
  ['{"row0":{"text":"approved"}}', '{"row0":{}}'],
  ['{"row0":{}}', '{"row0":{"extra":true}}'],
  ['{"row0":{"values":[1,2]}}', '{"row0":{"values":[2,1]}}'],
  ['{"row0":{"values":[1,2]}}', '{"row0":{"values":[1]}}'],
  ['{"row0":{"value":"1"}}', '{"row0":{"value":1}}'],
  ['{"row0":{"value":false}}', '{"row0":{"value":0}}'],
  ['{"row0":{"value":null}}', '{"row0":{"value":""}}'],
  ['{"row0":{"text":"{\\"a\\":1,\\"b\\":2}"}}', '{"row0":{"text":"{\\"b\\":2,\\"a\\":1}"}}'],
  ['{"row0":{}}', '{"row0":[]}'], ['{}', '[]'], ['{"0":"x"}', '["x"]'],
  ['{"row0":', '{"row0":'], ['{"row0":{}}', '{"row0":'],
  ['{"row0":{}}', null], ['null', 'null'], ['true', 'true'], ['1', '1'],
  ['{"value":9007199254740992}', '{"value":9007199254740993}'],
  ['{"value":9007199254740992}', '{"value":9007199254740992}'],
  ['{"value":9223372036854775808}', '{"value":9223372036854775809}'],
  ['{"value":1e400}', '{"value":1e400}'],
  ['{"value":9007199254740990.1}', '{"value":9007199254740990.2}'],
  ['{"value":1e-400}', '{"value":0}'],
  ['{"value":0.12345678901234567890}', '{"value":0.12345678901234567891}'],
  ['{"value":1.00000000000000001}', '{"value":1}'],
  ['{"value":9.0071992547409901e15}', '{"value":9007199254740990}'],
  ['{"value":1e-400}', '{"value":1e-400}'],
  [{ value: Number.NaN }, { value: null }], [{ value: undefined }, {}],
  [' '.repeat(1_048_577) + '{}', '{}'],
  ['['.repeat(65) + '0' + ']'.repeat(65), '['.repeat(65) + '0' + ']'.repeat(65)],
];

describe('bounded decoded subform JSON equality', () => {
  it.each(['a'.repeat(500_000), '"\\'.repeat(200_000)])('accepts bounded long quoted text %#', (text) => {
    const value = JSON.stringify({ row0: { text, numericText: '1e-400' } });
    expect(equalSubformJson(value, value)).toBe(true);
  });

  it.each(matches)('accepts formatting-only changes %#', (desired, observed) => {
    expect(equalSubformJson(desired, observed)).toBe(true);
    expect(compareSubformCustomField('content.articles.update', [field], 'modals', desired, observed)).toBe(true);
    expect(() => assertChangedFields({ data: { id: '41', attributes: { modals: observed } } },
      { modals: desired }, 'content.articles', [field])).not.toThrow();
  });

  it.each(differences)('rejects changed, malformed, unsafe or oversized JSON %#', (desired, observed) => {
    expect(equalSubformJson(desired, observed)).toBe(false);
    expect(compareSubformCustomField('content.articles.update', [field], 'modals', desired, observed)).toBe(false);
    expect(() => assertChangedFields({ data: { id: '41', attributes: { modals: observed } } },
      { modals: desired }, 'content.articles', [field])).toThrow(/modals/);
  });

  it('requires native action, context and subform metadata rather than guessing from text', () => {
    const desired = '{"row0": {}}';
    const observed = '{"row0":{}}';
    for (const metadata of [[], [{ ...field, type: 'text' }], [{ ...field, context: 'com_contact.contact' }]]) {
      expect(compareSubformCustomField('content.articles.update', metadata, 'modals', desired, observed)).toBeUndefined();
      expect(() => assertChangedFields({ data: { id: '41', attributes: { modals: observed } } },
        { modals: desired }, 'content.articles', metadata)).toThrow(/modals/);
    }
    expect(compareSubformCustomField('custom.articles.update', [field], 'modals', desired, observed)).toBeUndefined();
    expect(compareSubformCustomField('content.articles.update', [field, field], 'modals', desired, observed)).toBe(false);
  });

  it('checks every resolved category alias child through the same top-level or nested response', () => {
    const fields = [{ ...field, context: 'com_content.categories' }, { name: 'colour', type: 'text', context: 'com_content.categories' }];
    const desired = { com_fields: { modals: '{"row0": {"url": "https://askv.nl"}}', colour: 'Blue' } };
    const observed = { modals: '{"row0":{"url":"https:\\/\\/askv.nl"}}', colour: 'Blue' };
    for (const attributes of [observed, { com_fields: observed }]) {
      expect(() => assertChangedFields({ data: { id: '41', attributes } }, desired, 'content.categories', fields)).not.toThrow();
    }
    for (const attributes of [{ com_fields: { ...observed, colour: 'Red' } }, { com_fields: { modals: observed.modals } },
      { com_fields: { ...observed, modals: '{"row0":{}}' } }]) {
      expect(() => assertChangedFields({ data: { id: '41', attributes } }, desired, 'content.categories', fields)).toThrow();
    }
  });
});
