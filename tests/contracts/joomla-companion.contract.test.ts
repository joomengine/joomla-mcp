import { describe, expect, it } from 'vitest';

import { joomlaCrudReadActions, joomlaCrudWriteActions } from '../../src/catalog/action-catalog.js';
import { companionActions, companionReadActions, companionStateActions } from '../../src/catalog/companion-actions.js';
import type { CliConfig } from '../../src/config/schema.js';
import { JoomlaCliClient } from '../../src/infrastructure/cli/joomla-cli-client.js';

const root = process.env['JOOMLA_CONTRACT_ROOT'];
const phpBinary = process.env['JOOMLA_CONTRACT_PHP_BINARY'];
const configured = root !== undefined && root.trim() !== '' && phpBinary !== undefined && phpBinary.trim() !== '';

describe.skipIf(!configured)('live Joomla companion contract', () => {
  const cli: CliConfig = {
    root: root as string,
    phpBinary: phpBinary as string,
    timeoutMs: 120_000,
    maxOutputBytes: 5_242_880,
  };
  const client = new JoomlaCliClient();

  it('advertises the complete edge-required CRUD and operational action set', async () => {
    const response = await client.describe(cli);
    const data = asRecord(response.data);
    const advertised = new Set(
      (Array.isArray(data['actions']) ? data['actions'] : [])
        .map(asRecord)
        .map((action) => action['name'])
        .filter((name): name is string => typeof name === 'string'),
    );
    const required = new Set([
      ...joomlaCrudReadActions.map((action) => action.id),
      ...joomlaCrudWriteActions.map((action) => action.id),
      ...companionActions.map((action) => action.id),
    ]);
    const missing = [...required].filter((action) => !advertised.has(action)).sort();

    expect(data['protocol']).toBe('joomla-mcp/1');
    expect(missing, `Missing companion actions:\n${missing.join('\n')}`).toEqual([]);
  });

  it('executes every safe list/status operation through native Joomla services', async () => {
    const actions = [
      ...joomlaCrudReadActions.filter((action) => action.operation === 'list').map((action) => action.id),
      ...companionReadActions
        .filter((action) => action.id !== 'content.articles.get')
        .map((action) => action.id),
    ];
    const failures: string[] = [];

    for (const action of [...new Set(actions)]) {
      const input = action === 'system.info' || action === 'configuration.get_safe' || action === 'core.update.status'
        ? {}
        : { offset: 0, limit: 1 };

      try {
        await client.dispatch(cli, action, input);
      } catch (error) {
        failures.push(`${action}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 300_000);

  it('advertises state operations as denied or allowed by the configured Joomla actor ACL', async () => {
    const response = await client.describe(cli);
    const actions = Array.isArray(asRecord(response.data)['actions']) ? asRecord(response.data)['actions'] : [];
    const descriptors = new Map(
      actions
        .map(asRecord)
        .filter((action) => typeof action['name'] === 'string')
        .map((action) => [action['name'] as string, action]),
    );

    for (const expected of companionStateActions) {
      const descriptor = descriptors.get(expected.id);
      expect(descriptor, expected.id).toBeDefined();
      expect(['boolean']).toContain(typeof asRecord(descriptor?.['effective'])['allowed']);
    }
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
