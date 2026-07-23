import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../src/config/schema.js';
import { JoomlaApiClient } from '../src/infrastructure/api/joomla-api-client.js';

const config: ApiConfig = {
  baseUrl: 'https://example.test',
  tokenEnv: 'TOKEN',
  token: 'secret',
  timeoutMs: 30_000,
  maxResponseBytes: 1_024,
  maxPageSize: 100,
};

describe('API route boundary fuzzing', () => {
  it.each([
    '../configuration.php',
    'v1/../../configuration.php',
    'https://attacker.test/v1/users',
    '//attacker.test/v1/users',
    'v1/content/articles?filter[search]=injected',
    'v1/content/articles#fragment',
    'v2/content/articles',
    'v1/content/articles\\..\\users',
    'v1/content/articles\nX-Injected: yes',
  ])('rejects non-catalogue-safe route %s', async (path) => {
    await expect(new JoomlaApiClient().get(config, path)).rejects.toThrow('invalid path');
  });
});
