import { describe, expect, it } from 'vitest';

import { selectSafeConfiguration } from '../src/application/joomla-service.js';

describe('selectSafeConfiguration', () => {
  it('uses a strict allowlist and removes secrets', () => {
    const result = selectSafeConfiguration({
      data: {
        attributes: {
          sitename: 'Example',
          offline: false,
          password: 'database-secret',
          secret: 'site-secret',
          smtpPass: 'mail-secret',
        },
      },
    });

    expect(result).toEqual({ sitename: 'Example', offline: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
