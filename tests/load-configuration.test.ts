import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfiguration } from '../src/config/load.js';

const temporary: string[] = [];

afterEach(async () => {
  delete process.env['TEST_JOOMLA_TOKEN'];
  delete process.env['TEST_APPROVAL_SECRET'];
  await Promise.all(temporary.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe('loadConfiguration', () => {
  it('resolves secrets only from their named environment variables', async () => {
    process.env['TEST_JOOMLA_TOKEN'] = 'downstream-secret';
    process.env['TEST_APPROVAL_SECRET'] = 'a-secret-that-is-at-least-32-bytes-long';
    const file = await configurationFile();
    const configuration = await loadConfiguration(file);

    expect(configuration.sites.get('test')?.api?.token).toBe('downstream-secret');
    expect(configuration.approval?.secret).toBe('a-secret-that-is-at-least-32-bytes-long');
  });

  it('fails closed when the write approval secret is missing', async () => {
    process.env['TEST_JOOMLA_TOKEN'] = 'downstream-secret';
    const file = await configurationFile();

    await expect(loadConfiguration(file)).rejects.toThrow('at least 32 characters');
  });
});

async function configurationFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-config-'));
  temporary.push(directory);
  const file = join(directory, 'sites.json');
  await writeFile(
    file,
    JSON.stringify({
      defaultSite: 'test',
      approval: { secretEnv: 'TEST_APPROVAL_SECRET' },
      sites: {
        test: {
          toolsets: ['discovery'],
          api: { baseUrl: 'https://example.test', tokenEnv: 'TEST_JOOMLA_TOKEN' },
        },
      },
    }),
    'utf8',
  );
  return file;
}
