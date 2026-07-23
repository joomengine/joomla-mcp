import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../../src/config/schema.js';
import { JoomlaApiClient } from '../../src/infrastructure/api/joomla-api-client.js';
import { joomlaCrudBases } from '../../src/catalog/crud-bases.js';

const baseUrl = process.env['JOOMLA_CONTRACT_BASE_URL'];
const token = process.env['JOOMLA_CONTRACT_TOKEN'];
const configured =
  baseUrl !== undefined && baseUrl.trim() !== '' && token !== undefined && token.trim() !== '';

describe.skipIf(!configured)('live Joomla API contract', () => {
  const api: ApiConfig = {
    baseUrl: baseUrl as string,
    tokenEnv: 'JOOMLA_CONTRACT_TOKEN',
    token: token as string,
    timeoutMs: 30_000,
    maxResponseBytes: 5_242_880,
    maxPageSize: 20,
  };
  const client = new JoomlaApiClient();

  it('returns a JSON response for bounded article collection reads', async () => {
    const response = await client.get(api, 'v1/content/articles', {
      'page[offset]': 0,
      'page[limit]': 1,
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('json');
    expect(response.data).toBeTypeOf('object');
  });

  it('serves every source-registered CRUD collection with bounded pagination', async () => {
    const failures: string[] = [];

    for (const base of joomlaCrudBases) {
      try {
        const response = await client.get(api, base.basePath, {
          'page[offset]': 0,
          'page[limit]': 1,
        });

        if (response.status !== 200 || typeof response.data !== 'object' || response.data === null) {
          failures.push(`${base.id}: status=${response.status}, body=${typeof response.data}`);
        }
      } catch (error) {
        failures.push(`${base.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 120_000);

  it('returns the safe application configuration source document', async () => {
    const response = await client.get(api, 'v1/config/application');

    expect(response.status).toBe(200);
    expect(response.data).toBeTypeOf('object');
  });
});
