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

  it('combines Joomla application configuration collection resources', () => {
    const result = selectSafeConfiguration({
      data: [
        { id: '247', attributes: { sitename: 'Fixture site' } },
        { id: '247', attributes: { offline: false } },
        { id: '247', attributes: { password: 'database-secret' } },
      ],
    });

    expect(result).toEqual({ sitename: 'Fixture site', offline: false });
    expect(JSON.stringify(result)).not.toContain('database-secret');
  });
});
